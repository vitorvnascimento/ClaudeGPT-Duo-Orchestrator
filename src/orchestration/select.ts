import { findModel, type Capability, type Catalog, type ModelInfo } from "../adapters/catalog.js";
import { EFFORTS, compareModelVersions, extraUsage, selectEffort, tierOf, type Effort, type Tier } from "../adapters/tiers.js";
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
    && (!extraUsage(model) || (cfg.billing.acknowledgeUnverifiableExtraUsage[model.provider] === true && included));
}

/** Uma única fronteira para seleção, reserva, retomada e observação nativa. */
export function confirmFloor(input: {
  catalog: Catalog | null; cfg: DuoConfig; executor: Provider; model: string | null;
  floor: Tier; effort: string | null; automatic: boolean; needs?: readonly string[]; minimumEffort?: Effort;
}): { ok: true; tier: Tier; effort: Effort | null } | { ok: false; tier: Tier; reason: string } {
  const { catalog, cfg, executor, model, floor, automatic } = input;
  const pc = catalog?.providers[executor];
  const info = model && catalog ? findModel(catalog, executor, model) : null;
  const level = model ? tierOf(info ?? { id: model, displayName: model, aliases: [] }, cfg) : null;
  const tier = level?.tier ?? floor;
  const fail = (reason: string) => ({ ok: false as const, tier, reason: `${reason}. Atualize o catálogo com duo models --refresh e escolha modelo/esforço compatíveis; remova fixações incompatíveis` });
  if (level && tierRank(tier) < tierRank(floor)) {
    return fail(`risco/escopo exige nível ${floor}; ${model} é ${tier}. Remova \x60model\x60 para escolha automática ou peça um modelo de nível ${floor}`);
  }
  if (automatic || floor === "deep" || (input.needs?.length ?? 0) > 0) {
    if (!pc?.ok || pc.stale || !info || info.source === "user-config") return fail(`não é possível confirmar o piso ${floor} e a elegibilidade de ${model ?? "padrão da CLI desconhecido"}: catálogo indisponível/stale ou modelo sem confirmação do fornecedor`);
  }
  if (floor === "deep" && (!level || level.presumed)) return fail(`não é possível confirmar nível deep de ${model ?? "padrão da CLI desconhecido"} (nível desconhecido/presumido)`);
  if (automatic && info && !automaticModelAllowed(info, cfg)) return fail(`modelo automático ${model} não elegível: uso extra exige ciência e inclusão explícita; include/exclude continuam obrigatórios`);
  if (input.needs?.some((need) => !info?.capabilities.includes(need as Capability))) return fail(`capacidade exigida não confirmada para ${model}: ${input.needs.join(", ")}`);
  let effort = input.effort as Effort | null;
  if (!effort && info && (floor === "deep" || input.minimumEffort)) effort = selectEffort(floor, info, { minimum: input.minimumEffort });
  if (floor === "deep" && (!effort || EFFORTS.indexOf(effort) < EFFORTS.indexOf("high") || !info?.efforts.includes(effort))) {
    return fail(`piso deep: esforço/effort ${effort ?? "desconhecido"} exige suporte anunciado a high ou superior; ${model} não confirma esse mínimo`);
  }
  if (input.minimumEffort && (!effort || EFFORTS.indexOf(effort) < EFFORTS.indexOf(input.minimumEffort) || !info?.efforts.includes(effort))) {
    return fail(`esforço mínimo ${input.minimumEffort} alcançado na cadeia não pode ser confirmado em ${model}; sem reduzir raciocínio`);
  }
  return { ok: true, tier, effort };
}

export function selectModel(catalog: Catalog | null, cfg: DuoConfig, executor: Provider, tier: Tier, ctx: SelectionContext): ModelSelection | null {
  tier = TIERS[Math.max(tierRank(tier), tierRank(ctx.floor))] as Tier;
  const pc = catalog?.providers[executor];
  if (!pc?.ok || pc.stale || !pc.models.length) return null;
  const ev = (m: ModelInfo) => ctx.candidates.find((c) => c.executor === executor && c.model === m.id);
  const eligible = pc.models.filter((m) => ev(m)?.available !== false && confirmFloor({
    catalog, cfg, executor, model: m.id, floor: ctx.floor, needs: ctx.needs, automatic: true,
    effort: selectEffort(tierOf(m, cfg).tier, m, { minimum: ctx.minimumEffort }), minimumEffort: ctx.minimumEffort,
  }).ok);
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
