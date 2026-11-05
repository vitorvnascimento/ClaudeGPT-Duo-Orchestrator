import { canonicalAppId } from "../adapters/computer-use-evidence.js";

type ComputerUseRequest = { needs?: readonly string[]; apps?: unknown; executor: string };

export function computerUseBlockReason(req: ComputerUseRequest, enabled: boolean, platform: string = process.platform): string | null {
  if (!req.needs?.includes("computer_use")) return req.apps !== undefined ? 'apps exige needs incluindo "computer_use"' : null;
  if (!enabled) return "computer use exige computerUse.enabled=true";
  if (req.executor !== "codex") return "computer use exige executor codex";
  if (platform !== "darwin") return "computer use ainda não validado nesta plataforma; suporte planejado somente para macOS";
  if (req.needs.includes("image_generation")) return "computer use não pode combinar image_generation na mesma invocação";
  if (req.apps !== undefined && (!Array.isArray(req.apps) || req.apps.length > 20 ||
      req.apps.some((app) => typeof app !== "string" || !canonicalAppId(app)))) {
    return "computer use exige apps válidos, com até 20 nomes";
  }
  return null;
}
