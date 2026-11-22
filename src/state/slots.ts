// Admissão cooperativa: o guard serializa a escolha do isolamento e a manutenção do espelho legado.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isPidAlive } from "../adapters/process.js";
import { duoDir } from "../paths.js";
import { processStartTime, startedAfterReservation } from "./process-identity.js";
import { linkWithRetry, readJson, removeWithRetry, renameWithRetry, withFileLock, writeJsonAtomic, writeJsonExclusive, type LockInfo } from "./store.js";
import type { TaskKind } from "./types.js";

export type Isolation = "in-place" | "worktree";
type SlotPhase = "reserved" | "spawning" | "running";
export type SlotInfo = LockInfo & {
  slot: number;
  isolation: Isolation;
  kind: TaskKind;
  exclusive?: boolean;
  childPid?: number | null;
  /** New lifecycle fields are optional so v0.4.0 slot records remain readable. */
  phase?: SlotPhase;
  spawnStartedAt?: string;
  spawnCommand?: string;
  spawnCwd?: string;
};
export type AdmitRequest = { taskId: string; runId: string; kind: TaskKind; requested: Isolation; fixed: Isolation | null; gitReady: boolean; exclusive?: boolean };
export type AdmitResult = { ok: true; isolation: Isolation; forced: boolean } | { ok: false; reason: string };
type CodexProcessProbeResult = { ok: true; pids: number[] } | { ok: false; reason: string };
const locksDir = (root: string) => join(duoDir(root), "locks");

const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
const taskIdPattern = /^task-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const runIdPattern = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const taskKinds: readonly TaskKind[] = ["implement", "review", "test", "investigate", "asset"];
const slotPhases: readonly SlotPhase[] = ["reserved", "spawning", "running"];
const safeExecutable = /^[^/\\\x00-\x1f]{1,255}$/;

function validIso(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function executableBasename(command: string): string {
  return basename(command.replaceAll("\\", "/"));
}

function isWellFormedSlot(value: unknown): value is SlotInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const slot = value as Partial<SlotInfo>;
  const base = Number.isSafeInteger(slot.slot) && (slot.slot as number) >= 0 &&
    validPid(slot.pid) && typeof slot.taskId === "string" && safeIdentifier.test(slot.taskId) &&
    typeof slot.runId === "string" && safeIdentifier.test(slot.runId) &&
    typeof slot.nonce === "string" && slot.nonce.length > 0 && typeof slot.startedAt === "string" &&
    slot.startedAt.length > 0 && Number.isFinite(Date.parse(slot.startedAt)) &&
    (slot.isolation === "in-place" || slot.isolation === "worktree") && taskKinds.includes(slot.kind as TaskKind) &&
    (slot.childPid === undefined || slot.childPid === null || validPid(slot.childPid)) &&
    (slot.exclusive === undefined || typeof slot.exclusive === "boolean");
  if (!base) return false;
  // phase is absent on legacy records. A new record must satisfy the fields for its phase.
  if (slot.phase === undefined) return true;
  if (!slotPhases.includes(slot.phase)) return false;
  if (slot.phase === "reserved") return slot.childPid === undefined || slot.childPid === null;
  if (slot.phase === "spawning") {
    return (slot.childPid === undefined || slot.childPid === null) && validIso(slot.spawnStartedAt) &&
      (slot.spawnCommand === undefined || (typeof slot.spawnCommand === "string" && safeExecutable.test(slot.spawnCommand))) &&
      (slot.spawnCwd === undefined || (typeof slot.spawnCwd === "string" && isAbsolute(slot.spawnCwd)));
  }
  return validPid(slot.childPid);
}

/** A malformed slot is visible as an exclusive holder until its existing stale-file window expires. */
function malformedSlot(slot: number): SlotInfo {
  const safeSlot = Number.isSafeInteger(slot) && slot >= 0 ? slot : 0;
  const suffix = String(safeSlot).padStart(6, "0");
  return { slot: safeSlot, pid: -1, taskId: `task-malformed-${suffix}`, runId: `run-malformed-${suffix}`, nonce: `malformed-${suffix}`, startedAt: "", isolation: "worktree", kind: "implement", exclusive: true, childPid: null };
}

// Unknown and inaccessible are active: neither proves that the bridge or child exited.
function pidState(pid: number): "alive" | "dead" | "unknown" {
  try { process.kill(pid, 0); return "alive"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

function bridgeGone(slot: SlotInfo): boolean {
  if (!validPid(slot.pid)) return false;
  const state = pidState(slot.pid);
  if (state === "dead") return true;
  if (state === "unknown") return false;
  return typeof slot.startedAt === "string" && startedAfterReservation(slot.startedAt, processStartTime(slot.pid));
}

// A ponte pode morrer antes do executor. Uma auditoria ausente ou inconsistente não prova que ele terminou;
// a auditoria correspondente com child=null é a exceção explícita de recuperação legada.
function childState(root: string, slot: SlotInfo): "stopped" | "active" | "unknown" {
  if (typeof slot.runId !== "string" || !runIdPattern.test(slot.runId) ||
      typeof slot.taskId !== "string" || !taskIdPattern.test(slot.taskId)) return "unknown";
  const task = readJson<{ runId?: unknown; taskId?: unknown; state?: unknown; pids?: { bridge?: unknown; child?: unknown } }>(
    join(duoDir(root), "runs", slot.runId, "tasks", slot.taskId, "task.json"),
  );
  if (!task || task.runId !== slot.runId || task.taskId !== slot.taskId || task.pids?.bridge !== slot.pid ||
      !["planned", "approved", "running", "blocked", "succeeded", "failed", "cancelled"].includes(task.state as string)) return "unknown";
  const child = task.pids.child;
  if (child === null) return "stopped";
  if (!validPid(child)) return "unknown";
  const state = pidState(child);
  return state === "dead" ? "stopped" : state === "alive" ? "active" : "unknown";
}

/** New slots publish childPid atomically; older slots fall back to their task audit. */
function registeredChildState(root: string, slot: SlotInfo): "stopped" | "active" | "unknown" {
  if (Object.prototype.hasOwnProperty.call(slot, "childPid")) {
    if (slot.childPid === null) return "stopped";
    if (!validPid(slot.childPid)) return "unknown";
    const state = pidState(slot.childPid);
    return state === "dead" ? "stopped" : state === "alive" ? "active" : "unknown";
  }
  return childState(root, slot);
}

function pendingSpawn(slot: SlotInfo): boolean {
  // The previous wire format published a null PID both before and during spawn.
  return slot.phase === "spawning" || (slot.exclusive === true && slot.phase === undefined && slot.childPid === null);
}

function slotActive(root: string, slot: SlotInfo): boolean {
  if (!isWellFormedSlot(slot)) return true;
  // A spawn hand-off is deliberately not auto-recovered: the bridge may have
  // died after spawning Codex but before its onSpawn callback persisted childPid.
  if (pendingSpawn(slot)) return true;
  if (slot.phase === "reserved") return !bridgeGone(slot);
  if (slot.exclusive !== true) {
    const child = registeredChildState(root, slot);
    return isPidAlive(slot.pid) || child === "active" || (Object.prototype.hasOwnProperty.call(slot, "childPid") && child === "unknown");
  }
  return !bridgeGone(slot) || registeredChildState(root, slot) !== "stopped";
}

export function withAdmission<T>(projectRoot: string, fn: () => T): T {
  return withFileLock(join(locksDir(projectRoot), "admission.lock"), 5000, fn);
}

export function activeSlots(projectRoot: string): SlotInfo[] {
  const dir = locksDir(projectRoot);
  const slots = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((name) => /^slot-\d+\.json$/.test(name))
    .flatMap((name) => {
      const fileSlot = Number(name.slice(5, -5));
      const s = readSlot(join(dir, name));
      const slot = isWellFormedSlot(s) && s.slot === fileSlot ? s : malformedSlot(fileSlot);
      return slotActive(projectRoot, slot) ? [slot] : [];
    });
  const legacy = readJson<LockInfo & { slots?: boolean }>(join(duoDir(projectRoot), "lock.json"));
  if (legacy && !legacy.slots && validPid(legacy.pid) && isPidAlive(legacy.pid)) slots.push({ ...legacy, slot: -1, isolation: "in-place", kind: "implement" });
  return slots.sort((a, b) => a.slot - b.slot);
}

/**
 * Lê um slot tolerando BOM. JSON inválido vira null. Erro de leitura: null, ou lança com `strict`
 * (a recuperação precisa distinguir "ilegível agora" de "malformado").
 */
function readSlot(path: string, strict = false): unknown {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if (strict) throw error; return null; }
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
}

/** Use complete argv for wrappers and paths with spaces, then check cwd for the remaining candidates. */
export function inspectCodexProcesses(slot: SlotInfo): CodexProcessProbeResult {
  const unknown = { ok: false as const, reason: "tabela de processos ou cwd não verificável" };
  if (!slot.spawnCommand || !slot.spawnCwd || process.platform === "win32") return unknown;
  const options = { encoding: "utf8" as const, timeout: 2000, maxBuffer: 4 * 1024 * 1024 };
  const ps = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,comm=,args="], options);
  if (ps.error || ps.status !== 0 || !ps.stdout.trim()) return unknown;

  const candidates = new Set<number>();
  const markers = [slot.taskId, slot.runId, slot.spawnCwd];
  const escaped = slot.spawnCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const executable = new RegExp(`(?:^|[/\\s])(?:${escaped}|codex(?:\\.[cm]?js)?)(?=\\s|$)`);
  for (const line of ps.stdout.trimEnd().split("\n")) {
    const row = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (row && Number(row[1]) === 0) continue; // kernel_task
    if (!row || !validPid(Number(row[1]))) return unknown;
    const pid = Number(row[1]);
    if (pid === process.pid) continue;
    // Marcador da task (taskId, runId, worktree no --cd) prova o executor qualquer que seja o binário configurado.
    if (markers.some(marker => row[2]!.includes(marker))) return { ok: true, pids: [pid] };
    if (executable.test(row[2]!)) candidates.add(pid);
  }
  if (!candidates.size) return { ok: true, pids: [] };
  // One bounded probe for all PIDs keeps recovery inside the admission lock timeout.
  const lsof = spawnSync(process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
    ["-a", "-p", [...candidates].join(","), "-d", "cwd", "-Fpn"], options);
  if (lsof.error || lsof.status !== 0) return unknown;
  let pid = 0;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!candidates.has(pid) || !line.startsWith("n/")) continue;
    if (resolve(line.slice(1)) === slot.spawnCwd) return { ok: true, pids: [pid] };
    candidates.delete(pid);
  }
  return candidates.size ? unknown : { ok: true, pids: [] };
}

/** Called under the admission lock, including the subsequent decision to admit or apply. */
export function recoverSlotsLocked(root: string): SlotInfo[] {
  const dir = locksDir(root);
  let removed = false;
  for (const name of readdirSync(dir).filter(name => /^slot-\d+\.json$/.test(name))) {
    const path = join(dir, name);
    let slot: unknown;
    try { slot = readSlot(path, true); }
    catch { continue; } // sumiu, ou erro de leitura (permissão, E/S): não prova que o dono acabou, o slot continua bloqueando
    const valid = isWellFormedSlot(slot) && slot.slot === Number(name.slice(5, -5));
    if (valid ? slotActive(root, slot as SlotInfo) : mtimeAge(path) <= 10_000) continue;
    removeWithRetry(path);
    removed = true;
  }
  if (removed) refreshMirror(root);
  return activeSlots(root);
}

/** Para o doctor: recupera sob o lock quando possível; sem escrita (checkout só leitura, sandbox), só inspeciona. */
export function inspectSlots(root: string): SlotInfo[] {
  if (!existsSync(locksDir(root))) return activeSlots(root);
  try { return withAdmission(root, () => recoverSlotsLocked(root)); }
  catch { return activeSlots(root); }
}

/** Recuperação manual exige auditoria; spawning exige prova independente do processo Codex. */
export function releaseOrphanSlot(
  projectRoot: string,
  nonce: string,
  confirmed: boolean,
): { ok: boolean; message: string } {
  return withAdmission(projectRoot, () => {
    const dir = locksDir(projectRoot);
    const matches = readdirSync(dir).filter((name) => /^slot-\d+\.json$/.test(name))
      .map((name) => ({ path: join(dir, name), fileSlot: Number(name.slice(5, -5)), slot: readSlot(join(dir, name)) as SlotInfo | null }))
      .filter(({ fileSlot, slot }) => isWellFormedSlot(slot) && slot.slot === fileSlot && (slot.exclusive === true || pendingSpawn(slot)) && slot.nonce === nonce);
    const slot = matches[0]?.slot;
    if (!slot && confirmed && activeSlots(projectRoot).some(entry => entry.pid === -1 && entry.nonce === nonce)) {
      const active = recoverSlotsLocked(projectRoot);
      return active.some(entry => entry.nonce === nonce)
        ? { ok: false, message: "registro malformado recente; aguarde a janela de dez segundos" }
        : { ok: true, message: "registro malformado expirado removido" };
    }
    if (!nonce || matches.length !== 1 || !slot) return { ok: false, message: "nonce não identifica uma única reserva exclusiva; consulte duo doctor --json" };
    const path = matches[0]!.path;
    if (!confirmed) return { ok: false, message: "verifique que o executor e seus descendentes terminaram; só então use --confirm-executor-stopped" };
    if (!bridgeGone(slot)) return { ok: false, message: "saída da ponte não confirmada; reserva preservada" };
    if (pendingSpawn(slot)) {
      // Older slots lack the launch metadata. Their Codex invocation used the task worktree; the probe checks the
      // task markers (taskId, runId, worktree) on every process, whatever the configured binary is called.
      const launch = slot.phase ? slot : { ...slot, spawnCommand: "codex", spawnCwd: join(duoDir(projectRoot), "worktrees", slot.taskId) };
      let inspected: CodexProcessProbeResult;
      try { inspected = inspectCodexProcesses(launch); }
      catch { return { ok: false, message: "não foi possível confirmar a ausência do Codex; reserva preservada" }; }
      if (!inspected.ok) return { ok: false, message: `${inspected.reason}; reserva preservada` };
      if (inspected.pids.length) return { ok: false, message: "há processo Codex da worktree/run ainda ativo; reserva preservada" };
      removeWithRetry(path);
      refreshMirror(projectRoot);
      return { ok: true, message: `reserva spawning ${nonce} liberada após confirmação de nenhum Codex vivo; nenhum processo foi encerrado` };
    }
    const child = registeredChildState(projectRoot, slot);
    if (child !== "stopped") return { ok: false, message: child === "active" ? "filho auditado ainda ativo; reserva preservada" : "auditoria ou saída do filho não confirmada; reserva preservada" };
    removeWithRetry(path);
    refreshMirror(projectRoot);
    return { ok: true, message: `reserva exclusiva ${nonce} liberada por confirmação explícita; nenhum processo foi encerrado` };
  });
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
  if (current?.slots === true && validPid(current.pid) && isPidAlive(current.pid) && slots[0]) {
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
    const legacyLive = prev ? prev.slots !== true && validPid(prev.pid) && isPidAlive(prev.pid) : mtimeAge(taken) <= 10_000;
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

  admit(req: AdmitRequest, beforePublish?: () => void): AdmitResult {
    return withAdmission(this.projectRoot, () => {
      const dir = locksDir(this.projectRoot);
      const slots = recoverSlotsLocked(this.projectRoot), holders = slots.map((s) => `${s.taskId}, pid ${s.pid}`).join("; ");
      if (slots.some((s) => s.exclusive)) return { ok: false, reason: `outro executor exclusivo está ativo (${holders}); aguarde ele terminar` };
      if (req.exclusive && slots.length) return { ok: false, reason: `executor exclusivo requer o projeto livre (${holders}); aguarde os executores terminarem` };
      if (slots.some((s) => s.isolation === "in-place")) return { ok: false, reason: `outro executor in-place está ativo (${holders}); aguarde ele terminar` };
      if (slots.length >= this.max) return { ok: false, reason: `limite de ${this.max} executores simultâneos atingido (${holders})` };
      if (req.fixed === "in-place" && slots.length) return { ok: false, reason: `cadeia fixa in-place requer o projeto livre (${holders}); aguarde os executores terminarem` };
      const isolation = (req.fixed ?? req.requested) === "in-place" && !slots.length ? "in-place" : "worktree";
      if (isolation === "worktree" && !req.gitReady) return { ok: false, reason: "execução paralela requer um repositório git com ao menos um commit" };
      const slot = Array.from({ length: this.max }, (_, i) => i).find((i) => !existsSync(join(dir, `slot-${i}.json`)));
      if (slot === undefined) return { ok: false, reason: "slots indisponíveis: registro de executor inválido; verifique .duo/locks/" };
      // Exclusive computer-use slots keep the old wire marker so v0.4.0 clients also treat them as in-place.
      // The returned isolation remains the actual worktree choice used by the current delegate.
      const info: SlotInfo = { slot, pid: process.pid, taskId: req.taskId, runId: req.runId, nonce: randomBytes(16).toString("hex"), startedAt: new Date().toISOString(), isolation: req.exclusive ? "in-place" : isolation, kind: req.kind, phase: "reserved", childPid: null, ...(req.exclusive ? { exclusive: true } : {}) };
      const path = join(dir, `slot-${slot}.json`);
      // Limpa a reserva anterior antes de substituir a identidade da ponte numa retomada.
      beforePublish?.();
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

  /** Persist the hand-off marker before invoking the external executor. argv is intentionally not retained. */
  markSpawning(spec: { command: string; cwd: string }): void {
    const command = executableBasename(spec.command);
    const spawnCwd = spec.cwd;
    if (!safeExecutable.test(command) || !isAbsolute(spawnCwd)) throw new Error("comando ou cwd do spawn inválido");
    withAdmission(this.projectRoot, () => {
      if (!this.own) throw new Error("slot sem dono local");
      const path = join(locksDir(this.projectRoot), `slot-${this.own.slot}.json`);
      const current = readJson<SlotInfo>(path);
      if (!current || current.nonce !== this.own.nonce) throw new Error("slot do executor foi removido ou trocado antes do spawn");
      const updated: SlotInfo = { ...current, phase: "spawning", spawnStartedAt: new Date().toISOString(), spawnCommand: command, spawnCwd, childPid: null };
      writeJsonAtomic(path, updated);
      this.own = updated;
    });
  }

  /** Publishes the child PID in this slot atomically while its nonce is still owned. */
  registerChildPid(pid: number): void {
    if (!validPid(pid)) throw new Error("PID do filho inválido");
    withAdmission(this.projectRoot, () => {
      if (!this.own) throw new Error("slot sem dono local");
      const path = join(locksDir(this.projectRoot), `slot-${this.own.slot}.json`);
      const current = readJson<SlotInfo>(path);
      if (!current || current.nonce !== this.own.nonce) throw new Error("slot do executor foi removido ou trocado antes de registrar o filho");
      const updated: SlotInfo = { ...current, phase: "running", childPid: pid };
      writeJsonAtomic(path, updated);
      this.own = updated;
    });
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
