// Estado local em JSON/JSONL com escrita atômica (arquivo temporário + rename).
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { duoDir } from "../paths.js";
import { isPidAlive } from "../adapters/process.js";
import { redactDeep } from "../redact.js";
import type { Run, Task } from "./types.js";

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
    run.updatedAt = new Date().toISOString();
    writeJsonAtomic(join(this.runDir(run.runId), "run.json"), run);
  }
  loadRun(runId: string): Run | null {
    if (!/^run-[a-z0-9-]{6,64}$/.test(runId)) return null;
    return readJson<Run>(join(this.runDir(runId), "run.json"));
  }
  saveTask(task: Task): void {
    task.updatedAt = new Date().toISOString();
    writeJsonAtomic(join(this.taskDir(task.runId, task.taskId), "task.json"), redactDeep(task));
  }
  loadTask(runId: string, taskId: string): Task | null {
    return readJson<Task>(join(this.taskDir(runId, taskId), "task.json"));
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
    return run.taskIds.map((id) => this.loadTask(run.runId, id)).filter((t): t is Task => t !== null);
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
