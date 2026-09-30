import type { Tier } from "../adapters/tiers.js";
import type { ScopeEntry } from "../permissions/scope.js";
import type { DelegationRequest } from "../state/types.js";

export const TIERS: readonly Tier[] = ["light", "standard", "deep"];
export const tierRank = (tier: Tier): number => TIERS.indexOf(tier);

/** Caminhos e tags sensíveis elevam o risco, inclusive ao autorizar um diretório. */
export function sensitiveScope(value: string): boolean {
  return /auth|security|seguran[cç]a|crypto|secret|token|password|migration|migra[cç][aã]o|payment|billing|\.github\/workflows|(?:^|\/)package-lock\.json$|(?:^|\/)pnpm-lock\.yaml$|(?:^|\/)yarn\.lock$|(?:^|[/.])sql$/i.test(value);
}

type ComplexityRequest = Pick<DelegationRequest, "kind"> & Partial<Pick<DelegationRequest, "objective" | "risk" | "acceptance" | "complexity">>;

export function assessComplexity(req: ComplexityRequest, scopeEntries: Pick<ScopeEntry, "rel" | "isDir">[], tags: string[], lightMaxFiles = 3): { tier: Tier; floor: Tier; signals: string[] } {
  const files = new Set(scopeEntries.filter((e) => !e.isDir).map((e) => e.rel)).size;
  const dirs = scopeEntries.filter((e) => e.isDir).length;
  const commands = req.acceptance?.commands?.length ?? 0;
  const criteria = req.acceptance?.criteria.length ?? 0;
  const sensitive = [...scopeEntries.map((e) => e.rel), ...tags].some(sensitiveScope);
  const risk = sensitive ? "high" : req.risk ?? "medium";
  const signals = [`kind=${req.kind}`, `risk=${risk}`, `arquivos=${files}; diretórios=${dirs}`, `critérios=${criteria}; comandos de aceite=${commands}`];
  if (sensitive) signals.push("escopo/tag sensível: piso deep");
  const lightSafe = risk === "low" && commands > 0 && files > 0 && files <= lightMaxFiles && dirs === 0;
  const floor: Tier = risk === "high" ? "deep" : lightSafe ? "light" : "standard";
  const objective = (req.objective ?? "").toLowerCase();
  let tier: Tier = lightSafe && objective.length > 0 && objective.length <= 400 && ["implement", "test"].includes(req.kind) && criteria <= 3 ? "light" : "standard";
  if (files > lightMaxFiles || dirs || criteria > 3) signals.push("escopo/aceite amplo: mínimo standard");
  const complex = /arquitetura|architecture|concorr[eê]ncia|concurrency|\brace\b|deadlock|seguran[cç]a|security|migra[cç][aã]o|migration|criptografia|crypto|protocolo|protocol|distribu[ií]do|distributed/.test(objective)
    || (/refator|refactor/.test(objective) && (files > 3 || dirs > 0))
    || (/performance|otimiza[cç][aã]o|optimization/.test(objective) && /hot[ -]?path|caminho cr[ií]tico/.test(objective));
  if (complex) { tier = "deep"; signals.push("objetivo exige raciocínio complexo: deep"); }
  if (req.complexity) { tier = req.complexity; signals.push(`complexity explícita=${tier}`); }
  if (tierRank(tier) < tierRank(floor)) tier = floor;
  // Palavras só elevam o nível, mesmo quando complexity foi informado.
  if (complex) tier = "deep";
  return { tier, floor, signals };
}
