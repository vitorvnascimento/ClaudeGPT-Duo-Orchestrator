// Conferência pós-tarefa do Gemini no Windows ligada à delegação, ao cancelamento e à recuperação.
// Decisão do dono (2026-11-23, "Só avisa"): reporta, não falha a tarefa, não reverte nada; o apply pede --ack-drift.
// Falha fechado: task.drift nasce "pending" antes do spawn e só vira "complete" com o fim do executor confirmado.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "../adapters/process.js";
import { duoDir } from "../paths.js";
import { writeJsonAtomic, type Store } from "../state/store.js";
import type { Task, TaskDrift } from "../state/types.js";
import { compareDrift, takeDriftSnapshot, type DriftApply, type DriftSnapshot } from "./drift.js";

export const DRIFT_MARKER = "drift-pending.json";
export const DRIFT_INCOMPLETE = "post-run check incomplete";
const DRIFT_PREFIX = "checkout drift during the Gemini attempt";
export type DriftMarker = { attemptId: string; state: "pending"; startedAt: string; checkouts: string[]; configRoots: string[]; before: DriftSnapshot };

const F5_DOT = /^\.(gemini|codeium|antigravity|windsurf)/i;
const F5_APP = /antigravity|gemini|codeium|windsurf/i;
const errCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error as Error).message;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes(errCode(error));
const emptyDrift = (attemptId: string, status: TaskDrift["status"], incomplete: boolean): TaskDrift =>
  ({ attemptId, status, changed: [], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete });

/** PID do executor nunca registrado (a ponte caiu antes do onSpawn): pode estar vivo. */
export const executorMaybeAlive = (child: number | null) => child === null || isPidAlive(child);

/**
 * Raízes de config reais do agy (F5), do ambiente original (antes do perfil privado): %USERPROFILE%\.gemini, as
 * pastas-ponto de agentes do perfil e as entradas de %APPDATA% e %LOCALAPPDATA% com nome de agente.
 * Pasta que não lista por outro motivo que ausência vira erro (o retrato fica incompleto, nunca limpo).
 */
export function geminiConfigRoots(env: NodeJS.ProcessEnv): { roots: string[]; errors: string[] } {
  const roots = new Set<string>(), errors: string[] = [];
  const list = (dir: string, re: RegExp) => {
    try { for (const n of readdirSync(dir)) if (re.test(n)) roots.add(join(dir, n)); }
    catch (error) { if (!missing(error)) errors.push(`${dir}: ${errCode(error)}`); }
  };
  if (env.USERPROFILE) { roots.add(join(env.USERPROFILE, ".gemini")); list(env.USERPROFILE, F5_DOT); }
  for (const dir of [env.APPDATA, env.LOCALAPPDATA]) if (dir) list(dir, F5_APP);
  return { roots: [...roots].sort(), errors };
}

/** Checkout principal e worktrees irmãs em .duo/worktrees (a desta tarefa fica de fora: é onde o Gemini escreve). */
export function driftCheckouts(projectRoot: string, ownWorktree: string | null): { checkouts: string[]; errors: string[] } {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const own = ownWorktree ? real(ownWorktree) : null;
  const dir = join(duoDir(projectRoot), "worktrees");
  const checkouts = [projectRoot], errors: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch (error) { if (!missing(error)) errors.push(`${dir}: ${errCode(error)}`); }
  for (const n of names) {
    const p = join(dir, n);
    // .git inacessível não é ausência: entra como checkout, e a falha do git deixa o retrato incompleto
    try { lstatSync(join(p, ".git")); } catch (error) { if (missing(error)) continue; errors.push(`${p}: ${errCode(error)}`); }
    if (real(p) !== own) checkouts.push(p);
  }
  return { checkouts, errors };
}

function snapshot(checkouts: string[], configRoots: string[], env: NodeJS.ProcessEnv, extraErrors: string[] = []): { snap: DriftSnapshot; roots: string[] } {
  const found = geminiConfigRoots(env);
  const roots = [...new Set([...configRoots, ...found.roots])].sort();
  const snap = takeDriftSnapshot({ checkouts, configRoots: roots });
  snap.errors.push(...extraErrors);
  // descoberta de raízes que falhou: as que faltarem neste retrato não contam como criadas nem removidas
  if (found.errors.length) { snap.errors.push(...found.errors); snap.blind = true; }
  return { snap, roots };
}

const unresolved = (d: TaskDrift) => d.changed.length > 0 || d.incomplete || d.status !== "complete";

/** Todas as conferências da task ainda sem resolução (tentativa atual e retomadas anteriores) e marcador pendente. */
export function driftOutstanding(task: Task): { changed: string[]; incomplete: boolean } | null {
  const all = [...(task.driftHistory ?? []), ...(task.drift ? [task.drift] : [])].filter(unresolved);
  const marker = hasDriftMarker(task);
  if (!all.length && !marker) return null;
  return { changed: [...new Set(all.flatMap((d) => d.changed))].sort(), incomplete: marker || all.some((d) => d.incomplete || d.status !== "complete") };
}

function setLimitations(task: Task): void {
  task.limitations = task.limitations.filter((l) => l !== DRIFT_INCOMPLETE && !l.startsWith(DRIFT_PREFIX));
  const all = [...(task.driftHistory ?? []), ...(task.drift ? [task.drift] : [])];
  const changed = new Set(all.flatMap((d) => d.changed));
  if (changed.size) task.limitations.push(`${DRIFT_PREFIX} (${changed.size} paths)`);
  if (all.some((d) => d.incomplete)) task.limitations.push(DRIFT_INCOMPLETE);
}

/**
 * Retrato "antes" gravado no marcador antes do spawn, e task.drift pendente (falha fechado). Uma retomada é uma
 * tentativa nova: o aviso não resolvido da anterior vai para driftHistory, nunca some.
 */
export function startDrift(task: Task, projectRoot: string, env: NodeJS.ProcessEnv, attemptId: string): DriftMarker {
  const startedAt = new Date().toISOString(); // antes do primeiro retrato: a janela de applies cobre tudo o que for visto
  const found = driftCheckouts(projectRoot, task.worktree);
  const { snap, roots } = snapshot(found.checkouts, [], env, found.errors);
  const marker: DriftMarker = { attemptId, state: "pending", startedAt, checkouts: found.checkouts, configRoots: roots, before: snap };
  writeJsonAtomic(join(task.artifactsDir, DRIFT_MARKER), marker);
  if (task.drift && unresolved(task.drift)) task.driftHistory = [...(task.driftHistory ?? []), task.drift.status === "complete" ? task.drift : { ...task.drift, incomplete: true }];
  task.drift = emptyDrift(attemptId, "pending", true);
  return marker;
}

/** Tentativa que não chegou ao spawn (bloqueio depois do retrato): nenhum executor rodou nesta tentativa. */
export function abandonDrift(task: Task, attemptId: string): void {
  removeMarkerOf(task, attemptId);
  task.drift = emptyDrift(attemptId, "complete", false);
  setLimitations(task);
}

// dicionários do retrato sem protótipo também depois do JSON (`constructor` é nome de arquivo como outro)
const reviveDicts = (_k: string, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.assign(Object.create(null) as object, v) : v);

function readMarker(task: Task): DriftMarker {
  return JSON.parse(readFileSync(join(task.artifactsDir, DRIFT_MARKER), "utf8"), reviveDicts) as DriftMarker;
}

// só apaga o marcador da própria tentativa: uma retomada pode já ter gravado o da seguinte
function removeMarkerOf(task: Task, attemptId: string): void {
  try { if (readMarker(task).attemptId !== attemptId) return; } catch (error) { if (missing(error)) return; }
  rmSync(join(task.artifactsDir, DRIFT_MARKER), { force: true });
}

function appliesInWindow(store: Store, task: Task, since: number, until: number): DriftApply[] {
  return store.listRuns().flatMap((r) => store.listTasks(r))
    .filter((t) => t.taskId !== task.taskId && t.applied && t.appliedAt && Date.parse(t.appliedAt) >= since && Date.parse(t.appliedAt) <= until)
    .map((t) => ({ taskId: t.taskId, root: store.projectRoot, files: t.verification?.filesChangedActual ?? [] }));
}

/**
 * Termina a conferência. Executor vivo ou incerto: pendente e incompleta, marcador mantido. Morto: compara, salva
 * task.drift e só então apaga o marcador. A ponte passa o retrato "antes" que guardou em memória (o executor não o
 * alcança); recuperação e cancelamento leem o marcador e só salvam se a task ainda estiver na mesma tentativa.
 */
export function finishDrift(store: Store, task: Task, env: NodeJS.ProcessEnv, opts: { executorAlive: boolean; marker?: DriftMarker; recovery?: boolean }): void {
  const commit = (drift: TaskDrift, removeMarker: boolean) => {
    let target = task;
    if (opts.recovery) {
      const fresh = store.loadTask(task.runId, task.taskId);
      if (!fresh || (fresh.drift && fresh.drift.attemptId !== drift.attemptId)) return; // outra tentativa já assumiu
      target = fresh;
    }
    target.drift = drift;
    setLimitations(target);
    store.saveTask(target);
    if (target !== task) { task.drift = target.drift; task.limitations = target.limitations; task.driftHistory = target.driftHistory; }
    if (removeMarker) removeMarkerOf(task, drift.attemptId);
  };
  if (opts.recovery) {
    // a task pode ter mudado desde que o chamador a leu (retomada começou outra tentativa): só segue na mesma
    const fresh = store.loadTask(task.runId, task.taskId);
    if (!fresh || fresh.drift?.attemptId !== task.drift?.attemptId) return;
    if (fresh.pids.bridge && isPidAlive(fresh.pids.bridge) && fresh.state === "running") return; // a ponte ativa termina a dela
  }
  let marker = opts.marker ?? null;
  if (!marker) {
    try { marker = readMarker(task); }
    catch (error) {
      const attemptId = task.drift?.attemptId ?? "unknown";
      if (missing(error)) {
        // retrato esperado (task.drift pendente) e sumido: incompleta, nunca limpa
        if (task.drift?.status === "pending" && !opts.executorAlive) commit(emptyDrift(attemptId, "complete", true), false);
        return;
      }
      // JSON corrompido sem executor vivo fecha incompleta; leitura transitória (arquivo preso no Windows) espera
      if (error instanceof SyntaxError && !opts.executorAlive) { commit(emptyDrift(attemptId, "complete", true), false); rmSync(join(task.artifactsDir, DRIFT_MARKER), { force: true }); return; }
      commit(emptyDrift(attemptId, "pending", true), false);
      return;
    }
  }
  if (task.drift?.status === "complete" && task.drift.attemptId === marker.attemptId) { removeMarkerOf(task, marker.attemptId); return; }
  // marcador de outra tentativa que a registrada na task: não é desta conferência (fica, e o apply segue pedindo --ack-drift)
  if (opts.recovery && task.drift && task.drift.attemptId !== marker.attemptId) return;
  if (opts.executorAlive) { commit(emptyDrift(marker.attemptId, "pending", true), false); return; }
  // worktrees irmãs criadas durante a tentativa também entram no retrato "depois"
  const found = driftCheckouts(store.projectRoot, task.worktree);
  const checkouts = [...new Set([...marker.checkouts, ...found.checkouts])];
  const { snap: after } = snapshot(checkouts, marker.configRoots, env, found.errors);
  const result = compareDrift(marker.before, after, appliesInWindow(store, task, Date.parse(marker.startedAt), Date.now()));
  commit({ attemptId: marker.attemptId, status: "complete", ...result }, true);
}

/** Comparação que falhou na ponte: incompleta (o apply pede --ack-drift), nunca limpa. */
export function failDrift(task: Task, attemptId: string): void {
  task.drift = emptyDrift(attemptId, "complete", true);
  setLimitations(task);
}

export const hasDriftMarker = (task: Task) => !!task.artifactsDir && existsSync(join(task.artifactsDir, DRIFT_MARKER));

/** Última tarefa gemini com aviso da conferência (duo doctor), mesmo com o executor desligado ou ausente hoje. */
export function lastGeminiDrift(store: Store): { taskId: string; changed: number; incomplete: boolean } | null {
  const hit = store.listRuns().flatMap((r) => store.listTasks(r))
    .filter((t) => t.executor === "gemini" && driftOutstanding(t))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
  const d = hit && driftOutstanding(hit);
  return hit && d ? { taskId: hit.taskId, changed: d.changed.length, incomplete: d.incomplete } : null;
}
