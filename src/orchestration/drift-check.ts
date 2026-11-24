// Conferência pós-tarefa do Gemini no Windows ligada à delegação, ao cancelamento e à recuperação.
// Decisão do dono (2026-11-23, "Só avisa"): reporta, não falha a tarefa, não reverte nada.
// O marcador com o retrato "antes" é gravado antes do spawn; a comparação só fica completa com o fim do executor confirmado.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { duoDir } from "../paths.js";
import { writeJsonAtomic, type Store } from "../state/store.js";
import type { Task, TaskDrift } from "../state/types.js";
import { compareDrift, takeDriftSnapshot, type DriftApply, type DriftSnapshot } from "./drift.js";

export const DRIFT_MARKER = "drift-pending.json";
export const DRIFT_INCOMPLETE = "post-run check incomplete";
const driftLimitation = (n: number) => `checkout drift during the Gemini attempt (${n} paths)`;
type Marker = { attemptId: string; state: "pending"; startedAt: string; checkouts: string[]; configRoots: string[]; before: DriftSnapshot };

const F5_DOT = /^\.(gemini|codeium|antigravity|windsurf)/i;
const F5_APP = /antigravity|gemini|codeium|windsurf/i;

/**
 * Raízes de config reais do agy (F5), do ambiente original (antes do perfil privado): %USERPROFILE%\.gemini, as
 * pastas-ponto de agentes do perfil e as entradas de %APPDATA% e %LOCALAPPDATA% com nome de agente.
 * Pasta que não lista por outro motivo que ausência vira erro (o retrato fica incompleto, nunca limpo).
 */
export function geminiConfigRoots(env: NodeJS.ProcessEnv): { roots: string[]; errors: string[] } {
  const roots = new Set<string>(), errors: string[] = [];
  const list = (dir: string, re: RegExp) => {
    try { for (const n of readdirSync(dir)) if (re.test(n)) roots.add(join(dir, n)); }
    catch (error) { const c = (error as NodeJS.ErrnoException).code; if (c !== "ENOENT" && c !== "ENOTDIR") errors.push(`${dir}: ${c ?? (error as Error).message}`); }
  };
  if (env.USERPROFILE) { roots.add(join(env.USERPROFILE, ".gemini")); list(env.USERPROFILE, F5_DOT); }
  for (const dir of [env.APPDATA, env.LOCALAPPDATA]) if (dir) list(dir, F5_APP);
  return { roots: [...roots].sort(), errors };
}

/** Checkout principal e worktrees irmãs em .duo/worktrees (a desta tarefa fica de fora: é onde o Gemini escreve). */
export function driftCheckouts(projectRoot: string, ownWorktree: string | null): string[] {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const own = ownWorktree ? real(ownWorktree) : null;
  const dir = join(duoDir(projectRoot), "worktrees");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* sem worktrees */ }
  return [projectRoot, ...names.map((n) => join(dir, n)).filter((p) => existsSync(join(p, ".git")) && real(p) !== own)];
}

function snapshot(checkouts: string[], configRoots: string[], env: NodeJS.ProcessEnv): { snap: DriftSnapshot; roots: string[] } {
  const found = geminiConfigRoots(env);
  const roots = [...new Set([...configRoots, ...found.roots])].sort();
  const snap = takeDriftSnapshot({ checkouts, configRoots: roots });
  // descoberta de raízes que falhou: as que faltarem neste retrato não contam como criadas nem removidas
  if (found.errors.length) { snap.errors.push(...found.errors); snap.blind = true; }
  return { snap, roots };
}

/** Retrato "antes" gravado no marcador da tarefa, antes do spawn (uma retomada é uma tentativa nova, com marcador novo). */
export function startDrift(task: Task, projectRoot: string, env: NodeJS.ProcessEnv, attemptId: string): void {
  const checkouts = driftCheckouts(projectRoot, task.worktree);
  const { snap, roots } = snapshot(checkouts, [], env);
  const marker: Marker = { attemptId, state: "pending", startedAt: new Date().toISOString(), checkouts, configRoots: roots, before: snap };
  writeJsonAtomic(join(task.artifactsDir, DRIFT_MARKER), marker);
}

// dicionários do retrato sem protótipo também depois do JSON (`constructor` é nome de arquivo como outro)
const reviveDicts = (_k: string, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.assign(Object.create(null) as object, v) : v);

function setLimitations(task: Task, drift: TaskDrift): void {
  task.limitations = task.limitations.filter((l) => l !== DRIFT_INCOMPLETE && !l.startsWith("checkout drift during the Gemini attempt"));
  if (drift.changed.length) task.limitations.push(driftLimitation(drift.changed.length));
  if (drift.incomplete) task.limitations.push(DRIFT_INCOMPLETE);
}

function appliesInWindow(store: Store, task: Task, since: number, until: number): DriftApply[] {
  return store.listRuns().flatMap((r) => store.listTasks(r))
    .filter((t) => t.taskId !== task.taskId && t.applied && t.appliedAt && Date.parse(t.appliedAt) >= since && Date.parse(t.appliedAt) <= until)
    .map((t) => ({ taskId: t.taskId, root: store.projectRoot, files: t.verification?.filesChangedActual ?? [] }));
}

/**
 * Termina a conferência a partir do marcador. Executor vivo ou incerto: marca pendente (incompleta) e mantém o marcador.
 * Morto: compara, salva task.drift (atômico) e só então apaga o marcador. Um marcador cuja comparação já foi salva
 * (queda entre salvar e apagar) é só removido. Sem marcador: nada a fazer.
 */
export function finishDrift(store: Store, task: Task, env: NodeJS.ProcessEnv, opts: { executorAlive: boolean }): void {
  const path = join(task.artifactsDir, DRIFT_MARKER);
  let marker: Marker;
  try { marker = JSON.parse(readFileSync(path, "utf8"), reviveDicts) as Marker; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // marcador ilegível: sem retrato "antes", a conferência não tem como fechar limpa
    task.drift = { attemptId: task.drift?.attemptId ?? "unknown", status: "complete", changed: [], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: true };
    setLimitations(task, task.drift);
    store.saveTask(task);
    rmSync(path, { force: true });
    return;
  }
  if (task.drift?.status === "complete" && task.drift.attemptId === marker.attemptId) { rmSync(path, { force: true }); return; }
  if (opts.executorAlive) {
    task.drift = { attemptId: marker.attemptId, status: "pending", changed: [], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: true };
    setLimitations(task, task.drift);
    store.saveTask(task);
    return;
  }
  const { snap: after } = snapshot(marker.checkouts, marker.configRoots, env);
  const result = compareDrift(marker.before, after, appliesInWindow(store, task, Date.parse(marker.startedAt), Date.now()));
  task.drift = { attemptId: marker.attemptId, status: "complete", ...result };
  setLimitations(task, task.drift);
  store.saveTask(task);
  rmSync(path, { force: true });
}

export const hasDriftMarker = (task: Task) => !!task.artifactsDir && existsSync(join(task.artifactsDir, DRIFT_MARKER));

/** Última tarefa gemini com aviso da conferência (duo doctor). */
export function lastGeminiDrift(store: Store): { taskId: string; changed: number; incomplete: boolean; status: string } | null {
  const hit = store.listRuns().flatMap((r) => store.listTasks(r))
    .filter((t) => t.executor === "gemini" && t.drift && (t.drift.changed.length || t.drift.incomplete))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
  return hit?.drift ? { taskId: hit.taskId, changed: hit.drift.changed.length, incomplete: hit.drift.incomplete, status: hit.drift.status } : null;
}
