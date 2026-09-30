// Metadados para o roteamento futuro; não escolhe nem troca executores.
import type { DuoConfig } from "../config.js";
import type { ModelInfo } from "./catalog.js";

export type Tier = "light" | "standard" | "deep";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof EFFORTS[number];

export function tierOf(model: ModelInfo, cfg: DuoConfig): { tier: Tier; presumed: boolean } {
  const names = [model.id, ...model.aliases, model.displayName];
  for (const rule of cfg.routing.adaptive.tiers) {
    if (names.some((name) => new RegExp(rule.match, "i").test(name))) return { tier: rule.tier, presumed: false };
  }
  for (const [family, tier] of [["opus|fable|astra", "deep"], ["sonnet|sol|terra", "standard"], ["haiku|luna|mini|nano", "light"]] as const) {
    if (names.some((name) => new RegExp(`(?:^|[^a-z0-9])(?:${family})(?:$|[^a-z0-9])`, "i").test(name))) return { tier, presumed: false };
  }
  return { tier: "standard", presumed: true };
}

/** Comparação numérica só dentro da mesma família; data e contexto não são versão. */
export function compareModelVersions(a: string | ModelInfo, b: string | ModelInfo): number {
  const parts = (model: string | ModelInfo) => {
    const id = (typeof model === "string" ? model : model.id).toLowerCase().replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
    const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z]+))?$/.exec(id);
    const claude = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id);
    if (gpt) return { family: `gpt-${gpt[2] ?? ""}`, version: (gpt[1] as string).split(".").map(Number) };
    if (claude) return { family: `claude-${claude[1]}`, version: (claude[2] as string).split("-").map(Number) };
    return null;
  };
  const pa = parts(a), pb = parts(b);
  if (!pa || !pb || pa.family !== pb.family) return 0;
  for (let i = 0; i < Math.max(pa.version.length, pb.version.length); i++) {
    const diff = (pa.version[i] ?? 0) - (pb.version[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export function extraUsage(model: ModelInfo): boolean {
  return /\[1m\]$/i.test(model.id) || /usage credits|per\s+Mtok|\$\s*\d+(?:[.,]\d+)?/i.test(model.description);
}

export function selectEffort(tier: Tier, model: ModelInfo, opts: { escalateToMax?: boolean } = {}): Effort | null {
  const desired = opts.escalateToMax ? "xhigh" : ({ light: "low", standard: "medium", deep: "high" } as const)[tier];
  return EFFORTS.slice(EFFORTS.indexOf(desired)).find((effort) => model.efforts.includes(effort)) ?? null;
}
