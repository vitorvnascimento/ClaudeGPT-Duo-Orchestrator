import { join } from "node:path";
import type { ModelInfo } from "../adapters/catalog.js";
import type { ParsedOutcome } from "../adapters/types.js";
import type { Provider } from "../config.js";
import { readJson, type Store, writeJsonAtomic } from "../state/store.js";

export type QuotaState = {
  status: "ok" | "warning" | "exhausted" | "unknown";
  usedPercent: number | null;
  resetsAt: string | null;
  observedAt: string;
  source: "codex-rate-limits" | "claude-rate-limit-event" | "task-error" | "manual";
  affectedModels: string[] | null;
};
const TTL = 6 * 60 * 60 * 1000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const quotaStatePath = (store: Store): string => join(store.base, "quota-state.json");
const iso = (v: unknown): string | null => {
  const ms = typeof v === "number" ? v * 1000 : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
};
export function quotaStatus(used: number | null, warn: number): QuotaState["status"] {
  return used === null ? "unknown" : used >= 100 ? "exhausted" : used >= warn ? "warning" : "ok";
}
export function quotaStates(store: Store, now = Date.now()): Partial<Record<Provider, QuotaState>> {
  const saved = readJson<Partial<Record<Provider, QuotaState>>>(quotaStatePath(store)) ?? {};
  const states: Partial<Record<Provider, QuotaState>> = {};
  for (const p of ["claude", "codex"] as const) {
    const s = saved[p];
    if (!s) continue;
    const expired = s.resetsAt ? Date.parse(s.resetsAt) <= now : now - Date.parse(s.observedAt) > TTL;
    states[p] = expired ? { ...s, status: "unknown", usedPercent: null, affectedModels: null } : s;
  }
  return states;
}
export function saveQuota(store: Store, provider: Provider, state: QuotaState): void {
  // Lista fechada: nenhum campo de conta, plano, créditos ou credencial chega ao disco.
  const safe: QuotaState = { status: state.status, usedPercent: state.usedPercent, resetsAt: state.resetsAt,
    observedAt: state.observedAt, source: state.source, affectedModels: state.affectedModels };
  writeJsonAtomic(quotaStatePath(store), { ...quotaStates(store), [provider]: safe });
}

/** Lê somente janelas, reachedType, slug e admissão geral. Todo o resto é descartado. */
export function parseCodexQuota(raw: unknown, models: ModelInfo[], warn = 90, now = Date.now()): QuotaState | null {
  if (!object(raw) || ![true, false, null, undefined].includes(raw.ordinaryUsageAllowed as boolean | null | undefined)
    || !object(raw.rateLimitsByLimitId)) return null;
  const limits: { status: QuotaState["status"]; used: number | null; reset: string | null; model: string | null }[] = [];
  for (const value of Object.values(raw.rateLimitsByLimitId)) {
    if (!object(value)) return null;
    const windows: { used: number; reset: string | null }[] = [];
    for (const key of ["primary", "secondary"]) {
      const w = value[key];
      if (w === null || w === undefined) continue;
      if (!object(w) || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0
        || (w.resetsAt != null && (typeof w.resetsAt !== "number" || !iso(w.resetsAt)))) return null;
      windows.push({ used: w.usedPercent, reset: iso(w.resetsAt) });
    }
    if (value.rateLimitReachedType != null && typeof value.rateLimitReachedType !== "string") return null;
    if (value.normalModelSlug != null && typeof value.normalModelSlug !== "string") return null;
    const used = windows.length ? Math.max(...windows.map((w) => w.used)) : null;
    const status = value.rateLimitReachedType != null ? "exhausted" : quotaStatus(used, warn);
    const relevant = windows.filter((w) => status === "exhausted" ? w.used >= 100 : w.used === used);
    const resets = (relevant.length ? relevant : windows).map((w) => w.reset);
    const matches = models.filter((m) => [m.id, ...m.aliases].includes(value.normalModelSlug as string));
    limits.push({ status, used, reset: resets.length && resets.every(Boolean) ? resets.sort().at(-1) ?? null : null,
      model: matches.length === 1 ? matches[0]!.id : null });
  }
  if (!limits.length && raw.ordinaryUsageAllowed !== false) return null;
  const exhausted = limits.filter((l) => l.status === "exhausted");
  const status = raw.ordinaryUsageAllowed === false || exhausted.length ? "exhausted"
    : limits.some((l) => l.status === "warning") ? "warning" : limits.some((l) => l.status === "ok") ? "ok" : "unknown";
  const relevant = exhausted.length ? exhausted : limits;
  const resets = relevant.map((l) => l.reset);
  const percentages = limits.flatMap((l) => l.used === null ? [] : [l.used]);
  return { status, usedPercent: percentages.length ? Math.max(...percentages) : null,
    resetsAt: resets.length && resets.every(Boolean) ? resets.sort().at(-1) ?? null : null,
    affectedModels: exhausted.length && raw.ordinaryUsageAllowed !== false && exhausted.every((l) => l.model)
      ? [...new Set(exhausted.map((l) => l.model!))] : null,
    observedAt: new Date(now).toISOString(), source: "codex-rate-limits" };
}

export function observeTaskQuota(store: Store, provider: Provider, outcome: ParsedOutcome, model: string | null = null): void {
  const previous = quotaStates(store)[provider];
  const rl = outcome.rateLimit;
  if (rl && provider === "claude") {
    saveQuota(store, provider, { status: rl.status === "allowed" ? "ok" : rl.status === "allowed_warning" ? "warning" : rl.status ? "exhausted" : "unknown",
      usedPercent: null, resetsAt: iso(rl.resetsAt), observedAt: new Date().toISOString(), source: "claude-rate-limit-event", affectedModels: null });
  }
  if (outcome.errorKind === "quota") {
    saveQuota(store, provider, { status: "exhausted", usedPercent: previous?.usedPercent ?? null,
      resetsAt: iso(rl?.resetsAt) ?? previous?.resetsAt ?? null, observedAt: new Date().toISOString(), source: "task-error",
      affectedModels: previous?.status === "exhausted" && (!previous.affectedModels || model && previous.affectedModels.includes(model)) ? previous.affectedModels : null });
  }
}

export function quotaBlock(state: QuotaState | undefined, model: string | null = null): string | null {
  return state?.status === "exhausted" && (!state.affectedModels || model !== null && state.affectedModels.includes(model))
    ? `cota esgotada até ${state.resetsAt ?? "reset desconhecido"}` : null;
}
