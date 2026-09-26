import type { Task, TaskState } from "./types.js";

export const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  planned: ["approved", "blocked", "cancelled"],
  approved: ["running", "blocked", "cancelled"],
  running: ["succeeded", "failed", "blocked", "cancelled"],
  // blocked -> approved é a retomada explícita (após login, decisão de orçamento, interrupção...).
  blocked: ["approved", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class TransitionError extends Error {}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(task: Task, to: TaskState, reason: string): void {
  if (!canTransition(task.state, to)) {
    throw new TransitionError(`transição inválida ${task.state} -> ${to} (${task.taskId})`);
  }
  task.history.push({ at: new Date().toISOString(), from: task.state, to, reason });
  task.state = to;
  if (to !== "approved" && to !== "running") task.outcome = reason;
}

export function isTerminal(state: TaskState): boolean {
  return TRANSITIONS[state].length === 0;
}
