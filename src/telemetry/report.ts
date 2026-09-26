// Relatório determinístico (sem IA). Cada número indica sua origem: native, local-measure, local-estimate, manual ou unavailable.
import { join } from "node:path";
import type { Provider } from "../config.js";
import { readJson, Store, writeJsonAtomic } from "../state/store.js";
import type { Run, Task } from "../state/types.js";

export type QuotaEntry = {
  provider: Provider;
  usedPercent: number | null;
  resetsAt: string | null;
  note: string;
  source: "manual";
  recordedAt: string;
};

const QUOTA_TTL_MS = 24 * 60 * 60 * 1000;

export function quotaPath(store: Store): string {
  return join(store.base, "quota.json");
}

export function setQuota(store: Store, entry: Omit<QuotaEntry, "source" | "recordedAt">): QuotaEntry {
  const all = readJson<Record<string, QuotaEntry>>(quotaPath(store)) ?? {};
  const full: QuotaEntry = { ...entry, source: "manual", recordedAt: new Date().toISOString() };
  all[entry.provider] = full;
  writeJsonAtomic(quotaPath(store), all);
  return full;
}

/** Última observação nativa de limite emitida pelo cliente durante uma delegação (hoje só o Claude Code emite). */
function latestNativeObservation(store: Store, provider: Provider, now: number): Record<string, unknown> | null {
  let best: Task | null = null;
  for (const run of store.listRuns()) {
    for (const t of store.listTasks(run)) {
      if (t.executor !== provider || !t.metrics?.native.rateLimit) continue;
      if (!best || (best.metrics?.native.capturedAt ?? "") < t.metrics.native.capturedAt) best = t;
    }
  }
  const rl = best?.metrics?.native.rateLimit;
  if (!best || !rl) return null;
  const expired = rl.resetsAt !== null && Date.parse(rl.resetsAt) < now;
  return {
    source: "native",
    note: "rate_limit_event emitido pelo cliente no stream da última delegação (observado após a execução; campo não descrito na documentação consultada)",
    observedAt: best.metrics?.native.capturedAt,
    taskId: best.taskId,
    ...rl,
    status: expired ? "expirada (janela já resetou)" : `observada nativamente: ${rl.status ?? "?"}`,
  };
}

export function quotaView(store: Store, now = Date.now()): Record<Provider, Record<string, unknown>> {
  const all = readJson<Record<string, QuotaEntry>>(quotaPath(store)) ?? {};
  const view = (p: Provider): Record<string, unknown> => {
    const native = latestNativeObservation(store, p, now);
    const e = all[p];
    const manual = e
      ? { ...e, status: now - Date.parse(e.recordedAt) > QUOTA_TTL_MS || (e.resetsAt !== null && Date.parse(e.resetsAt) < now) ? "expirada" : "informada manualmente" }
      : null;
    if (!native && !manual) {
      return { status: "não disponível", source: "unavailable", note: "sem observação nativa nem registro manual; use duo quota set para registro manual" };
    }
    return { ...(native ?? manual ?? {}), ...(native && manual ? { manual } : {}) };
  };
  return { claude: view("claude"), codex: view("codex") };
}

type ProviderAgg = {
  tasks: number;
  succeeded: number;
  failed: number;
  blocked: number;
  cancelled: number;
  accepted: number;
  rejected: number;
  retries: number;
  acceptanceRan: number;
  acceptancePassed: number;
  claimedSuccessButFailed: number;
  wallMsTotal: number;
  nativeUsageTotals: Record<string, number>;
  tasksWithNativeUsage: number;
  costUsdClientEstimateTotal: number | null;
};

function emptyAgg(): ProviderAgg {
  return {
    tasks: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    accepted: 0,
    rejected: 0,
    retries: 0,
    acceptanceRan: 0,
    acceptancePassed: 0,
    claimedSuccessButFailed: 0,
    wallMsTotal: 0,
    nativeUsageTotals: {},
    tasksWithNativeUsage: 0,
    costUsdClientEstimateTotal: null,
  };
}

export function buildReport(store: Store, runId?: string): Record<string, unknown> {
  const runs = store.listRuns().filter((r) => !runId || r.runId === runId);
  const byExecutor: Record<Provider, ProviderAgg> = { claude: emptyAgg(), codex: emptyAgg() };
  const runSummaries: Record<string, unknown>[] = [];
  for (const run of runs) {
    const tasks = store.listTasks(run);
    runSummaries.push(runSummary(run, tasks));
    for (const t of tasks) {
      const a = byExecutor[t.executor];
      a.tasks++;
      if (t.state === "succeeded") a.succeeded++;
      if (t.state === "failed") a.failed++;
      if (t.state === "blocked") a.blocked++;
      if (t.state === "cancelled") a.cancelled++;
      if (t.accepted?.accepted === true) a.accepted++;
      if (t.accepted?.accepted === false) a.rejected++;
      if (t.retryOf || t.invocations > 1) a.retries++;
      const acc = t.verification?.acceptance ?? [];
      a.acceptanceRan += acc.filter((x) => x.ran).length;
      a.acceptancePassed += acc.filter((x) => x.passed).length;
      if (t.executorReport?.status === "completed" && t.state === "failed") a.claimedSuccessButFailed++;
      if (t.metrics) {
        a.wallMsTotal += t.metrics.wallMs;
        const u = t.metrics.native.usage;
        if (u) {
          a.tasksWithNativeUsage++;
          for (const [k, v] of Object.entries(u)) a.nativeUsageTotals[k] = (a.nativeUsageTotals[k] ?? 0) + v;
        }
        const c = t.metrics.native.costUsdClientEstimate;
        if (typeof c === "number") a.costUsdClientEstimateTotal = (a.costUsdClientEstimateTotal ?? 0) + c;
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    scope: runId ?? "todos os runs",
    notes: [
      "Uso de tokens: 'native' = informado pela CLI do executor, no esquema do próprio fornecedor. Os fornecedores não são somados entre si.",
      "costUsdClientEstimate (Claude) é estimativa do cliente; com login de assinatura não representa cobrança nem saldo da assinatura.",
      "Cotas de assinatura não são inferidas a partir de tokens. Aparecem como observação nativa do cliente (quando emitida no stream), registro manual ou 'não disponível'.",
      "Economia só pode ser afirmada comparando com um fluxo de agente único em tarefas equivalentes (docs/avaliacao.md).",
    ],
    byExecutor,
    quota: quotaView(store),
    runs: runSummaries,
  };
}

function runSummary(run: Run, tasks: Task[]): Record<string, unknown> {
  return {
    runId: run.runId,
    brain: run.brain,
    policy: run.policy,
    cancelled: run.cancelled,
    invocations: run.invocations,
    createdAt: run.createdAt,
    decisions: run.decisions,
    nextStep: run.nextStep,
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      executor: t.executor,
      kind: t.kind,
      state: t.state,
      outcome: t.outcome,
      invocations: t.invocations,
      filesChanged: t.verification?.filesChangedActual.length ?? 0,
      acceptance: (t.verification?.acceptance ?? []).map((a) => `${a.name}:${a.passed ? "ok" : a.ran ? "falhou" : "não executado"}`),
      model: t.model,
      wallMs: t.metrics?.wallMs ?? null,
      accepted: t.accepted?.accepted ?? null,
    })),
  };
}

export function formatReportText(r: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Relatório duo — ${String(r.scope)} — ${String(r.generatedAt)}`);
  const byEx = r.byExecutor as Record<string, ProviderAgg>;
  for (const [p, a] of Object.entries(byEx)) {
    if (!a.tasks) {
      lines.push(`\n[${p}] nenhuma delegação`);
      continue;
    }
    lines.push(`\n[${p}] tasks=${a.tasks} ok=${a.succeeded} falhas=${a.failed} bloqueadas=${a.blocked} canceladas=${a.cancelled}`);
    lines.push(`  aceitas=${a.accepted} rejeitadas=${a.rejected} retrabalho=${a.retries} "completed" desmentido pela verificação=${a.claimedSuccessButFailed}`);
    lines.push(`  aceite executado=${a.acceptanceRan} aprovado=${a.acceptancePassed} tempo total=${Math.round(a.wallMsTotal / 1000)}s (local-measure)`);
    lines.push(
      `  uso nativo (${a.tasksWithNativeUsage}/${a.tasks} tasks com dado): ${Object.keys(a.nativeUsageTotals).length ? JSON.stringify(a.nativeUsageTotals) : "não disponível"}`,
    );
    if (a.costUsdClientEstimateTotal !== null) lines.push(`  estimativa de custo do cliente: US$ ${a.costUsdClientEstimateTotal.toFixed(4)} (não é cobrança da assinatura)`);
  }
  const quota = r.quota as Record<string, Record<string, unknown>>;
  lines.push("\nCotas:");
  for (const [p, q] of Object.entries(quota)) {
    const extra = q.source === "native" ? ` — janela ${String(q.rateLimitType ?? "?")} — uso extra: ${q.isUsingOverage === true ? "EM USO" : q.isUsingOverage === false ? "não usado" : "?"} (overageStatus=${String(q.overageStatus ?? "?")}) — observado ${String(q.observedAt)}` : "";
    lines.push(`  ${p}: ${String(q.status)}${q.usedPercent != null ? ` — ${String(q.usedPercent)}% usado` : ""}${q.resetsAt ? ` — reset ${String(q.resetsAt)}` : ""}${q.recordedAt ? ` (registrado ${String(q.recordedAt)})` : ""}${extra}`);
  }
  lines.push("\nObservações:");
  for (const n of r.notes as string[]) lines.push(`  - ${n}`);
  return lines.join("\n");
}
