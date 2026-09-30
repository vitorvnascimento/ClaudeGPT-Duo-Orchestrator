import type { Catalog, ModelInfo } from "../src/adapters/catalog.js";
import type { Provider } from "../src/config.js";

const model = (provider: Provider, id: string, recommended = false, legacy = false): ModelInfo => ({
  provider, id, aliases: [], displayName: id, description: id.includes("[1m]") ? "usage credits" : "",
  efforts: id.includes("haiku") ? [] : ["low", "medium", "high", "xhigh"], contextWindow: null,
  vendorRecommended: recommended, legacy, capabilities: provider === "codex" ? ["code", "image_generation"] : ["code"],
});
export const adaptiveCatalog: Catalog = {
  discoveredAt: "2026-09-29T00:00:00Z", cliVersions: { claude: "2.1.114", codex: "0.155.0" },
  providers: {
    claude: { ok: true, source: "test", tools: [], models: [model("claude", "claude-opus-5-5", true), model("claude", "claude-fable-5-1[1m]"), model("claude", "claude-sonnet-5-5"), model("claude", "claude-haiku-4-5-20251001")] },
    codex: { ok: true, source: "test", tools: ["image_generation"], models: [model("codex", "gpt-6-astra"), model("codex", "gpt-6.1-sol", true), model("codex", "gpt-6-sol"), model("codex", "gpt-6-luna"), model("codex", "gpt-5.6-sol", false, true), model("codex", "gpt-5.6-luna", false, true), model("codex", "gpt-5.6-astra", false, true), model("codex", "gpt-5.5", false, true)] },
  },
};
