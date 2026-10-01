import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ModelInfo } from "../src/adapters/catalog.js";
import { compareModelVersions, extraUsage, selectEffort, tierOf, type Tier } from "../src/adapters/tiers.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const model = (id: string, patch: Partial<ModelInfo> = {}): ModelInfo => ({ provider: id.startsWith("claude") ? "claude" : "codex", id, aliases: [], displayName: id, description: "", efforts: [], contextWindow: null, vendorRecommended: false, legacy: false, capabilities: ["code"], ...patch });

describe("nível por família e configuração", () => {
  for (const [id, tier, extra] of [
    ["claude-opus-5-5", "deep", false], ["claude-opus-5-5[1m]", "deep", true],
    ["claude-fable-5-1[1m]", "deep", true], ["claude-sonnet-5-5", "standard", false],
    ["claude-haiku-4-5-20251001", "light", false], ["gpt-6.1-sol", "standard", false],
    ["gpt-6-astra", "deep", false], ["gpt-6-sol", "standard", false], ["gpt-6-luna", "light", false],
    ["gpt-5.6-sol", "standard", false], ["gpt-5.6-terra", "standard", false], ["gpt-5.6-luna", "light", false],
    ["gpt-5.5", "standard", false], ["foo-bar", "standard", false], ["gpt-6-mini", "light", false], ["gpt-6-nano", "light", false],
  ] as const) {
    it(id, () => {
      assert.deepEqual(tierOf(model(id), DEFAULT_CONFIG), { tier, presumed: id === "foo-bar" || id === "gpt-5.5" });
      assert.equal(extraUsage(model(id)), extra);
    });
  }
  it("regras em ordem, sem distinguir caixa, aplicadas a id, aliases e nome", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.routing.adaptive.tiers = [{ match: "custom", tier: "light" }, { match: "opus", tier: "standard" }];
    for (const patch of [{ id: "CUSTOM" }, { aliases: ["CUSTOM"] }, { displayName: "CUSTOM" }]) {
      assert.deepEqual(tierOf(model("claude-opus-5-5", patch), cfg), { tier: "light", presumed: false });
    }
    assert.deepEqual(tierOf(model("claude-opus-5-5"), cfg), { tier: "standard", presumed: false });
    assert.deepEqual(tierOf(model("foo", { aliases: ["Sonnet"] }), DEFAULT_CONFIG), { tier: "standard", presumed: false });
    assert.deepEqual(tierOf(model("foo", { displayName: "Haiku 4.5" }), DEFAULT_CONFIG), { tier: "light", presumed: false });
    assert.deepEqual(tierOf(model("solution"), DEFAULT_CONFIG), { tier: "standard", presumed: true });
  });
});

describe("versões e uso extra", () => {
  for (const [a, b, expected] of [
    ["gpt-6.1-sol", "gpt-6-sol", 1], ["gpt-6-sol", "gpt-5.6-sol", 1], ["gpt-6.10-sol", "gpt-6.2-sol", 1],
    ["claude-sonnet-5-5", "claude-sonnet-5", 1], ["claude-haiku-4-5-20251001", "claude-haiku-4-5", 0],
    ["claude-opus-5-5[1m]", "claude-opus-5-5", 0], ["gpt-6-sol", "gpt-6-astra", 0], ["foo-1", "foo-2", 0],
  ] as const) {
    it(`${a} / ${b}`, () => {
      assert.equal(compareModelVersions(a, b), expected);
      assert.equal(compareModelVersions(model(b), model(a)), expected === 0 ? 0 : -expected);
    });
  }
  it("créditos explícitos na descrição; preço genérico de API não conta", () => {
    for (const description of ["Draws from usage credits", "Uses extra usage", "Draws from usage credits · $4/$20 per Mtok"]) assert.equal(extraUsage(model("foo", { description })), true);
    for (const description of ["included", "$ is a symbol", "Most capable", "10 per Mtok", "$5.00 / Mtok", "$ 0.50", "Opus 5.5 · $4/$20 per Mtok"]) assert.equal(extraUsage(model("foo", { description })), false);
  });
});

describe("esforço suportado", () => {
  for (const [tier, efforts, escalateToMax, expected] of [
    ["light", ["low", "medium", "high"], false, "low"], ["standard", ["low", "medium", "high"], false, "medium"],
    ["deep", ["low", "medium", "high"], false, "high"], ["standard", ["low", "high"], false, "high"],
    ["light", ["max", "xhigh", "high"], false, "high"], ["deep", ["high", "xhigh", "max"], true, "xhigh"],
    ["light", ["low", "max"], true, "max"], ["deep", ["low", "medium"], false, null],
    ["standard", [], false, null], ["light", ["ultra", "none"], false, null], ["deep", ["high"], true, null],
  ] as [Tier, string[], boolean, string | null][]) {
    it(`${tier} ${efforts} escalada=${escalateToMax}`, () => assert.equal(selectEffort(tier, model("foo", { efforts }), { escalateToMax }), expected));
  }
});

it("rodada 14: preço genérico de API não é uso extra; créditos explícitos e [1m] são", async () => {
  const { extraUsage } = await import("../src/adapters/tiers.js");
  const m = (id: string, description: string) => ({ provider: "claude" as const, id, aliases: [], displayName: id, description, efforts: [], contextWindow: null, vendorRecommended: false, legacy: false, capabilities: [] as ("code")[] });
  assert.equal(extraUsage(m("claude-opus-5-5", "Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok")), false);
  assert.equal(extraUsage(m("claude-sonnet-5-5", "Sonnet 5.5 · $2/$10 per Mtok")), false);
  assert.equal(extraUsage(m("claude-opus-5-5[1m]", "Opus 5.5 with 1M context")), true);
  assert.equal(extraUsage(m("claude-x", "Draws from usage credits · $4/$20 per Mtok")), true);
});
