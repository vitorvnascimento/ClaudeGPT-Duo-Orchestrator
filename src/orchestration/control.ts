// Comandos de controle determinísticos: cancelamento, integração de worktree, decisões e detecção de interrupção.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chainStatePath, removeChainStateSafe, type ChainClass } from "../state/gemini-state.js";
import { isPidAlive, killPidTree } from "../adapters/process.js";
import { loadConfig } from "../config.js";
import { captureState, git, hashPath, headCommit } from "../git.js";
import { inScope, validateScope } from "../permissions/scope.js";
import { canTransition, isTerminal, transition } from "../state/machine.js";
import { recoverSlotsLocked, withAdmission } from "../state/slots.js";
import { Store } from "../state/store.js";
import { driftNeedsSettling, driftOutstanding, executorMaybeAlive, finishDrift } from "./drift-check.js";
import type { Task } from "../state/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reconcile tasks whose bridge exited. A lost computer-use audit is terminal. */
export function refreshInterrupted(store: Store, taskId?: string, env: NodeJS.ProcessEnv = process.env): { taskId: string; orphanChild: number | null }[] {
  const found: { taskId: string; orphanChild: number | null }[] = [];
  for (const run of store.listRuns()) {
    for (const task of store.listTasks(run)) {
      if (taskId && task.taskId !== taskId) continue;
      const computerUse = task.needs?.includes("computer_use");
      const admitted = computerUse && task.state === "approved" && task.pids.bridge !== null;
      if (task.state !== "running" && !admitted) continue;
      if (task.pids.bridge && isPidAlive(task.pids.bridge)) continue;
      const orphan = task.pids.child && isPidAlive(task.pids.child) ? task.pids.child : null;
      const state = computerUse ? "failed" : "blocked";
      if (admitted) transition(task, "blocked", "a ponte saiu após a admissão e antes do início da execução");
      if (state === "failed") delete task.blockedReason;
      transition(task, state, `interrompida: o processo da ponte não está mais ativo${orphan ? ` (PID auditado ${orphan} ainda existe; verifique a identidade e a saída do processo antes de recuperar a reserva)` : ""}`);
      store.saveTask(task);
      const chain = store.chainForTask(task);
      const owner = chain.owner;
      const interrupted = !owner || !isPidAlive(owner.pid);
      store.updateChain(run.runId, chain.chainId, (fresh) => {
        if (interrupted && fresh.latestTaskId === task.taskId && fresh.owner?.nonce === owner?.nonce && fresh.owner?.pid === owner?.pid) {
          fresh.status = state;
          fresh.owner = null;
        }
      });
      found.push({ taskId: task.taskId, orphanChild: orphan });
    }
  }
  settlePendingDrift(store, taskId, env);
  return found;
}

/**
 * Conferências pós-tarefa (Gemini no Windows) deixadas por uma ponte que não está mais ativa: termina a comparação
 * se o executor teve o fim confirmado; vivo ou incerto, fica pendente e uma recuperação posterior tenta de novo.
 */
function settlePendingDrift(store: Store, taskId: string | undefined, env: NodeJS.ProcessEnv): void {
  for (const run of store.listRuns()) {
    for (const task of store.listTasks(run)) {
      if ((taskId && task.taskId !== taskId) || !driftNeedsSettling(task)) continue;
      if (task.pids.bridge && isPidAlive(task.pids.bridge)) continue; // a ponte ativa termina a própria conferência
      try { finishDrift(store, task, env, { executorAlive: executorMaybeAlive(task.pids.child), recovery: true }); }
      catch { /* fica o marcador: a próxima recuperação tenta de novo */ }
    }
  }
}

export async function cancelRun(projectRoot: string, runId: string, graceMs = 10_000, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; message: string; cancelled: string[] }> {
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
    // conferência pós-tarefa antes de limpar o PID: o fim confirmado do executor é a prova que ela precisa
    if (driftNeedsSettling(fresh) && !(fresh.pids.bridge && isPidAlive(fresh.pids.bridge))) {
      try { finishDrift(store, fresh, env, { executorAlive: executorMaybeAlive(fresh.pids.child), recovery: true }); }
      catch { /* fica o marcador: a recuperação tenta de novo */ }
    }
    if (!isTerminal(fresh.state) && canTransition(fresh.state, "cancelled")) {
      transition(fresh, "cancelled", "cancelado pelo usuário (duo cancel)");
      // Não descarte a evidência de um executor que ainda sobrevive ao cancelamento.
      // PID morto fica enquanto a conferência pós-tarefa não fechar: é a prova do fim do executor para a recuperação
      if (fresh.pids.child && !isPidAlive(fresh.pids.child) && !driftNeedsSettling(fresh)) fresh.pids.child = null;
      store.saveTask(fresh);
    }
    if (fresh.state === "cancelled") cancelled.push(fresh.taskId);
  }
  store.telemetry({ event: "run_cancelled", runId, tasks: cancelled });
  return { ok: true, message: `run ${runId} cancelado`, cancelled };
}

/** Integra o patch de um worktree somente se a base não mudou. Nunca força nem descarta mudanças do usuário. */
export function applyTask(projectRoot: string, taskId: string, env: NodeJS.ProcessEnv = process.env, opts: { ackDrift?: boolean } = {}): { ok: boolean; message: string } {
  return withAdmission(projectRoot, () => {
    const slots = recoverSlotsLocked(projectRoot);
    if (slots.some((slot) => slot.exclusive)) {
      return { ok: false, message: "um executor exclusivo está ativo; aguarde ele terminar para aplicar" };
    }
    if (slots.some((slot) => slot.isolation === "in-place")) {
      return { ok: false, message: "um executor in-place está ativo; aplique depois que ele terminar" };
    }
    const r = applyAdmitted(projectRoot, taskId, opts.ackDrift === true);
    if (r.ok) dropGeminiState(projectRoot, taskId, env);
    return r;
  });
}

/**
 * A conversa nativa do gemini só serve para retomar; quando a cadeia é decidida (apply/accept) por qualquer executor,
 * o HOME privado dela é apagado (uma tentativa gemini antes de um fallback para Claude/Codex também deixa estado).
 */
function dropGeminiState(projectRoot: string, taskId: string, env: NodeJS.ProcessEnv): void {
  const store = new Store(projectRoot);
  const task = store.findTask(taskId);
  if (!task) return;
  // Id da cadeia vem do registro da cadeia (não de campos livres da task); o caminho é sempre recalculado.
  const chain = store.loadChain(task.runId, task.selection?.chainId ?? task.taskId);
  // A cadeia carregada precisa conter esta task, e esta task precisa ser a última dela (a decisão encerra a cadeia).
  if (!chain || chain.latestTaskId !== task.taskId || !chain.attempts.some((a) => a.taskId === task.taskId)) return;
  try { removeChainStateSafe(chainStatePath(projectRoot, chain.chainId, env), projectRoot, chain.chainId, env); } catch { /* id inválido: não apaga */ }
}

/** Classe da cadeia para a limpeza do HOME privado do gemini (a cadeia "catalog" é a descoberta de modelos). */
export function classifyGeminiChain(projectRoot: string, chainId: string): ChainClass {
  if (chainId === "catalog") return "resumable";
  const store = new Store(projectRoot);
  const tasks = store.listRuns().flatMap((r) => store.listTasks(r))
    .filter((t) => (t.selection?.chainRoot ?? t.selection?.chainId ?? t.taskId) === chainId);
  if (!tasks.length) return "orphan";
  const chain = store.loadChain(tasks[0]!.runId, chainId);
  if (!chain) return "orphan";
  const latest = tasks.find((t) => t.taskId === chain.latestTaskId) ?? null;
  // Dono vivo da cadeia, ou executor vivo enquanto a tentativa roda; marcas de uso são vistas pela própria limpeza.
  if ((chain.owner && isPidAlive(chain.owner.pid)) || (latest?.state === "running" && latest.pids.child && isPidAlive(latest.pids.child))) return "active";
  // Só a última tentativa decide: uma anterior aplicada não encerra uma cadeia que seguiu (retomada ou retentativa).
  if (latest?.applied || latest?.accepted) return "terminal";
  // Estado persistido da cadeia: blocked e running interrompido (inclui tentativa planned) são retomáveis.
  if (chain.status === "blocked" || chain.status === "running" || latest?.state === "planned") return "resumable";
  return "terminal";
}

function applyAdmitted(projectRoot: string, taskId: string, ackDrift: boolean): { ok: boolean; message: string } {
  const store = new Store(projectRoot);
  const task = store.findTask(taskId);
  if (!task) return { ok: false, message: `task não encontrada: ${taskId}` };
  if (task.needs?.includes("computer_use")) return { ok: false, message: "tasks computer_use não produzem patches para aplicar; inspecione a worktree manualmente" };
  if (!task.worktree) return { ok: false, message: "task in-place: as mudanças já estão no working tree; não há patch a aplicar" };
  if (task.state !== "succeeded") return { ok: false, message: `só tasks succeeded podem ser integradas (estado: ${task.state})` };
  if (task.applied) return { ok: true, message: "patch já aplicado anteriormente; nada a fazer" };
  // Só avisa (decisão do dono): o patch fica parado até o cérebro revisar e confirmar com --ack-drift.
  // Inclui tentativas anteriores (retomadas na mesma task ou em tasks novas da cadeia) e marcador pendente: falha fechado.
  // tentativa gemini da cadeia que não se lê (task.json sumido ou corrompido): conferência incompleta, nunca ignorada
  const unreadable: string[] = [];
  const others = store.chainForTask(task).attempts.filter((a) => a.taskId !== task.taskId).flatMap((a) => {
    const t = store.findTask(a.taskId);
    if (!t && a.executor === "gemini") unreadable.push(a.taskId);
    return t ? [t] : [];
  });
  const parts = [task, ...others].flatMap((t) => { const o = driftOutstanding(t); return o ? [{ ...o, where: `${t.taskId}: ${o.sources.join(", ")} em ${join(t.artifactsDir, "task.json")}` }] : []; });
  const d = parts.length || unreadable.length ? { changed: [...new Set(parts.flatMap((x) => x.changed))].sort(), incomplete: unreadable.length > 0 || parts.some((x) => x.incomplete),
    where: [...parts.map((x) => x.where), ...unreadable.map((id) => `${id}: tentativa ilegível`)] } : null;
  if (d && !ackDrift) {
    const what = [d.changed.length ? `${d.changed.length} caminho(s) mudaram fora da worktree durante a tentativa do Gemini (${d.changed.slice(0, 5).join(", ")}${d.changed.length > 5 ? ", …" : ""})` : "", d.incomplete ? "a conferência pós-tarefa ficou incompleta" : ""].filter(Boolean).join("; ");
    return { ok: false, message: `${what}. Evidência: ${d.where.join("; ")}. Depois de revisar, rode duo apply --task-id ${taskId} --ack-drift para aplicar mesmo assim.` };
  }
  const patch = task.verification?.patchPath;
  if (!patch || !existsSync(patch)) return { ok: false, message: "patch da task não encontrado" };

  const head = headCommit(projectRoot);
  if (head !== task.base?.head) return { ok: false, message: `base desatualizada: HEAD atual ${head?.slice(0, 12)} ≠ base ${task.base?.head?.slice(0, 12)}. Rejeitado; refaça a tarefa sobre a base atual.` };
  const cfg = loadConfig(projectRoot);
  const scope = validateScope(projectRoot, task.scope, cfg.scope.deny, { allowWholeProject: false });
  if (!scope.ok) return { ok: false, message: `escopo inválido na integração: ${scope.errors.join("; ")}` };
  const hashes = task.base?.hashes ?? {};
  const patchFiles = task.verification?.filesChangedActual ?? [];
  const drift = patchFiles.filter((rel) => hashPath(join(projectRoot, rel)) !== (hashes[rel] ?? null));
  if (drift.length) return { ok: false, message: `arquivos do patch mudaram desde a base: ${drift.join(", ")}. Rejeitado para não sobrescrever alterações.` };
  const current = captureState(projectRoot, scope.entries.map((entry) => entry.rel));
  const otherDrift = [...new Set([...Object.keys(hashes), ...Object.keys(current.hashes)])]
    .filter((rel) => inScope(rel, scope.entries) && !patchFiles.includes(rel) && hashPath(join(projectRoot, rel)) !== (hashes[rel] ?? null));
  const warning = otherDrift.length ? ` Aviso: o projeto mudou fora do patch desde o snapshot: ${otherDrift.join(", ")}.` : "";

  const check = git(projectRoot, ["apply", "--check", patch]);
  if (!check.ok) return { ok: false, message: `git apply --check falhou: ${check.stderr.slice(0, 400)}` };
  const applied = git(projectRoot, ["apply", patch]);
  if (!applied.ok) return { ok: false, message: `git apply falhou: ${applied.stderr.slice(0, 400)}` };
  task.applied = true;
  task.appliedAt = new Date().toISOString();
  store.saveTask(task);
  const run = store.loadRun(task.runId);
  if (run) {
    store.updateRun(run.runId, (fresh) => { fresh.decisions.push({ at: new Date().toISOString(), taskId, kind: "note", text: "patch do worktree aplicado ao working tree" }); });
  }
  store.telemetry({ event: "task_applied", runId: task.runId, taskId });
  return {
    ok: true,
    message: `patch aplicado ao working tree (sem commit). O worktree descartável continua em ${task.worktree}; remova com: git worktree remove "${task.worktree}"${warning}`,
  };
}

export function acceptTask(projectRoot: string, taskId: string, accepted: boolean, note: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; message: string } {
  const store = new Store(projectRoot);
  const task = store.findTask(taskId);
  if (!task) return { ok: false, message: `task não encontrada: ${taskId}` };
  if (!isTerminal(task.state)) return { ok: false, message: `task ainda não terminou (estado: ${task.state})` };
  if (accepted && task.state !== "succeeded") return { ok: false, message: "só tasks succeeded podem ser aceitas; registre --reject com a justificativa" };
  task.accepted = { at: new Date().toISOString(), accepted, note };
  store.saveTask(task);
  dropGeminiState(projectRoot, taskId, env);
  const run = store.loadRun(task.runId);
  if (run) {
    store.updateRun(run.runId, (fresh) => { fresh.decisions.push({ at: task.accepted!.at, taskId, kind: accepted ? "accepted" : "rejected", text: note || (accepted ? "aceito" : "rejeitado") }); });
  }
  store.telemetry({ event: accepted ? "task_accepted" : "task_rejected", runId: task.runId, taskId });
  return { ok: true, message: `${taskId} ${accepted ? "aceita" : "rejeitada"}` };
}
