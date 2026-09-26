// Regras determinísticas e editáveis. O cérebro decide se delega; a ponte só impõe limites.
import type { DuoConfig } from "../config.js";
import type { DelegationRequest, Run } from "../state/types.js";

export function effectiveDelegationLimit(cfg: DuoConfig): number {
  const base = cfg.limits.maxDelegationsPerRun;
  return cfg.policy === "qualidade" && cfg.limits.qualityBudgetAuthorized ? base * 2 : base;
}

/** Retorna o motivo de bloqueio, ou null. */
export function policyBlockReason(req: DelegationRequest, cfg: DuoConfig, run: Run): string | null {
  if (run.cancelled) return `run ${run.runId} foi cancelado`;
  if (run.brain !== req.brain) return `o cérebro do run ${run.runId} é ${run.brain}; não é trocado no meio da execução (use duo handoff)`;
  const limit = effectiveDelegationLimit(cfg);
  if (run.invocations >= limit) {
    return `limite de ${limit} invocações delegadas por run atingido (${run.invocations}/${limit}). Exceder exige decisão explícita: ajuste limits.maxDelegationsPerRun ou inicie outro run.`;
  }
  const allowedReasons: Record<DuoConfig["policy"], DelegationRequest["reason"][]> = {
    economico: ["user_requested", "clear_benefit", "blocked_or_failure"],
    equilibrado: ["user_requested", "clear_benefit", "blocked_or_failure", "second_opinion"],
    qualidade: ["user_requested", "clear_benefit", "blocked_or_failure", "second_opinion", "cross_review"],
  };
  if (!allowedReasons[cfg.policy].includes(req.reason)) {
    return `política ${cfg.policy} não permite reason=${req.reason} (permitidos: ${allowedReasons[cfg.policy].join(", ")})`;
  }
  if ((req.reason === "second_opinion" || req.reason === "cross_review") && req.kind !== "review") {
    return `reason=${req.reason} exige kind=review`;
  }
  const preserved = cfg.quotaPreference === "preserve-codex" ? "codex" : cfg.quotaPreference === "preserve-claude" ? "claude" : null;
  if (preserved === req.executor && !["user_requested", "blocked_or_failure"].includes(req.reason)) {
    return `quotaPreference=${cfg.quotaPreference}: delegar ao ${req.executor} só com reason=user_requested ou blocked_or_failure`;
  }
  return null;
}
