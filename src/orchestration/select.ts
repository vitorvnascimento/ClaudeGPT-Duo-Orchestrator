import type { Capability, Catalog, ModelInfo } from "../adapters/catalog.js";
import { compareModelVersions, extraUsage, selectEffort, tierOf, type Effort, type Tier } from "../adapters/tiers.js";
import type { DuoConfig, Provider } from "../config.js";
import { TIERS, tierRank } from "./complexity.js";
import type { CandidateEval } from "./router.js";

export type SelectionContext = { candidates: CandidateEval[]; floor: Tier; needs?: Capability[]; allowDowngrade?: boolean; minimumEffort?: Effort };
export type ModelSelection = { model: string; effort: Effort | null; tier: Tier; reason: string[] };

export function automaticModelAllowed(model: ModelInfo, cfg: DuoConfig): boolean {
  const names = [model.id, ...model.aliases].map((n) => `${model.provider}:${n}`.toLowerCase());
  const included = cfg.routing.include?.some((n) => names.includes(n.toLowerCase())) ?? false;
  return !cfg.routing.exclude.some((n) => names.includes(n.toLowerCase()))
    && (cfg.routing.include === null || included)
    && (!extraUsage(model) || (cfg.billing.acknowledgeUnverifiableExtraUsage[model.provider] && included));
}

export function selectModel(catalog: Catalog | null, cfg: DuoConfig, executor: Provider, tier: Tier, ctx: SelectionContext): ModelSelection | null {
  tier = TIERS[Math.max(tierRank(tier), tierRank(ctx.floor))] as Tier;
  const pc = catalog?.providers[executor];
  if (!pc?.ok || pc.stale || !pc.models.length) return null;
  const ev = (m: ModelInfo) => ctx.candidates.find((c) => c.executor === executor && c.model === m.id);
  const eligible = pc.models.filter((m) => automaticModelAllowed(m, cfg) && (ctx.needs ?? []).every((n) => m.capabilities.includes(n)) && ev(m)?.available !== false
    && (!ctx.minimumEffort || selectEffort(tierOf(m, cfg).tier, m, { minimum: ctx.minimumEffort }) !== null));
  const reason: string[] = [`nível-alvo=${tier}; piso=${ctx.floor}`];
  const ranked = (target: Tier, downgrade = false) => {
    let models = eligible.filter((m) => tierOf(m, cfg).tier === target);
    if (models.some((m) => !m.legacy)) models = models.filter((m) => !m.legacy);
    return models.filter((m) => {
      const e = ev(m)?.evidence;
      if (e?.sufficient && e.successRate < 0.5) { reason.push(`${m.id} pulado: evidência suficiente com sucesso < 0,5`); return false; }
      return !downgrade || (e?.sufficient === true && e.successRate >= cfg.routing.adaptive.downgradeMinSuccess && e.bucket !== "todas as tarefas do mesmo grupo");
    }).sort((a, b) => {
      const ea = ev(a), eb = ev(b);
      // O score medido precede sinais do fornecedor; o prior continua identificado no roteador.
      const score = (c: CandidateEval | undefined) => c ? c.score - (c.vendor.recommended ? 0.05 : 0) + (c.vendor.legacy ? 0.1 : 0) : 0.5;
      return score(eb) - score(ea) || Number(b.vendorRecommended) - Number(a.vendorRecommended) || compareModelVersions(b, a);
    });
  };
  const below = TIERS[tierRank(tier) - 1];
  if (ctx.allowDowngrade !== false && below && tierRank(below) >= tierRank(ctx.floor)) {
    const m = ranked(below, true)[0];
    if (m) return { model: m.id, tier: below, effort: selectEffort(below, m, { minimum: ctx.minimumEffort }), reason: [...reason, `redução protegida: ${m.id}, evidência suficiente no bucket >= ${cfg.routing.adaptive.downgradeMinSuccess}`] };
  }
  for (const target of TIERS.slice(tierRank(tier))) {
    const m = ranked(target)[0];
    if (m) return { model: m.id, tier: target, effort: selectEffort(target, m, { minimum: ctx.minimumEffort }), reason: [...reason, `selecionado ${m.id}: evidência > recomendado pelo fornecedor > versão da família`, ...(target !== tier ? [`nível ${tier} sem candidato elegível; sobe para ${target}`] : [])] };
  }
  return null;
}
