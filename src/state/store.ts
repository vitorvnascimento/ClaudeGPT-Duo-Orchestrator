// Estado local em JSON/JSONL com escrita atômica (arquivo temporário + rename).
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
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

/** O_EXCL + expiração; callbacks síncronos, sem executar CLI ou aguardar I/O externo. */
export function withRecordLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`, nonce = randomBytes(16).toString("hex");
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readJson<{ pid: number; nonce: string }>(lock);
      try {
        const stale = owner ? !isPidAlive(owner.pid) : Date.now() - statSync(lock).mtimeMs > 10 * 60 * 1000;
        if (stale && readJson<{ nonce: string }>(lock)?.nonce === owner?.nonce) { rmSync(lock, { force: true }); continue; }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (Date.now() >= deadline) throw new Error(`timeout no lock de estado: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    try { writeSync(fd, JSON.stringify({ pid: process.pid, nonce })); }
    finally { closeSync(fd); }
    try { return fn(); }
    finally { if (readJson<{ nonce: string }>(lock)?.nonce === nonce) rmSync(lock, { force: true }); }
  }
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
    const path = join(this.runDir(run.runId), "run.json");
    withRecordLock(path, () => {
      run.updatedAt = new Date().toISOString();
      writeJsonAtomic(path, run);
    });
  }
  updateRun(runId: string, change: (run: Run) => void, initial?: Run): Run {
    const path = join(this.runDir(runId), "run.json");
    return withRecordLock(path, () => {
      const run = this.loadRun(runId) ?? initial;
      if (!run) throw new Error(`run ausente: ${runId}`);
      change(run);
      run.updatedAt = new Date().toISOString();
      writeJsonAtomic(path, run);
      return run;
    });
  }
  loadRun(runId: string): Run | null {
    if (!/^run-[a-z0-9-]{6,64}$/.test(runId)) return null;
    return readJson<Run>(join(this.runDir(runId), "run.json"));
  }
  saveTask(task: Task): void {
    task.updatedAt = new Date().toISOString();
    const save = () => writeJsonAtomic(join(this.taskDir(task.runId, task.taskId), "task.json"), redactDeep(task));
    const chain = this.loadChain(task.runId, task.selection?.chainId ?? task.taskId);
    if (!chain) { save(); return; }
    this.updateChain(task.runId, chain.chainId, (fresh) => {
      save();
      const attempt = fresh.attempts.find((a) => a.taskId === task.taskId);
      if (attempt) {
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
    return readJson<Chain>(this.chainPath(runId, chainId));
  }
  /** Migração de leitura: uma task antiga vira uma Chain unitária sem reescrever sua auditoria. */
  chainForTask(task: Task, initial?: { request: DelegationRequest; floor: Tier }): Chain {
    const chainId = task.selection?.chainId ?? task.taskId;
    const path = this.chainPath(task.runId, chainId);
    return withRecordLock(path, () => {
      const saved = this.loadChain(task.runId, chainId);
      if (saved) {
        if (saved.status === "running" && (!saved.owner || !isPidAlive(saved.owner.pid))) {
          const latest = readJson<Task>(join(this.taskDir(saved.runId, saved.latestTaskId), "task.json"));
          if (latest) {
            const attempt = saved.attempts.find((a) => a.taskId === latest.taskId);
            if (attempt) attempt.state = latest.state;
            saved.status = latest.state === "running" ? "blocked" : chainStatus(latest.state);
            saved.owner = null;
            saved.updatedAt = new Date().toISOString();
            writeJsonAtomic(path, saved);
          }
        }
        return saved;
      }
      if (chainId !== task.taskId) throw new Error(`Chain ausente: ${chainId}`);
      const requestPath = join(this.taskDir(task.runId, task.taskId), "request.json");
      const request = initial?.request ?? readJson<DelegationRequest>(requestPath);
      const floor = initial?.floor ?? assessComplexity({ kind: task.kind, risk: task.risk, acceptance: { criteria: task.acceptanceCriteria ?? [], commands: task.acceptanceCommands ?? [] } }, (task.scope ?? []).map((rel) => ({ rel, isDir: false })), task.tags ?? []).floor;
      const tier = task.selection?.tier ?? floor;
      const chain: Chain = { version: 1, chainId, runId: task.runId, taskKey: task.taskKey ?? null, requestHash: task.requestHash ?? "",
        originalRequestPath: requestPath, floorTier: floor, minTier: maxTier(floor, tier), minEffort: maxEffort(task.effort?.requested),
        origin: { model: request?.model ? "explicit" : "auto", effort: request?.effort ? "explicit" : "auto" },
        attempts: [{ taskId: task.taskId, attempt: 1, executor: task.executor, model: task.model.requested, effort: maxEffort(task.effort?.requested), tier, reason: "initial", state: task.state }],
        status: chainStatus(task.state), latestTaskId: task.taskId, updatedAt: new Date().toISOString(),
        owner: task.state === "running" && task.pids?.bridge ? { pid: task.pids.bridge, nonce: "legacy" } : null };
      writeJsonAtomic(path, chain);
      return chain;
    });
  }
  updateChain(runId: string, chainId: string, change: (chain: Chain) => void): Chain {
    const path = this.chainPath(runId, chainId);
    return withRecordLock(path, () => {
      const chain = this.loadChain(runId, chainId);
      if (!chain) throw new Error(`Chain ausente: ${chainId}`);
      const { minTier, minEffort, floorTier } = chain;
      change(chain);
      chain.floorTier = floorTier;
      chain.minTier = maxTier(floorTier, minTier, chain.minTier, ...chain.attempts.map((a) => a.tier));
      chain.minEffort = maxEffort(minEffort, chain.minEffort, ...chain.attempts.map((a) => a.effort));
      chain.updatedAt = new Date().toISOString();
      writeJsonAtomic(path, chain);
      return chain;
    });
  }
  listChains(runId: string): Chain[] {
    const run = this.loadRun(runId);
    if (run) this.listTasks(run); // cria somente Chains implícitas ausentes
    const dir = join(this.runDir(runId), "chains");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => this.loadChain(runId, f.slice(0, -5))).filter((c): c is Chain => c !== null) : [];
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
