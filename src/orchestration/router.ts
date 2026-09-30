// Roteador por evidência sobre o catálogo REAL das contas conectadas.
// 1) capacidade exigida (ex.: image_generation) é filtro obrigatório;
// 2) evidência medida neste projeto (tarefas comparáveis, verificação independente, decisões do cérebro) decide;
// 3) sinais do próprio fornecedor (recomendado / legado) e preferências declaradas pelo usuário pesam pouco;
// 4) disponibilidade atual (CLI, login por assinatura, ciência de uso extra, limite observado).
// Não há ranking fixo de fornecedores: sem evidência suficiente, a recomendação diz isso.
import { extname } from "node:path";
import { describeSource, type Capability, type Catalog, type ModelInfo } from "../adapters/catalog.js";
import { compareModelVersions, selectEffort, tierOf, type Tier } from "../adapters/tiers.js";
import { assessComplexity, sensitiveScope, tierRank } from "./complexity.js";
import { automaticModelAllowed, selectModel } from "./select.js";
import { resolveExecutable } from "../adapters/resolve.js";
import type { DuoConfig, Provider } from "../config.js";
import { listFiles } from "../git.js";
import { authBlockReason, checkAuth, defaultAuthPaths, type AuthPaths } from "../permissions/auth.js";
import type { ScopeEntry } from "../permissions/scope.js";
import type { Store } from "../state/store.js";
import type { DelegationRequest, Selection, Task, TaskKind } from "../state/types.js";

export type Risk = "low" | "medium" | "high";
export type RouteQuery = { kind: TaskKind; tags: string[]; risk: Risk; brain: Provider | null; brainModel?: string | null; needs?: Capability[]; objective?: string; paths?: Pick<ScopeEntry, "rel" | "isDir">[]; acceptance?: DelegationRequest["acceptance"]; complexity?: Tier };

export type Evidence = {
  bucket: string;
  n: number;
  successes: number;
  /** (sucessos + 1) / (n + 2): suavização de Laplace, 0,5 sem dados. */
  successRate: number;
  sufficient: boolean;
  acceptancePassRate: number | null;
  overclaims: number;
  rejectedByBrain: number;
  medianWallMs: number | null;
};

export type CandidateEval = {
  executor: Provider;
  model: string | null;
  displayName: string | null;
  available: boolean;
  availability: string[];
  evidence: Evidence;
  prior: { bonus: number; notes: string[] };
  vendor: { recommended: boolean; legacy: boolean };
  score: number;
  reasons: string[];
};

export type Decision = {
  tier?: Tier;
  effort?: string | null;
  action: "delegate" | "self" | "judgment";
  executor: Provider | null;
  model: string | null;
  confidence: "alta" | "média" | "baixa";
  why: string[];
};

export type Recommendation = { selection?: Selection; query: RouteQuery; decision: Decision; explore: string | null; candidates: CandidateEval[]; notes: string[] };

/** Extensões do escopo (até 5 mais frequentes), usadas para comparar tarefas parecidas. */
export function deriveTags(projectRoot: string, entries: Pick<ScopeEntry, "rel" | "isDir">[], includeSensitive = false): string[] {
  const counts = new Map<string, number>();
  const sensitive = new Set<string>();
  const add = (p: string) => {
    if (includeSensitive && sensitiveScope(p)) sensitive.add(p);
    const ext = extname(p).slice(1).toLowerCase();
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  };
  for (const e of entries) {
    if (e.isDir || e.rel === ".") for (const f of listFiles(projectRoot, [e.rel]).slice(0, 2000)) add(f);
    else add(e.rel);
  }
  return [...sensitive, ...[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)];
}

type Outcome = "success" | "failure" | "excluded";

/** Só conta o que mede qualidade do executor; falhas de infraestrutura não têm relatório e ficam de fora. */
export function outcomeOf(t: Task): Outcome {
  if (t.accepted?.accepted === false) return "failure";
  if (t.state === "succeeded") return "success";
  if (t.state === "cancelled" || /^(timeout|limite\/cota|falha de autenticação|modelo indisponível|falha ao iniciar|violação de escopo|o lock|o estado base|saída do executor excedeu)/i.test(t.outcome ?? "")
    || t.verification?.lockIntact === false || t.verification?.staleBase === true || (t.verification?.outOfScope?.length ?? 0) > 0 || (t.verification?.deniedTouched?.length ?? 0) > 0) return "excluded";
  if (t.verification?.acceptance?.some((a) => !a.passed && (!a.ran || a.exitCode === null || a.outputTail?.endsWith("\n[timeout]")))) return "excluded";
  if (!t.executorReport) return "excluded";
  if (t.state === "failed") return "failure";
  if (t.state === "blocked" && (t.executorReport.status === "partial" || t.executorReport.status === "blocked")) return "failure";
  return "excluded";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

type Cand = { executor: Provider; model: string | null; names: string[]; info: ModelInfo | null; isDefault: boolean };

/** Tarefas sem `model` explícito rodaram no modelo padrão do cliente; contam para esse candidato. */
function sameModel(c: Cand, task: Task): boolean {
  const req = task.model?.requested ?? null;
  if (req === null) return c.model === null || c.isDefault;
  return c.names.includes(req.toLowerCase());
}

function evidenceFor(tasks: Task[], cand: Cand, q: RouteQuery, minSamples: number): Evidence {
  const mine = tasks.filter((t) => t.executor === cand.executor && sameModel(cand, t) && outcomeOf(t) !== "excluded");
  const buckets: { name: string; items: Task[] }[] = [
    { name: `kind=${q.kind} + tags=${q.tags.join("|") || "-"}`, items: q.tags.length ? mine.filter((t) => t.kind === q.kind && (t.tags ?? []).some((x) => q.tags.includes(x))) : [] },
    { name: `kind=${q.kind}`, items: mine.filter((t) => t.kind === q.kind) },
    // Arte e código não se comparam: tarefas "asset" nunca emprestam evidência para outros tipos, e vice-versa.
    { name: "todas as tarefas do mesmo grupo", items: mine.filter((t) => (t.kind === "asset") === (q.kind === "asset")) },
  ];
  const chosen = buckets.find((b) => b.items.length >= minSamples) ?? buckets.reduce((a, b) => (b.items.length > a.items.length ? b : a));
  const items = chosen.items;
  const successes = items.filter((t) => outcomeOf(t) === "success").length;
  const acc = items.flatMap((t) => (t.verification?.acceptance ?? []).filter((a) => a.ran));
  return {
    bucket: chosen.name,
    n: items.length,
    successes,
    successRate: (successes + 1) / (items.length + 2),
    sufficient: items.length >= minSamples,
    acceptancePassRate: acc.length ? acc.filter((a) => a.passed).length / acc.length : null,
    overclaims: items.filter((t) => t.executorReport?.status === "completed" && t.state === "failed").length,
    rejectedByBrain: items.filter((t) => t.accepted?.accepted === false).length,
    medianWallMs: median(items.map((t) => t.metrics?.wallMs).filter((x): x is number => typeof x === "number")),
  };
}

export type AvailabilityFn = (executor: Provider) => { available: boolean; reasons: string[] };

/** Disponibilidade real, sem inferência: CLI instalada, login por assinatura, ciência de uso extra, limite observado. */
export function liveAvailability(store: Store, cfg: DuoConfig, env: NodeJS.ProcessEnv = process.env, authPaths?: AuthPaths): AvailabilityFn {
  const paths = authPaths ?? defaultAuthPaths(store.projectRoot, env);
  const cache = new Map<Provider, { available: boolean; reasons: string[] }>();
  return (executor) => {
    const hit = cache.get(executor);
    if (hit) return hit;
    const reasons: string[] = [];
    const resolved = resolveExecutable(executor, cfg.executors[executor].command, env);
    let available = true;
    if (!resolved.ok) {
      available = false;
      reasons.push(resolved.reason);
    } else {
      const auth = checkAuth(executor, resolved, cfg, paths, env);
      const block = authBlockReason(auth);
      const inCodexSandbox = Boolean(env.CODEX_SANDBOX) || env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
      if (block && inCodexSandbox && (auth.method === "none" || auth.method === "unknown") && auth.conflicts.length === 0) {
        // Dentro do sandbox do Codex o status de outro cliente pode não ser legível (Keychain, rede); não é indisponibilidade.
        reasons.push("login não verificável dentro do sandbox do Codex; a ponte confere de novo ao delegar (fora do sandbox)");
      } else if (block) {
        available = false;
        reasons.push(block);
      }
    }
    const recent = latestTasks(store);
    const recentQuota = recent.find((t) => t.executor === executor && t.state === "blocked" && /cota|limit/i.test(t.outcome ?? ""));
    const rl = recent.find((t) => t.executor === executor && t.metrics?.native.rateLimit)?.metrics?.native.rateLimit;
    if (rl && rl.status && !["allowed", "allowed_warning"].includes(rl.status) && rl.resetsAt && Date.parse(rl.resetsAt) > Date.now()) {
      available = false;
      reasons.push(`limite ${rl.rateLimitType ?? ""} observado como ${rl.status} até ${rl.resetsAt}`);
    } else if (recentQuota && Date.now() - Date.parse(recentQuota.updatedAt) < 60 * 60 * 1000) {
      reasons.push(`cota atingida há menos de 1 h (${recentQuota.taskId}); pode ainda estar em cooldown`);
    }
    const res = { available, reasons };
    cache.set(executor, res);
    return res;
  };
}

function latestTasks(store: Store): Task[] {
  return store
    .listRuns()
    .flatMap((r) => store.listTasks(r))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const key = (p: Provider, m: string | null) => `${p}:${m ?? "(padrão)"}`;

/** Candidatos: catálogo real quando descoberto; senão, a lista de reserva da config. */
function candidatesFrom(cfg: DuoConfig, catalog: Catalog | null, needs: Capability[], defaults: Record<Provider, string | null>): { cands: Cand[]; filteredOut: string[] } {
  const cands: Cand[] = [];
  const filteredOut: string[] = [];
  for (const provider of ["claude", "codex"] as Provider[]) {
    const pc = catalog?.providers[provider];
    if (pc?.ok && pc.models.length) {
      const configured = cfg.executors[provider].model ?? defaults[provider];
      const def =
        (configured && pc.models.find((m) => m.id.toLowerCase() === configured.toLowerCase() || m.aliases.some((a) => a.toLowerCase() === configured.toLowerCase()))) ||
        pc.models.find((m) => m.vendorRecommended) ||
        null;
      for (const m of pc.models) cands.push({ executor: provider, model: m.id, names: [m.id, ...m.aliases].map((x) => x.toLowerCase()), info: m, isDefault: def?.id === m.id });
    } else {
      for (const c of cfg.routing.candidates.filter((x) => x.executor === provider)) {
        cands.push({ executor: provider, model: c.model, names: c.model ? [c.model.toLowerCase()] : [], info: null, isDefault: c.model === null });
      }
    }
  }
  const included = cands.filter((c) => {
    const k = key(c.executor, c.model);
    const names = c.names.map((n) => `${c.executor}:${n}`);
    if (cfg.routing.exclude.some((x) => names.includes(x.toLowerCase()) || x === k)) return false;
    if (cfg.routing.include && !cfg.routing.include.some((x) => names.includes(x.toLowerCase()) || x === k)) return false;
    return true;
  });
  const capable = included.filter((c) => {
    // Sem catálogo, só sabemos que o Claude Code não gera imagem raster.
    const caps: Capability[] = c.info ? c.info.capabilities : c.executor === "claude" ? ["code"] : ["code", "image_generation"];
    const ok = needs.every((n) => caps.includes(n));
    if (!ok) filteredOut.push(`${key(c.executor, c.model)} (sem ${needs.filter((n) => !caps.includes(n)).join(", ")})`);
    return ok;
  });
  return { cands: capable, filteredOut };
}

export function evaluateCandidates(
  store: Store,
  cfg: DuoConfig,
  q: RouteQuery,
  availability: AvailabilityFn,
  catalog: Catalog | null = null,
  defaults: Record<Provider, string | null> = { claude: null, codex: null },
): { evals: CandidateEval[]; filteredOut: string[] } {
  const tasks = store.listRuns().flatMap((r) => store.listTasks(r));
  const min = cfg.routing.minSamples;
  const needs = q.needs ?? [];
  const { cands, filteredOut } = candidatesFrom(cfg, catalog, needs, defaults);
  const evals: CandidateEval[] = cands.map((cand) => {
    const ev = evidenceFor(tasks, cand, q, min);
    const av = availability(cand.executor);
    const priors = cfg.routing.priors.filter(
      (p) =>
        p.executor === cand.executor &&
        (p.model === undefined || (p.model === null ? cand.model === null : cand.names.includes(p.model.toLowerCase()))) &&
        (!p.kind || p.kind === q.kind) &&
        (!p.tag || q.tags.includes(p.tag)) &&
        (!p.needs || needs.includes(p.needs as Capability)),
    );
    const bonus = Math.max(-0.2, Math.min(0.2, priors.reduce((s, p) => s + p.bonus, 0)));
    const vendor = { recommended: cand.info?.vendorRecommended ?? false, legacy: cand.info?.legacy ?? false };
    const reasons: string[] = [];
    let score = ev.successRate + bonus;
    if (ev.n) {
      score -= 0.15 * (ev.overclaims / ev.n);
      if (ev.overclaims) reasons.push(`${ev.overclaims} vez(es) declarou sucesso e a verificação reprovou`);
      if (ev.rejectedByBrain) reasons.push(`${ev.rejectedByBrain} entrega(s) rejeitada(s) pelo cérebro`);
    }
    // Sinais do próprio fornecedor: pesam pouco e nunca superam evidência medida.
    if (vendor.recommended) {
      score += 0.05;
      reasons.push("recomendado pelo próprio fornecedor (+0,05)");
    }
    if (vendor.legacy) {
      score -= 0.1;
      reasons.push("marcado como legado pelo fornecedor (−0,1)");
    }
    const preserved = cfg.quotaPreference === "preserve-codex" ? "codex" : cfg.quotaPreference === "preserve-claude" ? "claude" : null;
    if (preserved === cand.executor) {
      score -= 0.1;
      reasons.push(`quotaPreference=${cfg.quotaPreference} (−0,1)`);
    }
    reasons.unshift(ev.n ? `${ev.successes}/${ev.n} sucessos verificados em ${ev.bucket}${ev.sufficient ? "" : " (evidência insuficiente)"}` : "sem histórico comparável neste projeto");
    if (bonus) reasons.push(`preferência declarada: ${priors.map((p) => p.note).join("; ")} (${bonus > 0 ? "+" : ""}${bonus})`);
    return {
      executor: cand.executor,
      model: cand.model,
      displayName: cand.info?.displayName ?? null,
      available: av.available,
      availability: av.reasons,
      evidence: ev,
      prior: { bonus, notes: priors.map((p) => p.note) },
      vendor,
      score: Math.round(score * 1000) / 1000,
      reasons,
    };
  });

  return { evals, filteredOut };
}

function recommendResult(
  store: Store, cfg: DuoConfig, q: RouteQuery, availability: AvailabilityFn,
  catalog: Catalog | null = null, defaults: Record<Provider, string | null> = { claude: null, codex: null },
): Recommendation {
  const min = cfg.routing.minSamples;
  const needs = q.needs ?? [];
  const { evals, filteredOut } = evaluateCandidates(store, cfg, q, availability, catalog, defaults);
  const assessment = assessComplexity(q, q.paths ?? [], q.tags, cfg.routing.adaptive.lightMaxFiles);
  const adaptive = cfg.routing.adaptive.enabled;
  const capableOnly = q.kind === "asset" || needs.includes("image_generation");
  const selections = (["claude", "codex"] as const).flatMap((provider) => {
    const selected = selectModel(catalog, cfg, provider, assessment.tier, { candidates: evals, floor: assessment.floor, needs });
    return selected ? [{ executor: provider, ...selected }] : [];
  });
  const hasTarget = selections.some((m) => tierRank(m.tier) <= tierRank(assessment.tier) && evals.some((e) => e.available && e.executor === m.executor && e.model === m.model));
  let eligible = evals;
  if (adaptive && catalog) {
    eligible = evals.filter((c) => {
      const pc = catalog.providers[c.executor];
      if (!pc.ok || pc.stale) return true; // Fonte indisponível mantém a reserva da 0.2.0.
      const model = pc.models.find((m) => m.id === c.model);
      return model && automaticModelAllowed(model, cfg) && (capableOnly || selections.some((m) => m.executor === c.executor && m.model === c.model && (!hasTarget || tierRank(m.tier) <= tierRank(assessment.tier) || c.evidence.sufficient)));
    });
  }
  // Disponível primeiro; depois score; empate técnico (< 0,05) desempata pelo menor tempo mediano medido.
  evals.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (adaptive && a.executor === b.executor && Math.abs(a.score - b.score) < 0.0001) {
      const models = catalog?.providers[a.executor].models ?? [];
      const ma = models.find((m) => m.id === a.model), mb = models.find((m) => m.id === b.model);
      if (ma && mb) { const version = compareModelVersions(mb, ma); if (version) return version; }
    }
    if (Math.abs(a.score - b.score) >= 0.05) return b.score - a.score;
    return (a.evidence.medianWallMs ?? Number.MAX_SAFE_INTEGER) - (b.evidence.medianWallMs ?? Number.MAX_SAFE_INTEGER) || b.score - a.score;
  });

  const notes = [
    "Evidência = tarefas deste projeto com verificação independente da ponte (aceite, escopo, decisão do cérebro). Falhas de login, cota ou timeout não contam contra o modelo.",
    "Nenhum fornecedor é preferido por padrão; sinais do fornecedor (recomendado/legado) e preferências declaradas (routing.priors) têm peso pequeno e identificado.",
    catalog
      ? `Catálogo das contas descoberto em ${catalog.discoveredAt} (duo models --refresh atualiza): ${(["claude", "codex"] as Provider[]).map((p) => `${p} ${catalog.providers[p] ? describeSource(catalog.providers[p]) : "ausente"}`).join(" · ")}.`
      : "Catálogo das contas indisponível: usando routing.candidates da config.",
  ];
  if (filteredOut.length) notes.push(`Excluídos por não terem a capacidade exigida: ${filteredOut.join(", ")}`);
  const available = evals.filter((e) => e.available && eligible.includes(e));
  const best = available[0];
  const pc = best ? catalog?.providers[best.executor] : null;
  const info = pc?.ok && !pc.stale ? pc.models.find((m) => m.id === best?.model) : null;
  const selected = selections.find((m) => m.executor === best?.executor && m.model === best?.model);
  const selection: Selection | undefined = adaptive ? {
    adaptive: true, tier: info ? tierOf(info, cfg).tier : assessment.tier, complexitySignals: assessment.signals,
    model: info?.id ?? null, effort: info ? selectEffort(tierOf(info, cfg).tier, info) : null,
    reason: capableOnly && info ? ["capacidade exigida: nível não filtra modelos"] : selected?.reason ?? ["catálogo/candidato indisponível: sem seleção automática de modelo ou esforço"],
    attempt: 1, attemptOf: null,
  } : undefined;
  const base = { query: q, candidates: evals, notes, ...(selection ? { selection } : {}) };
  if (!best) {
    const why = needs.length ? [`nenhum modelo disponível com ${needs.join(", ")}`] : ["nenhum candidato disponível para delegar"];
    const canSelf = q.brain !== null && needs.every((n) => n === "code");
    return {
      ...base,
      decision: {
        action: canSelf ? "self" : "judgment",
        executor: canSelf ? q.brain : null,
        model: null,
        confidence: "baixa",
        why: [...why, ...[...new Set(evals.flatMap((e) => e.availability.map((r) => `${e.executor}: ${r}`)))]],
      },
      explore: null,
    };
  }
  const second = available.find((e) => e.executor !== best.executor || e.model !== best.model);
  const why = [`melhor candidato: ${label(best)} (score ${best.score}; ${best.reasons[0]})`];
  if (second) why.push(`alternativa: ${label(second)} (score ${second.score}; ${second.reasons[0]})`);
  const providersLeft = new Set(available.map((e) => e.executor));

  let confidence: Decision["confidence"];
  if (best.evidence.sufficient) {
    const gap = second ? best.score - second.score : 1;
    confidence = best.evidence.n >= 2 * min && (gap >= 0.1 || !second?.evidence.sufficient) ? "alta" : "média";
  } else if (needs.some((n) => n !== "code") && providersLeft.size === 1) {
    // A capacidade exigida deixou um único fornecedor: vale a recomendação do próprio fornecedor.
    confidence = "média";
    why.unshift(`só ${best.executor} oferece ${needs.filter((n) => n !== "code").join(", ")} entre as contas conectadas; modelo escolhido pelos sinais do fornecedor`);
  } else {
    const leastSampled = [...available].sort((a, b) => a.evidence.n - b.evidence.n)[0] as CandidateEval;
    const tops = [...providersLeft].map((p) => available.find((e) => e.executor === p) as CandidateEval);
    return {
      ...base,
      decision: {
        action: "judgment",
        executor: null,
        model: null,
        confidence: "baixa",
        why: [`evidência insuficiente (mínimo ${min} tarefas comparáveis)`, `melhores de cada conta: ${tops.map((t) => label(t)).join(" · ")}`, ...why],
      },
      explore:
        q.risk === "low"
          ? `baixo risco: delegar a ${label(leastSampled)} gera evidência para decisões futuras`
          : "risco médio/alto sem evidência: decida pelo guia de decisão; em alto risco, implemente com quem você confia mais e peça revisão cruzada ao outro",
    };
  }

  // Mesmo fornecedor do cérebro: fazer você mesmo se for o seu modelo; senão delegar ao outro modelo do mesmo fornecedor.
  if (q.brain && best.executor === q.brain) {
    const sameAsBrain = q.brainModel ? namesOf(best, catalog).includes(q.brainModel.toLowerCase()) : null;
    if (sameAsBrain !== false) {
      return {
        ...base,
        decision: {
          action: "self",
          executor: q.brain,
          model: best.model,
          confidence,
          why: [
            sameAsBrain === true
              ? `o melhor candidato é você mesmo (${best.model}): faça sem delegar`
              : `o melhor candidato é do seu cliente (${label(best)}); se você já é esse modelo, faça sem delegar; se não, delegue ao ${q.brain} com model=${best.model}`,
            ...why,
          ],
        },
        explore: null,
      };
    }
  }
  return {
    ...base,
    decision: { action: "delegate", executor: best.executor, model: best.model, confidence, why: [`delegue a ${label(best)}: melhor opção disponível para esta tarefa`, ...why] },
    explore: null,
  };
}

export function recommend(
  store: Store, cfg: DuoConfig, q: RouteQuery, availability: AvailabilityFn,
  catalog: Catalog | null = null, defaults: Record<Provider, string | null> = { claude: null, codex: null },
): Recommendation {
  const r = recommendResult(store, cfg, q, availability, catalog, defaults);
  if (!cfg.routing.adaptive.enabled) return r;
  const assessment = assessComplexity(q, q.paths ?? [], q.tags, cfg.routing.adaptive.lightMaxFiles);
  const selection = r.selection!;
  const best = r.candidates.find((c) => c.available && c.model === selection.model && c.model !== null);
  const tier = selection.tier;
  r.decision.tier = assessment.tier;
  r.decision.effort = selection.effort;
  r.decision.why.push(...selection.reason);
  const brainInfo = q.brain && q.brainModel ? catalog?.providers[q.brain].models.find((m) => [m.id, ...m.aliases].includes(q.brainModel as string)) : null;
  if (best && brainInfo && tierRank(tierOf(brainInfo, cfg).tier) > tierRank(tier)) {
    r.decision = { ...r.decision, action: "delegate", executor: best.executor, model: best.model };
    r.decision.why.unshift("economiza a cota do seu modelo; se for trivial (uma linha), faça direto");
  }
  return r;
}

function namesOf(e: CandidateEval, catalog: Catalog | null): string[] {
  const info = e.model ? catalog?.providers[e.executor]?.models.find((m) => m.id === e.model) : null;
  return [e.model ?? "", ...(info?.aliases ?? [])].filter(Boolean).map((x) => x.toLowerCase());
}

function label(c: { executor: Provider; model: string | null; displayName?: string | null }): string {
  return `${c.executor}/${c.model ?? "(modelo padrão)"}${c.displayName && c.displayName !== c.model ? ` (${c.displayName})` : ""}`;
}

export function formatRecommendation(r: Recommendation, maxCandidates = 8): string {
  const lines: string[] = [];
  const d = r.decision;
  const head =
    d.action === "delegate"
      ? `DELEGAR a ${d.executor}${d.model ? ` com model=${d.model}` : ""}`
      : d.action === "self"
        ? `FAZER VOCÊ MESMO (${d.executor}${d.model ? `, ${d.model}` : ""})`
        : "DECIDIR POR JULGAMENTO (evidência insuficiente)";
  lines.push(`Recomendação: ${head} — confiança ${d.confidence}`);
  lines.push(
    `Tarefa: kind=${r.query.kind} needs=${(r.query.needs ?? []).join(",") || "-"} tags=${r.query.tags.join(",") || "-"} risco=${r.query.risk} cérebro=${r.query.brain ?? "?"}${r.query.brainModel ? `/${r.query.brainModel}` : ""}`,
  );
  if (r.selection) lines.push(`Nível-alvo: ${d.tier}; modelo sugerido=${r.selection.model ?? "padrão"}; esforço=${d.effort ?? "padrão"}`, `Sinais: ${r.selection.complexitySignals.join(" · ")}`);
  for (const w of d.why) lines.push(`  • ${w}`);
  if (r.explore) lines.push(`  → exploração: ${r.explore}`);
  lines.push(`Candidatos (${r.candidates.length}):`);
  const shownAvailability = new Set<string>();
  for (const c of r.candidates.slice(0, maxCandidates)) {
    lines.push(`  ${c.available ? " " : "✗"} ${label(c)} score=${c.score} n=${c.evidence.n} tempo mediano=${c.evidence.medianWallMs === null ? "?" : `${Math.round(c.evidence.medianWallMs / 1000)}s`}`);
    for (const x of c.reasons.slice(1)) lines.push(`      - ${x}`);
    for (const x of c.availability) {
      if (shownAvailability.has(`${c.executor}:${x}`)) continue;
      shownAvailability.add(`${c.executor}:${x}`);
      lines.push(`      - [${c.executor}] ${x}`);
    }
  }
  if (r.candidates.length > maxCandidates) lines.push(`  … mais ${r.candidates.length - maxCandidates} (use --json para ver todos)`);
  for (const n of r.notes.slice(2)) lines.push(`nota: ${n}`);
  return lines.join("\n");
}
