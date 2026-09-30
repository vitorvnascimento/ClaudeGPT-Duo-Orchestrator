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

const revisionsDir = (path: string) => path.replace(/\.json$/, ".d");
const revisionName = (rev: number) => String(rev).padStart(12, "0");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const pause = new Int32Array(new SharedArrayBuffer(4));

function reservations(path: string): number[] {
  // ponytail: varredura O(histórico); indexar se diretórios grandes virarem gargalo.
  try { return [...new Set(readdirSync(revisionsDir(path)).filter((f) => /^\d{12}\.(cas|json)$/.test(f)).map((f) => Number(f.slice(0, 12))))].sort((a, b) => b - a); }
  catch (error) { if (errorCode(error) === "ENOENT") return []; throw error; }
}

function writeExclusive(path: string, data = ""): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** wx expõe o arquivo antes do fim da escrita. A decisão imutável arbitra
 * publicação versus aborto sem aceitar um escritor ultrapassado. */
function settleWx(base: string, outcome: "commit" | "abort"): boolean {
  const decision = `${base}.wx.d`;
  if (!existsSync(decision)) {
    const tmp = `${base}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    mkdirSync(tmp);
    try {
      writeExclusive(join(tmp, outcome));
      // Diretório não vazio nunca é sobrescrito por rename, também no Windows.
      try { renameSync(tmp, decision); }
      catch (error) { if (!existsSync(decision)) throw error; }
    } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* decisão já publicada */ } }
  }
  return existsSync(join(decision, "commit"));
}

function readRevisions<T extends { rev?: number }>(path: string, revisions: number[]): T | null {
  for (const rev of revisions) {
    const base = join(revisionsDir(path), revisionName(rev));
    if (existsSync(`${base}.wx`) && !existsSync(join(`${base}.wx.d`, "commit"))) continue;
    const value = readJson<T>(`${base}.json`);
    if (value && typeof value === "object" && value.rev === rev) return value;
  }
  const legacy = readJson<T>(path);
  return legacy ? { ...legacy, rev: 0 } : null;
}

export function readVersioned<T extends { rev?: number }>(path: string): T | null {
  return readRevisions<T>(path, reservations(path));
}

/** CAS sem lock. O callback pode ser repetido: síncrono, puro e sem I/O. */
export function updateVersioned<T extends { rev?: number }>(path: string, change: (value: T | null) => T): T {
  const dir = revisionsDir(path);
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    const revisions = reservations(path), head = revisions[0] ?? 0;
    if (head) {
      const base = join(dir, revisionName(head));
      // Revisões JSON sem metadados auxiliares também são entradas legíveis.
      try { writeExclusive(`${base}.cas`); }
      catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      // Selar o destino também impede publicação tardia após pular uma marca.
      // Esses arquivos vazios são abortos permanentes, não snapshots podáveis.
      if (existsSync(`${base}.wx`)) settleWx(base, "abort");
      else {
        try { writeExclusive(`${base}.json`); }
        catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
        if (existsSync(`${base}.wx`)) settleWx(base, "abort");
      }
    }
    const current = readRevisions<T>(path, revisions), rev = head + 1;
    const value = change(current && structuredClone(current));
    if (rev > 999999999999) throw new Error(`limite de revisões de estado: ${path}`);
    value.rev = rev;
    const name = revisionName(rev), base = join(dir, name), target = `${base}.json`;
    const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    const data = `${JSON.stringify(value, null, 2)}\n`;
    try {
      writeExclusive(tmp, data);
      writeExclusive(`${base}.cas`);
      try { linkSync(tmp, target); }
      catch (error) {
        if (!["EPERM", "ENOTSUP"].includes(errorCode(error) ?? "")) throw error;
        writeExclusive(`${base}.wx`);
        writeExclusive(target, data);
        if (!settleWx(base, "commit")) throw Object.assign(new Error("revisão abortada"), { code: "EEXIST" });
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      // Jitter evita recuperadores abortarem uns aos outros em sincronia.
      Atomics.wait(pause, 0, 0, 1 + randomBytes(1)[0]! % Math.min(5 + attempt * 2, 40));
      continue;
    } finally { try { rmSync(tmp, { force: true }); } catch { /* tmp ignorado pelos leitores */ } }
    for (const old of revisions.filter((r) => r < rev - 20)) {
      const snapshot = join(dir, `${revisionName(old)}.json`);
      if (readJson<{ rev?: number }>(snapshot)?.rev !== old) continue;
      try { rmSync(snapshot); } catch { /* poda não invalida o commit */ }
    }
    return value;
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
    return (this.loadRun(run.runId) ?? run).taskIds.map((id) => this.loadTask(run.runId, id)).filter((t): t is Task => t !== null);
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
