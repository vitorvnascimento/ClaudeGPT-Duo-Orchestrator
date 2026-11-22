// Quem pode receber uma tarefa quando a conta atual fica sem cota ou capacidade (e na recomendação inicial).
import { EXECUTORS, type DuoConfig, type Provider } from "../config.js";
import { GEMINI_VERIFIED, type VerifiedAgy } from "../adapters/gemini.js";
import { unsupportedDenyGlob } from "../adapters/sandbox-profile.js";
import type { Isolation } from "../state/slots.js";
import type { TaskKind } from "../state/types.js";

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
  // O gate do gemini mora numa worktree descartável: nenhuma cadeia fixada in-place pode migrar para ele.
  if (ctx.fixedIsolation === "in-place") return false;
  // scope.deny que a trava do SO não aplica: toda delegação ao gemini bloquearia ao montar o perfil.
  if (unsupportedDenyGlob(ctx.cfg.scope.deny)) return false;
  return true;
}

/** Ordem base: a própria conta primeiro quando o limite é de um modelo só (sameFirst), depois claude, codex, gemini. */
export function alternateProviders(current: Provider, ctx: EligibilityCtx, opts: { sameFirst: boolean }): Provider[] {
  const others = EXECUTORS.filter((p) => p !== current && executorEligible(p, ctx));
  return opts.sameFirst ? [current, ...others] : others;
}

/**
 * Escolhe a alternativa: a própria conta primeiro (sameFirst) se tiver modelo; senão, entre as demais, o modelo com
 * maior placar do roteador; empate fica com a ordem base (claude, codex, gemini).
 */
export function pickAlternate<S extends { model: string }>(
  providers: readonly Provider[],
  sameFirst: boolean,
  select: (p: Provider) => S | null,
  score: (p: Provider, model: string) => number,
): { executor: Provider; selected: S } | null {
  const [first, ...rest] = providers;
  if (sameFirst && first) {
    const s = select(first);
    if (s) return { executor: first, selected: s };
  }
  let best: { executor: Provider; selected: S; score: number } | null = null;
  for (const p of sameFirst ? rest : providers) {
    const s = select(p);
    if (!s) continue;
    const sc = score(p, s.model);
    if (!best || sc > best.score) best = { executor: p, selected: s, score: sc };
  }
  return best ? { executor: best.executor, selected: best.selected } : null;
}
