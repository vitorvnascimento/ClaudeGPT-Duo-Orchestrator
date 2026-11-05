// Admissão cooperativa: o guard serializa a escolha do isolamento e a manutenção do espelho legado.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "../adapters/process.js";
import { duoDir } from "../paths.js";
import { linkWithRetry, readJson, removeWithRetry, renameWithRetry, withFileLock, writeJsonAtomic, writeJsonExclusive, type LockInfo } from "./store.js";
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

/**
 * Renova o espelho sem nunca sobrescrever um lock.json de outro dono: o atual é renomeado para um nome único
 * (rename é atômico), conferido e, se for de um duo antigo vivo, devolvido com link exclusivo. O espelho novo
 * nasce exclusivo; se um duo antigo pegar o lock nesse intervalo, ele vence e a função devolve false.
 */
function refreshMirror(root: string): boolean {
  const slots = activeSlots(root), path = join(duoDir(root), "lock.json");
  if (slots.some((s) => s.slot === -1)) return false;
  const current = readJson<LockInfo & { slots?: boolean }>(path);
  if (current?.slots === true && isPidAlive(current.pid) && slots[0]) {
    // Dono gravado vivo: duo antigo não mexe neste lock, então nunca se abre intervalo sem lock aqui.
    if (slots.some((s) => s.nonce === current.nonce)) return true;
    writeJsonAtomic(path, { ...slots[0], slots: true });
    return true;
  }
  // Daqui em diante o espelho está ausente, morto, ilegível ou legado: troca por rename e devolve o que não é nosso.
  const taken = `${path}.troca-${process.pid}-${randomBytes(6).toString("hex")}`;
  let had = false;
  try { renameWithRetry(path, taken); had = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (had) {
    const prev = readJson<LockInfo & { slots?: boolean }>(taken);
    const legacyLive = prev ? prev.slots !== true && isPidAlive(prev.pid) : mtimeAge(taken) <= 10_000;
    if (legacyLive) {
      try { linkWithRetry(taken, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      removeWithRetry(taken);
      return false;
    }
    removeWithRetry(taken);
  }
  if (!slots[0]) return true;
  try { writeJsonExclusive(path, { ...slots[0], slots: true }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
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
        if (s ? !isPidAlive(s.pid) : Date.now() - statSync(join(dir, name)).mtimeMs > 10_000) removeWithRetry(join(dir, name));
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
          removeWithRetry(path);
          return { ok: false, reason: "outro executor in-place está ativo (lock.json legado); aguarde ele terminar" };
        }
      } catch (error) { removeWithRetry(path); throw error; }
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
        if (this.intact()) removeWithRetry(own);
        refreshMirror(this.projectRoot);
      });
    } catch {
      // Guard ocupado ou falha de I/O: libera só a própria vaga; o espelho é corrigido na próxima admissão.
      try { if (this.intact()) removeWithRetry(own); } catch { /* vaga vira stale quando o processo sair */ }
    }
    this.own = null;
  }
}
