// Estado local: Chain/Run versionados por CAS; auditorias em JSON/JSONL.
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { duoDir } from "../paths.js";
import { isPidAlive } from "../adapters/process.js";
import { redactDeep } from "../redact.js";
import { chainStatus, maxEffort, maxTier } from "../orchestration/chain.js";
import { assessComplexity } from "../orchestration/complexity.js";
import type { Chain, DelegationRequest, Run, Task } from "./types.js";
import type { Tier } from "../adapters/tiers.js";

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try { renameWithRetry(tmp, path); }
  catch (e) { try { unlinkSync(tmp); } catch { /* já removido */ } throw e; }
}

// No Windows, rename sobre um arquivo aberto por outro processo (leitor do duo, antivírus, indexador) falha com
// EPERM/EACCES/EBUSY por alguns milissegundos. Tenta de novo por até ~2 s; nos outros sistemas, falha na hora.
// Nunca apaga a origem ao falhar: ela pode ser um lock vivo de outro processo (o espelho lock.json, por exemplo).
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + attempt * 5);
    }
  }
}

/** linkSync com o mesmo retry no Windows; EEXIST (disputa legítima) sai na hora. */
export function linkWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { linkSync(from, to); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + attempt * 5);
    }
  }
}

/** rmSync com o mesmo retry do rename no Windows (arquivo preso por leitor, antivírus ou indexador por alguns ms). */
export function removeWithRetry(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try { rmSync(path, { force: true }); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + attempt * 5);
    }
  }
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Publica um registro completo sem substituir um dono concorrente (EEXIST). */
export function writeJsonExclusive(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeExclusive(tmp, `${JSON.stringify(value)}\n`);
    linkWithRetry(tmp, path);
  } finally { try { removeWithRetry(tmp); } catch { /* temporário órfão: ignorado pelos leitores */ } }
}

function staleLock(path: string): string | null {
  // Stat e leitura pelo mesmo fd: o guard observado é um só (sem chave `ino-` de um guard válido que sumiu no meio).
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    let holder: { pid?: unknown; nonce?: unknown } | null = null;
    // Só conteúdo inválido conta como ilegível; erro de leitura (EIO etc.) sobe: não conhecer o dono não prova que morreu.
    const text = readFileSync(fd, "utf8");
    try { holder = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; holder = null; }
    if (holder && Number.isInteger(holder.pid) && (holder.pid as number) > 0 && typeof holder.nonce === "string" && /^[a-zA-Z0-9-]+$/.test(holder.nonce)) {
      return isPidAlive(holder.pid as number) ? null : holder.nonce;
    }
    return Date.now() - stat.mtimeMs > 10_000 ? `ino-${stat.ino}-${Math.trunc(stat.mtimeMs)}` : null;
  } finally { closeSync(fd); }
}

/** Marcadores deste processo cuja recuperação falhou (só esses podem ser pulados; uma em andamento nunca). */
const failedMarkers = new Set<string>();

/**
 * Recupera o guard morto da geração `stale` (nonce do dono morto, ou `ino-N` de guard ilegível velho).
 * Cada geração tem uma cadeia de marcadores que nunca são apagados: o nível n+1 só é criado quando o dono
 * do nível n morreu. Assim há no máximo um recuperador vivo por geração, e só ele confere e apaga o guard;
 * como o dono do guard morreu e nenhum outro recuperador vivo pode mexer nele, conferir e apagar não tem corrida.
 * Um marcador sobra por guard recuperado (só após um crash); são pequenos e nenhum leitor os conta.
 */
export function reclaimStale(path: string, stale: string): void {
  // Sem teto de níveis: cada nível pulado já existe (finitos) e cada chamada cria no máximo um, então termina,
  // e uma geração nunca fica abandonada depois de muitas falhas.
  for (let level = 0; ; level++) {
    const marker = level ? `${path}.reclaim-${stale}.${level}` : `${path}.reclaim-${stale}`;
    const nonce = randomBytes(16).toString("hex");
    try { writeJsonExclusive(marker, { pid: process.pid, nonce }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readJson<{ pid: number; nonce?: string }>(marker);
      // Marcador de uma tentativa anterior deste processo que falhou (ex.: EPERM no Windows): esta chamada é síncrona
      // e não está dentro dela, então segue de nível como se o dono tivesse morrido, em vez de travar o lock.
      if (owner?.pid === process.pid && typeof owner.nonce === "string" && failedMarkers.has(owner.nonce)) continue;
      // Dono vivo (mesmo pausado) ou marcador ilegível: espera; só um dono morto abre o próximo nível.
      if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || isPidAlive(owner.pid)) return;
      continue;
    }
    try { if (staleLock(path) === stale) removeWithRetry(path); }
    catch (error) { failedMarkers.add(nonce); throw error; }
    return;
  }
}

/** Guard curto entre processos; apenas um recuperador vivo pode apagar cada geração morta. */
export function withFileLock<T>(path: string, timeoutMs: number, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const nonce = randomBytes(16).toString("hex");
  let reclaimError: Error | null = null;
  for (;;) {
    try { writeJsonExclusive(path, { pid: process.pid, nonce }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Falha transitória ao recuperar (ex.: EPERM no Windows) tenta de novo no próximo ciclo, até o prazo.
      try { const stale = staleLock(path); if (stale) reclaimStale(path, stale); }
      catch (error) { reclaimError = error as Error; }
      if (Date.now() >= deadline) throw new Error(`tempo esgotado aguardando lock: ${path}${reclaimError ? ` (última falha ao recuperar: ${reclaimError.message})` : ""}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    try { return fn(); }
    finally {
      if (readJson<{ nonce: string }>(path)?.nonce === nonce) removeWithRetry(path);
    }
  }
}

/** Leitura, alteração e publicação protegidas pelo mesmo guard, sem perder entradas concorrentes. */
export function updateJsonLocked<T>(path: string, change: (value: T | null) => T): T {
  return withFileLock(`${path}.lock`, 2000, () => {
    const value = change(readJson<T>(path));
    writeJsonAtomic(path, value);
    return value;
  });
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(redactDeep(value))}\n`, { mode: 0o600 });
}

export function newId(prefix: "run" | "task"): string {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${prefix}-${ts}-${randomBytes(3).toString("hex")}`;
}

// Registros versionados (Chain e Run), sem lock e sem poda: cada escrita publica <registro>.d/<rev>.json por
// link() de um temporário completo e sincronizado. link é atômico e nunca sobrescreve: o nome da revisão é a
// reserva (compare-and-swap) e o arquivo só aparece inteiro. Revisões nunca são apagadas, então nenhum escritor
// atrasado reutiliza um número e nenhum leitor perde a revisão que está lendo. Cada registro tem poucas revisões
// (uma por mudança de uma cadeia/run), e o limite abaixo é só uma trava contra laço.
const revisionsDir = (path: string) => path.replace(/\.json$/, ".d");
const revisionName = (rev: number) => String(rev).padStart(12, "0");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const pause = new Int32Array(new SharedArrayBuffer(4));
const MAX_REVISIONS = 100_000;

function writeExclusive(path: string, data: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** Barreira de durabilidade da entrada de diretório criada pelo link (POSIX). O Windows não abre diretórios
 * para fsync; lá vale a garantia do NTFS. */
function syncDir(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function headRevision(path: string): number {
  let names: string[];
  try { names = readdirSync(revisionsDir(path)); }
  catch (error) { if (errorCode(error) === "ENOENT") return 0; throw error; }
  let head = 0;
  for (const name of names) if (/^\d{12}\.json$/.test(name)) head = Math.max(head, Number(name.slice(0, 12)));
  return head;
}

/** Revisões nunca são apagadas: qualquer falha ao ler a revisão mais nova (inclusive sumir) é erro, nunca recuo. */
function readRevision<T extends { rev?: number }>(path: string, rev: number): T {
  const file = join(revisionsDir(path), `${revisionName(rev)}.json`);
  const value = JSON.parse(readFileSync(file, "utf8")) as T;
  if (!value || typeof value !== "object" || value.rev !== rev) throw new Error(`revisão de estado inconsistente: ${file}`);
  return value;
}

function readLegacy<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
}

function readAt<T extends { rev?: number }>(path: string, head: number): T | null {
  if (head) return readRevision<T>(path, head);
  const legacy = readLegacy<T>(path);
  return legacy ? { ...legacy, rev: 0 } : null;
}

export function readVersioned<T extends { rev?: number }>(path: string): T | null {
  return readAt<T>(path, headRevision(path));
}

/** CAS sem lock. O callback pode ser repetido: síncrono, puro e sem I/O. */
export function updateVersioned<T extends { rev?: number }>(path: string, change: (value: T | null) => T): T {
  const dir = revisionsDir(path);
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    const head = headRevision(path), rev = head + 1;
    if (rev > MAX_REVISIONS) throw new Error(`limite de revisões de estado: ${path}`);
    const current = readAt<T>(path, head);
    const value = change(current && structuredClone(current));
    value.rev = rev;
    const target = join(dir, `${revisionName(rev)}.json`);
    const tmp = join(dir, `.${revisionName(rev)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeExclusive(tmp, `${JSON.stringify(value, null, 2)}\n`);
      try { linkSync(tmp, target); }
      catch (error) {
        const code = errorCode(error);
        if (code === "EEXIST") {
          // Outro escritor publicou esta revisão: relê e repete. Jitter evita colisões em sincronia.
          Atomics.wait(pause, 0, 0, 1 + randomBytes(1)[0]! % Math.min(5 + attempt * 2, 40));
          continue;
        }
        if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
          throw new Error(`o sistema de arquivos de ${dir} não suporta hard links (link: ${code}); o duo precisa deles para gravar estado com segurança. Use um disco local (APFS, ext4, NTFS).`);
        }
        throw error;
      }
      syncDir(dir);
      return value;
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* temporário ignorado pelos leitores */ }
    }
  }
  throw new Error(`conflito de estado após 50 tentativas de CAS: ${path}`);
}

export class Store {
  readonly base: string;
  constructor(readonly projectRoot: string) {
    this.base = duoDir(projectRoot);
  }

  runDir(runId: string): string {
    return join(this.base, "runs", runId);
  }
  taskDir(runId: string, taskId: string): string {
    return join(this.runDir(runId), "tasks", taskId);
  }

  saveRun(run: Run): void {
    this.updateRun(run.runId, (fresh) => { Object.assign(fresh, run); }, run);
  }
  updateRun(runId: string, change: (run: Run) => void, initial?: Run): Run {
    const path = join(this.runDir(runId), "run.json"), now = new Date().toISOString();
    return updateVersioned<Run>(path, (saved) => {
      const run = saved ?? (initial && structuredClone(initial));
      if (!run) throw new Error(`run ausente: ${runId}`);
      const { taskIds, cancelled, invocations, decisions } = structuredClone(run);
      change(run);
      run.taskIds = [...new Set([...taskIds, ...run.taskIds])];
      run.cancelled ||= cancelled;
      run.invocations = Math.max(invocations, run.invocations);
      run.decisions = [...decisions, ...run.decisions.filter((d) => !decisions.some((old) => JSON.stringify(old) === JSON.stringify(d)))];
      run.updatedAt = now;
      return run;
    });
  }
  loadRun(runId: string): Run | null {
    if (!/^run-[a-z0-9-]{6,64}$/.test(runId)) return null;
    return readVersioned<Run>(join(this.runDir(runId), "run.json"));
  }
  saveTask(task: Task): void {
    task.updatedAt = new Date().toISOString();
    writeJsonAtomic(join(this.taskDir(task.runId, task.taskId), "task.json"), redactDeep(task));
    const chain = this.loadChain(task.runId, task.selection?.chainId ?? task.taskId);
    if (!chain) return;
    this.updateChain(task.runId, chain.chainId, (fresh) => {
      const attempt = fresh.attempts.find((a) => a.taskId === task.taskId);
      if (attempt) {
        attempt.invocations = Math.max(attempt.invocations ?? 0, task.invocations);
        attempt.state = task.state;
        // Tentativa que ainda não invocou pode trocar de fornecedor na retomada: o registro acompanha a task,
        // para que cooldown de capacidade e cota continuem casando com o fornecedor real.
        attempt.executor = task.executor;
        attempt.model = task.model.requested;
        attempt.effort = maxEffort(task.effort?.requested);
        attempt.tier = task.selection?.tier ?? attempt.tier;
      }
      if (!fresh.owner && fresh.latestTaskId === task.taskId) fresh.status = chainStatus(task.state);
    });
  }
  loadTask(runId: string, taskId: string): Task | null {
    const task = readJson<Task>(join(this.taskDir(runId, taskId), "task.json"));
    if (task) this.chainForTask(task);
    return task;
  }
  chainPath(runId: string, chainId: string): string {
    if (!/^run-[a-z0-9-]{6,64}$/.test(runId) || !/^task-[a-z0-9-]{6,64}$/.test(chainId)) throw new Error("identificador de Chain inválido");
    return join(this.runDir(runId), "chains", `${chainId}.json`);
  }
  loadChain(runId: string, chainId: string): Chain | null {
    const chain = readVersioned<Chain>(this.chainPath(runId, chainId));
    for (const attempt of chain?.attempts ?? []) {
      const audited = readJson<Task>(join(this.taskDir(runId, attempt.taskId), "task.json"))?.invocations;
      attempt.invocations = Math.max(attempt.invocations ?? audited ?? 1, audited ?? 0);
    }
    return chain;
  }
  /** Migração de leitura: não reescreve a auditoria de tasks antigas. */
  chainForTask(task: Task, initial?: { request: DelegationRequest; floor: Tier }): Chain {
    const chainId = task.selection?.chainId ?? task.taskId;
    const path = this.chainPath(task.runId, chainId);
    const saved = this.loadChain(task.runId, chainId);
    if (saved) {
      if (saved.status !== "running" || saved.owner && isPidAlive(saved.owner.pid)) return saved;
      const latest = readJson<Task>(join(this.taskDir(saved.runId, saved.latestTaskId), "task.json"));
      if (!latest) return saved;
      return this.updateChain(saved.runId, chainId, (fresh) => {
        // Se outro recuperador publicou uma reserva, o CAS repete sem removê-la.
        if (fresh.owner?.nonce !== saved.owner?.nonce || fresh.owner?.pid !== saved.owner?.pid || fresh.latestTaskId !== saved.latestTaskId || fresh.status !== "running") return;
        const attempt = fresh.attempts.find((a) => a.taskId === latest.taskId);
        if (attempt) { attempt.state = latest.state; attempt.invocations = Math.max(attempt.invocations ?? 0, latest.invocations); }
        fresh.status = latest.state === "running" ? "blocked" : chainStatus(latest.state);
        fresh.owner = null;
      });
    }
    if (chainId !== task.taskId) throw new Error(`Chain ausente: ${chainId}`);
    const requestPath = join(this.taskDir(task.runId, task.taskId), "request.json");
    const request = initial?.request ?? readJson<DelegationRequest>(requestPath);
    const floor = initial?.floor ?? assessComplexity({ kind: task.kind, risk: task.risk, acceptance: { criteria: task.acceptanceCriteria ?? [], commands: task.acceptanceCommands ?? [] } }, (task.scope ?? []).map((rel) => ({ rel, isDir: false })), task.tags ?? []).floor;
    const tier = task.selection?.tier ?? floor;
    const chain: Chain = { version: 1, chainId, runId: task.runId, taskKey: task.taskKey ?? null, requestHash: task.requestHash ?? "",
      originalRequestPath: requestPath, floorTier: floor, minTier: maxTier(floor, tier), minEffort: maxEffort(task.effort?.requested),
      origin: { model: request?.model ? "explicit" : "auto", effort: request?.effort ? "explicit" : "auto" },
      attempts: [{ taskId: task.taskId, attempt: 1, executor: task.executor, model: task.model.requested, effort: maxEffort(task.effort?.requested), tier, reason: "initial", state: task.state, invocations: task.invocations }],
      status: chainStatus(task.state), latestTaskId: task.taskId, updatedAt: new Date().toISOString(),
      owner: task.state === "running" && task.pids?.bridge ? { pid: task.pids.bridge, nonce: "legacy", since: task.updatedAt } : null };
    return updateVersioned<Chain>(path, (fresh) => fresh ?? structuredClone(chain));
  }
  updateChain(runId: string, chainId: string, change: (chain: Chain) => void): Chain {
    const path = this.chainPath(runId, chainId), now = new Date().toISOString();
    const invocations = new Map(this.loadChain(runId, chainId)?.attempts.map((a) => [a.taskId, a.invocations!]));
    return updateVersioned<Chain>(path, (chain) => {
      if (!chain) throw new Error(`Chain ausente: ${chainId}`);
      for (const attempt of chain.attempts) attempt.invocations = Math.max(attempt.invocations ?? invocations.get(attempt.taskId) ?? 1, invocations.get(attempt.taskId) ?? 0);
      const { minTier, minEffort, floorTier, attempts, status } = structuredClone(chain);
      change(chain);
      chain.attempts = [...attempts.map((old) => {
        const updated = chain.attempts.find((a) => a.taskId === old.taskId);
        return updated ? { ...updated, invocations: Math.max(old.invocations ?? 0, updated.invocations ?? 0) } : old;
      }), ...chain.attempts.filter((a) => !attempts.some((old) => old.taskId === a.taskId))];
      chain.floorTier = floorTier;
      chain.minTier = maxTier(floorTier, minTier, chain.minTier, ...chain.attempts.map((a) => a.tier));
      chain.minEffort = maxEffort(minEffort, chain.minEffort, ...chain.attempts.map((a) => a.effort));
      if (status === "cancelled") chain.status = "cancelled";
      chain.updatedAt = now;
      return chain;
    });
  }
  listChains(runId: string): Chain[] {
    const run = this.loadRun(runId);
    if (run) this.listTasks(run); // cria somente Chains implícitas ausentes
    const dir = join(this.runDir(runId), "chains");
    return existsSync(dir) ? [...new Set(readdirSync(dir).filter((f) => /^task-[a-z0-9-]{6,64}\.(json|d)$/.test(f)).map((f) => f.replace(/\.(json|d)$/, "")))].map((id) => this.loadChain(runId, id)).filter((c): c is Chain => c !== null) : [];
  }
  findTask(taskId: string): Task | null {
    if (!/^task-[a-z0-9-]{6,64}$/.test(taskId)) return null;
    for (const run of this.listRuns()) {
      const t = this.loadTask(run.runId, taskId);
      if (t) return t;
    }
    return null;
  }
  listRuns(): Run[] {
    const dir = join(this.base, "runs");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((id) => this.loadRun(id))
      .filter((r): r is Run => r !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  listTasks(run: Run): Task[] {
    // Toda tentativa registrada numa Chain do run conta, mesmo que a gravação no run tenha sido interrompida:
    // cancelamento e status nunca podem perder de vista uma tentativa que pode executar.
    const ids = new Set((this.loadRun(run.runId) ?? run).taskIds);
    const dir = join(this.runDir(run.runId), "chains");
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const m = /^(task-[a-z0-9-]{6,64})\.(?:json|d)$/.exec(name);
        const chain = m ? readVersioned<Chain>(join(dir, `${m[1]}.json`)) : null;
        for (const a of chain?.attempts ?? []) ids.add(a.taskId);
      }
    }
    return [...ids].map((id) => this.loadTask(run.runId, id)).filter((t): t is Task => t !== null);
  }
  telemetry(event: Record<string, unknown>): void {
    appendJsonl(join(this.base, "telemetry.jsonl"), { at: new Date().toISOString(), ...event });
  }
  readTelemetry(): Record<string, unknown>[] {
    const p = join(this.base, "telemetry.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }
}

export type LockInfo = { pid: number; taskId: string; runId: string; nonce: string; startedAt: string };
