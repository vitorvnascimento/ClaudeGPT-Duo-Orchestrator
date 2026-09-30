// Estado local: Chain/Run versionados por CAS; auditorias em JSON/JSONL.
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
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

/**
 * Lock cooperativo de executor único por projeto. Não é barreira de segurança:
 * um processo com escrita em .duo/ pode removê-lo; por isso a ponte também confere o nonce ao final.
 */
export class ExecutorLock {
  readonly path: string;
  private nonce: string | null = null;
  constructor(projectRoot: string) {
    this.path = join(duoDir(projectRoot), "lock.json");
  }

  current(): LockInfo | null {
    return readJson<LockInfo>(this.path);
  }

  acquire(taskId: string, runId: string): { ok: true } | { ok: false; holder: LockInfo | null; stale: boolean } {
    mkdirSync(dirname(this.path), { recursive: true });
    const holder = this.current();
    if (holder && !isPidAlive(holder.pid)) {
      rmSync(this.path, { force: true });
    }
    const nonce = randomBytes(8).toString("hex");
    const info: LockInfo = { pid: process.pid, taskId, runId, nonce, startedAt: new Date().toISOString() };
    try {
      const fd = openSync(this.path, "wx", 0o600);
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
    } catch {
      const h = this.current();
      return { ok: false, holder: h, stale: h ? !isPidAlive(h.pid) : false };
    }
    this.nonce = nonce;
    return { ok: true };
  }

  /** true se o lock ainda é nosso (não foi removido ou trocado durante a execução). */
  intact(): boolean {
    return this.nonce !== null && this.current()?.nonce === this.nonce;
  }

  release(): void {
    if (this.intact()) rmSync(this.path, { force: true });
    this.nonce = null;
  }
}
