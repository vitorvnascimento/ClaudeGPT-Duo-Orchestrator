// Alternativas entre as três contas (fallback de cota/capacidade).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, type DuoConfig } from "../src/config.js";
import { alternateProviders, executorEligible } from "../src/orchestration/alternates.js";

const V = [{ version: "1.5.3", platform: "darwin" as const }];
function cfg(enabled: boolean): DuoConfig { const c = structuredClone(DEFAULT_CONFIG); c.executors.gemini.enabled = enabled; return c; }
const ctx = (over: Partial<Parameters<typeof executorEligible>[1]> = {}) => ({ kind: "implement" as const, fixedIsolation: null, cfg: cfg(true), platform: "darwin" as const, verified: V, ...over });

describe("alternativas", () => {
  it("gemini disabled → behaviour identical to v0.4.0", () => {
    assert.deepEqual(alternateProviders("claude", ctx({ cfg: cfg(false) }), { sameFirst: false }), ["codex"]);
    assert.deepEqual(alternateProviders("codex", ctx({ cfg: cfg(false) }), { sameFirst: true }), ["codex", "claude"]);
  });
  it("enabled and verified: order is claude, codex, gemini (gemini last)", () => {
    assert.deepEqual(alternateProviders("claude", ctx(), { sameFirst: false }), ["codex", "gemini"]);
    assert.deepEqual(alternateProviders("codex", ctx(), { sameFirst: false }), ["claude", "gemini"]);
    assert.deepEqual(alternateProviders("gemini", ctx(), { sameFirst: true }), ["gemini", "claude", "codex"]);
  });
  it("no in-place chain falls to gemini (write or review)", () => {
    assert.deepEqual(alternateProviders("codex", ctx({ fixedIsolation: "in-place" }), { sameFirst: false }), ["claude"]);
    assert.deepEqual(alternateProviders("codex", ctx({ fixedIsolation: "in-place", kind: "review" }), { sameFirst: false }), ["claude"]);
    assert.deepEqual(alternateProviders("codex", ctx({ fixedIsolation: "worktree", kind: "review" }), { sameFirst: false }), ["claude", "gemini"]);
  });
  it("unverified version or non-darwin platform excludes gemini", () => {
    assert.equal(executorEligible("gemini", ctx({ verified: [] })), false);
    assert.equal(executorEligible("gemini", ctx({ platform: "linux" })), false);
    assert.equal(executorEligible("claude", ctx({ platform: "linux" })), true);
  });
});

describe("escolha da alternativa", () => {
  it("same account first when it has a model; otherwise best score, provider order on ties", async () => {
    const { pickAlternate } = await import("../src/orchestration/alternates.js");
    const sel = (m: string) => ({ model: m, effort: null, tier: "standard" as const, reason: [] });
    const select = (p: string) => ({ claude: sel("c"), codex: sel("x"), gemini: sel("g") } as Record<string, ReturnType<typeof sel>>)[p] ?? null;
    assert.equal(pickAlternate(["codex", "claude", "gemini"], true, select, () => 0)?.executor, "codex");
    const scores: Record<string, number> = { claude: 0.6, gemini: 0.8 };
    assert.equal(pickAlternate(["claude", "gemini"], false, select, (p) => scores[p] ?? -1)?.executor, "gemini");
    assert.equal(pickAlternate(["claude", "gemini"], false, select, () => 0.5)?.executor, "claude");
    assert.equal(pickAlternate(["claude", "gemini"], false, (p) => (p === "gemini" ? sel("g") : null), () => 0)?.executor, "gemini");
    assert.equal(pickAlternate(["claude"], false, () => null, () => 0), null);
  });
});
