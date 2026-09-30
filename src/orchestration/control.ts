// Comandos de controle determinísticos: cancelamento, integração de worktree, decisões e detecção de interrupção.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive, killPidTree } from "../adapters/process.js";
import { loadConfig } from "../config.js";
import { git, hashPath, headCommit } from "../git.js";
import { inScope, validateScope } from "../permissions/scope.js";
import { canTransition, isTerminal, transition } from "../state/machine.js";
import { Store } from "../state/store.js";
import type { Task } from "../state/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Marca como blocked as tasks "running" cujo processo da ponte morreu. Não mata processos. */
export function refreshInterrupted(store: Store): { taskId: string; orphanChild: number | null }[] {
  const found: { taskId: string; orphanChild: number | null }[] = [];
  for (const run of store.listRuns()) {
    for (const task of store.listTasks(run)) {
      if (task.state !== "running") continue;
      if (task.pids.bridge && isPidAlive(task.pids.bridge)) continue;
      const orphan = task.pids.child && isPidAlive(task.pids.child) ? task.pids.child : null;
      transition(task, "blocked", `interrompida: o processo da ponte não está mais ativo${orphan ? ` (executor órfão ainda ativo, pid ${orphan}; use duo cancel)` : ""}`);
      store.saveTask(task);
      const chain = store.chainForTask(task);
      store.updateChain(run.runId, chain.chainId, (fresh) => {
        if (fresh.latestTaskId === task.taskId && (!fresh.owner || !isPidAlive(fresh.owner.pid))) {
          fresh.status = "blocked";
          fresh.owner = null;
        }
      });
      found.push({ taskId: task.taskId, orphanChild: orphan });
    }
  }
  return found;
}

export async function cancelRun(projectRoot: string, runId: string, graceMs = 10_000): Promise<{ ok: boolean; message: string; cancelled: string[] }> {
  const store = new Store(projectRoot);
  const run = store.loadRun(runId);
  if (!run) return { ok: false, message: `run não encontrado: ${runId}`, cancelled: [] };
  store.updateRun(runId, (fresh) => { fresh.cancelled = true; fresh.nextStep = "run cancelado pelo usuário"; });
  for (const chain of store.listChains(runId)) {
    store.updateChain(runId, chain.chainId, (fresh) => {
      if (fresh.status === "running" || fresh.status === "blocked") fresh.status = "cancelled";
    });
  }

  // 1) pede à ponte ativa que encerre o executor e registre o checkpoint.
  for (const task of store.listTasks(run)) {
    if (task.state === "running" && task.pids.bridge && isPidAlive(task.pids.bridge) && process.platform !== "win32") {
      try {
        process.kill(task.pids.bridge, "SIGTERM");
      } catch {
        /* já terminou */
      }
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && store.listTasks(run).some((t) => t.state === "running" && t.pids.bridge && isPidAlive(t.pids.bridge))) {
    await sleep(200);
  }
  // 2) se não saiu (ou no Windows), encerra a árvore do executor e a ponte à força.
  const cancelled: string[] = [];
  for (const task of store.listTasks(run)) {
    if (task.pids.child && isPidAlive(task.pids.child)) killPidTree(task.pids.child, "SIGKILL");
    if (task.state === "running" && task.pids.bridge && isPidAlive(task.pids.bridge)) killPidTree(task.pids.bridge, "SIGKILL");
    const fresh = store.loadTask(run.runId, task.taskId) as Task;
    if (!isTerminal(fresh.state) && canTransition(fresh.state, "cancelled")) {
      transition(fresh, "cancelled", "cancelado pelo usuário (duo cancel)");
      fresh.pids.child = null;
      store.saveTask(fresh);
    }
    if (fresh.state === "cancelled") cancelled.push(fresh.taskId);
  }
  store.telemetry({ event: "run_cancelled", runId, tasks: cancelled });
  return { ok: true, message: `run ${runId} cancelado`, cancelled };
}

/** Integra o patch de um worktree somente se a base não mudou. Nunca força nem descarta mudanças do usuário. */
export function applyTask(projectRoot: string, taskId: string): { ok: boolean; message: string } {
  const store = new Store(projectRoot);
  const task = store.findTask(taskId);
  if (!task) return { ok: false, message: `task não encontrada: ${taskId}` };
  if (!task.worktree) return { ok: false, message: "task in-place: as mudanças já estão no working tree; não há patch a aplicar" };
  if (task.state !== "succeeded") return { ok: false, message: `só tasks succeeded podem ser integradas (estado: ${task.state})` };
  if (task.applied) return { ok: true, message: "patch já aplicado anteriormente; nada a fazer" };
  const patch = task.verification?.patchPath;
  if (!patch || !existsSync(patch)) return { ok: false, message: "patch da task não encontrado" };

  const head = headCommit(projectRoot);
  if (head !== task.base?.head) return { ok: false, message: `base desatualizada: HEAD atual ${head?.slice(0, 12)} ≠ base ${task.base?.head?.slice(0, 12)}. Rejeitado; refaça a tarefa sobre a base atual.` };
  const cfg = loadConfig(projectRoot);
  const scope = validateScope(projectRoot, task.scope, cfg.scope.deny, { allowWholeProject: false });
  if (!scope.ok) return { ok: false, message: `escopo inválido na integração: ${scope.errors.join("; ")}` };
  const drift: string[] = [];
  for (const [rel, h] of Object.entries(task.base?.hashes ?? {})) {
    if (!inScope(rel, scope.entries)) continue;
    if (hashPath(join(projectRoot, rel)) !== h) drift.push(rel);
  }
  for (const rel of task.verification?.filesChangedActual ?? []) {
    if (!(rel in (task.base?.hashes ?? {})) && existsSync(join(projectRoot, rel))) drift.push(rel);
  }
  if (drift.length) return { ok: false, message: `arquivos do escopo mudaram desde a base: ${drift.join(", ")}. Rejeitado para não sobrescrever alterações.` };

  const check = git(projectRoot, ["apply", "--check", patch]);
  if (!check.ok) return { ok: false, message: `git apply --check falhou: ${check.stderr.slice(0, 400)}` };
  const applied = git(projectRoot, ["apply", patch]);
  if (!applied.ok) return { ok: false, message: `git apply falhou: ${applied.stderr.slice(0, 400)}` };
  task.applied = true;
  store.saveTask(task);
  const run = store.loadRun(task.runId);
  if (run) {
    store.updateRun(run.runId, (fresh) => { fresh.decisions.push({ at: new Date().toISOString(), taskId, kind: "note", text: "patch do worktree aplicado ao working tree" }); });
  }
  store.telemetry({ event: "task_applied", runId: task.runId, taskId });
  return {
    ok: true,
    message: `patch aplicado ao working tree (sem commit). O worktree descartável continua em ${task.worktree}; remova com: git worktree remove "${task.worktree}"`,
  };
}

export function acceptTask(projectRoot: string, taskId: string, accepted: boolean, note: string): { ok: boolean; message: string } {
  const store = new Store(projectRoot);
  const task = store.findTask(taskId);
  if (!task) return { ok: false, message: `task não encontrada: ${taskId}` };
  if (!isTerminal(task.state)) return { ok: false, message: `task ainda não terminou (estado: ${task.state})` };
  if (accepted && task.state !== "succeeded") return { ok: false, message: "só tasks succeeded podem ser aceitas; registre --reject com a justificativa" };
  task.accepted = { at: new Date().toISOString(), accepted, note };
  store.saveTask(task);
  const run = store.loadRun(task.runId);
  if (run) {
    store.updateRun(run.runId, (fresh) => { fresh.decisions.push({ at: task.accepted!.at, taskId, kind: accepted ? "accepted" : "rejected", text: note || (accepted ? "aceito" : "rejeitado") }); });
  }
  store.telemetry({ event: accepted ? "task_accepted" : "task_rejected", runId: task.runId, taskId });
  return { ok: true, message: `${taskId} ${accepted ? "aceita" : "rejeitada"}` };
}
