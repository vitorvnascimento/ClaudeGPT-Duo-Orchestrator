// Quem pode receber uma tarefa quando a conta atual fica sem cota ou capacidade (e na recomendação inicial).
import { EXECUTORS, type DuoConfig, type Provider } from "../config.js";
import { GEMINI_VERIFIED, type VerifiedAgy } from "../adapters/gemini.js";
import type { Isolation } from "../state/slots.js";
import { isWriteKind, type TaskKind } from "../state/types.js";

export type EligibilityCtx = {
  kind: TaskKind;
  fixedIsolation: Isolation | null;
  cfg: DuoConfig;
  platform: NodeJS.Platform;
  verified?: readonly VerifiedAgy[];
};

/** Filtra antes de ordenar: uma conta que seria recusada pelos portões nunca ganha a vaga de outra. */
export function executorEligible(p: Provider, ctx: EligibilityCtx): boolean {
  if (p !== "gemini") return true;
  if (!ctx.cfg.executors.gemini.enabled || ctx.platform !== "darwin") return false;
  if (!(ctx.verified ?? GEMINI_VERIFIED).some((v) => v.platform === ctx.platform)) return false;
  // Escrita do gemini só roda em worktree: uma cadeia fixada in-place não pode migrar para ele.
  if (isWriteKind(ctx.kind) && ctx.fixedIsolation === "in-place") return false;
  return true;
}

/**
 * Ordem: a própria conta primeiro quando o limite é de um modelo só (sameFirst), depois as outras na ordem
 * claude, codex, gemini. shortcut: ordem fixa em vez do placar do roteador; o gemini fica por último por ser a conta
 * menos provada. Trocar por placar quando houver histórico suficiente do gemini.
 */
export function alternateProviders(current: Provider, ctx: EligibilityCtx, opts: { sameFirst: boolean }): Provider[] {
  const others = EXECUTORS.filter((p) => p !== current && executorEligible(p, ctx));
  return opts.sameFirst ? [current, ...others] : others;
}
