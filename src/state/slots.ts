// Admissão cooperativa: o guard serializa a escolha do isolamento e a manutenção do espelho legado.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "../adapters/process.js";
import { duoDir } from "../paths.js";
import { readJson, withFileLock, writeJsonAtomic, writeJsonExclusive, type LockInfo } from "./store.js";
import type { TaskKind } from "./types.js";

export type Isolation = "in-place" | "worktree";
export type SlotInfo = LockInfo & { slot: number; isolation: Isolation; kind: TaskKind };
export type AdmitRequest = { taskId: string; runId: string; kind: TaskKind; requested: Isolation; fixed: Isolation | null; gitReady: boolean };
export type AdmitResult = { ok: true; isolation: Isolation; forced: boolean } | { ok: false; reason: string };
const locksDir = (root: string) => join(duoDir(root), "locks");

export function withAdmission<T>(projectRoot: string, fn: () => T): T {
  return withFileLock(join(locksDir(projectRoot), "admission.lock"), 5000, fn);
}

export function activeSlots(projectRoot: string): SlotInfo[] {
  const dir = locksDir(projectRoot);
  const slots = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((name) => /^slot-\d+\.json$/.test(name))
    .flatMap((name) => {
      const s = readJson<SlotInfo>(join(dir, name));
      return s && isPidAlive(s.pid) ? [s] : [];
    });
  const legacy = readJson<LockInfo & { slots?: boolean }>(join(duoDir(projectRoot), "lock.json"));
  if (legacy && !legacy.slots && isPidAlive(legacy.pid)) slots.push({ ...legacy, slot: -1, isolation: "in-place", kind: "implement" });
  return slots.sort((a, b) => a.slot - b.slot);
}

function mtimeAge(path: string): number {
  try { return Date.now() - statSync(path).mtimeMs; } catch { return 0; }
}

function refreshMirror(root: string): boolean {
  const slots = activeSlots(root), path = join(duoDir(root), "lock.json");
  if (slots.some((s) => s.slot === -1)) return false;
  const mirror = readJson<LockInfo & { slots?: boolean }>(path);
  if (!slots[0]) {
    if (mirror?.slots === true) rmSync(path, { force: true });
    return true;
  }
  const next = { ...slots[0], slots: true };
  if (mirror?.slots === true) { writeJsonAtomic(path, next); return true; }
  try { writeJsonExclusive(path, next); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = readJson<LockInfo & { slots?: boolean }>(path);
    if (holder?.slots === true && isPidAlive(holder.pid)) { writeJsonAtomic(path, next); return true; }
    const abandoned = holder ? !isPidAlive(holder.pid) : mtimeAge(path) > 10_000;
    if (!abandoned) return false;
    rmSync(path, { force: true });
    try { writeJsonExclusive(path, next); return true; }
    catch (retry) { if ((retry as NodeJS.ErrnoException).code === "EEXIST") return false; throw retry; }
  }
}

export class ExecutorSlots {
  private own: SlotInfo | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly projectRoot: string, private readonly max: number) {}

  admit(req: AdmitRequest): AdmitResult {
    return withAdmission(this.projectRoot, () => {
      const dir = locksDir(this.projectRoot);
      for (const name of readdirSync(dir).filter((n) => /^slot-\d+\.json$/.test(n))) {
        const s = readJson<SlotInfo>(join(dir, name));
        if (s ? !isPidAlive(s.pid) : Date.now() - statSync(join(dir, name)).mtimeMs > 10_000) rmSync(join(dir, name), { force: true });
      }
      const slots = activeSlots(this.projectRoot), holders = slots.map((s) => `${s.taskId}, pid ${s.pid}`).join("; ");
      if (slots.some((s) => s.isolation === "in-place")) return { ok: false, reason: `outro executor in-place está ativo (${holders}); aguarde ele terminar` };
      if (slots.length >= this.max) return { ok: false, reason: `limite de ${this.max} executores simultâneos atingido (${holders})` };
      if (req.fixed === "in-place" && slots.length) return { ok: false, reason: `cadeia fixa in-place requer o projeto livre (${holders}); aguarde os executores terminarem` };
      const isolation = (req.fixed ?? req.requested) === "in-place" && !slots.length ? "in-place" : "worktree";
      if (isolation === "worktree" && !req.gitReady) return { ok: false, reason: "execução paralela requer um repositório git com ao menos um commit" };
      const slot = Array.from({ length: this.max }, (_, i) => i).find((i) => !existsSync(join(dir, `slot-${i}.json`)));
      if (slot === undefined) return { ok: false, reason: "slots indisponíveis: registro de executor inválido; verifique .duo/locks/" };
      const info: SlotInfo = { slot, pid: process.pid, taskId: req.taskId, runId: req.runId, nonce: randomBytes(16).toString("hex"), startedAt: new Date().toISOString(), isolation, kind: req.kind };
      const path = join(dir, `slot-${slot}.json`);
      writeJsonExclusive(path, info);
      try {
        if (!refreshMirror(this.projectRoot)) {
          rmSync(path, { force: true });
          return { ok: false, reason: "outro executor in-place está ativo (lock.json legado); aguarde ele terminar" };
        }
      } catch (error) { rmSync(path, { force: true }); throw error; }
      this.own = info;
      this.timer = setInterval(() => {
        try { withAdmission(this.projectRoot, () => { if (this.intact()) refreshMirror(this.projectRoot); }); }
        catch { /* guard ocupado: a próxima manutenção tenta novamente */ }
      }, 5000);
      this.timer.unref();
      return { ok: true, isolation, forced: isolation === "worktree" && req.requested === "in-place" };
    });
  }

  intact(): boolean {
    return this.own !== null && readJson<SlotInfo>(join(locksDir(this.projectRoot), `slot-${this.own.slot}.json`))?.nonce === this.own.nonce;
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.own) return;
    const own = join(locksDir(this.projectRoot), `slot-${this.own.slot}.json`);
    try {
      withAdmission(this.projectRoot, () => {
        if (this.intact()) rmSync(own, { force: true });
        refreshMirror(this.projectRoot);
      });
    } catch {
      // Guard ocupado ou falha de I/O: libera só a própria vaga; o espelho é corrigido na próxima admissão.
      try { if (this.intact()) rmSync(own, { force: true }); } catch { /* vaga vira stale quando o processo sair */ }
    }
    this.own = null;
  }
}
