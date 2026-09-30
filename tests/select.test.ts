import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, type Provider } from "../src/config.js";
import type { Tier } from "../src/adapters/tiers.js";
import { selectModel } from "../src/orchestration/select.js";
import type { CandidateEval } from "../src/orchestration/router.js";
import { adaptiveCatalog } from "./adaptive-catalog.js";

const evidence = (model: string, successRate: number, score = successRate): CandidateEval => ({
  executor: "codex", model, displayName: model, available: true, availability: [], prior: { bonus: 0, notes: [] }, vendor: { recommended: false, legacy: false }, score, reasons: [],
  evidence: { bucket: "kind=implement + tags=ts", sufficient: true, n: 12, successes: 11, successRate, acceptancePassRate: successRate, overclaims: 0, rejectedByBrain: 0, medianWallMs: null },
});
describe("seleção adaptativa I5/I8", () => {
  for (const [provider, tier, model, effort] of [
    ["claude", "light", "claude-haiku-4-5-20251001", null], ["codex", "light", "gpt-6-luna", "low"],
    ["claude", "standard", "claude-sonnet-5-5", "medium"], ["codex", "standard", "gpt-6.1-sol", "medium"],
    ["claude", "deep", "claude-opus-5-5", "high"], ["codex", "deep", "gpt-6-astra", "high"],
  ] as const) it(`${provider}/${tier}`, () => {
    const result = selectModel(adaptiveCatalog, DEFAULT_CONFIG, provider, tier, { candidates: [], floor: tier });
    assert.equal(result?.model, model); assert.equal(result?.effort, effort);
  });
  it("sem recomendação, versão mais nova da família vence", () => {
    const catalog = structuredClone(adaptiveCatalog);
    catalog.providers.codex.models.forEach((m) => { m.vendorRecommended = false; });
    assert.equal(selectModel(catalog, DEFAULT_CONFIG, "codex", "standard", { candidates: [], floor: "standard" })?.model, "gpt-6.1-sol");
  });
  it("evidência vence sinal do fornecedor; ruins sobem", () => {
    assert.equal(selectModel(adaptiveCatalog, DEFAULT_CONFIG, "codex", "standard", { candidates: [evidence("gpt-6-sol", 0.9)], floor: "standard" })?.model, "gpt-6-sol");
    assert.equal(selectModel(adaptiveCatalog, DEFAULT_CONFIG, "codex", "standard", { candidates: [evidence("gpt-6-sol", 0.2), evidence("gpt-6.1-sol", 0.2)], floor: "standard" })?.tier, "deep");
  });
  it("redução protegida respeita bucket, suficiência e pisos", () => {
    const candidates = [evidence("gpt-6-luna", 0.9)];
    assert.equal(selectModel(adaptiveCatalog, DEFAULT_CONFIG, "codex", "standard", { candidates, floor: "light" })?.tier, "light");
    for (const floor of ["standard", "deep"] as Tier[]) assert.notEqual(selectModel(adaptiveCatalog, DEFAULT_CONFIG, "codex", floor, { candidates, floor })?.tier, "light");
    candidates[0]!.evidence.sufficient = false;
    assert.equal(selectModel(adaptiveCatalog, DEFAULT_CONFIG, "codex", "standard", { candidates, floor: "light" })?.tier, "standard");
    candidates[0]!.evidence.sufficient = true; candidates[0]!.evidence.bucket = "todas as tarefas do mesmo grupo";
    assert.equal(selectModel(adaptiveCatalog, DEFAULT_CONFIG, "codex", "standard", { candidates, floor: "light" })?.tier, "standard");
    assert.equal(selectModel(adaptiveCatalog, DEFAULT_CONFIG, "codex", "light", { candidates, floor: "deep" })?.tier, "deep");
  });
  it("extra exige ack e include; exclude sempre prevalece", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.routing.include = ["claude:claude-fable-5-1[1m]"];
    const select = () => selectModel(adaptiveCatalog, cfg, "claude", "deep", { candidates: [], floor: "deep" });
    assert.equal(select(), null);
    cfg.billing.acknowledgeUnverifiableExtraUsage.claude = true;
    assert.equal(select()?.model, "claude-fable-5-1[1m]");
    cfg.routing.exclude = [...cfg.routing.include]; assert.equal(select(), null);
  });
  it("catálogo indisponível ou stale não inventa seleção", () => {
    assert.equal(selectModel(null, DEFAULT_CONFIG, "codex", "light", { candidates: [], floor: "light" }), null);
    const catalog = structuredClone(adaptiveCatalog); catalog.providers.codex.stale = true;
    assert.equal(selectModel(catalog, DEFAULT_CONFIG, "codex", "deep", { candidates: [], floor: "deep" }), null);
  });
  it("sem candidatos no nível sobe; não desce para preencher lacuna", () => {
    const catalog = structuredClone(adaptiveCatalog);
    catalog.providers.codex.models = catalog.providers.codex.models.filter((m) => m.id === "gpt-6-astra" || m.id === "gpt-6-luna");
    assert.equal(selectModel(catalog, DEFAULT_CONFIG, "codex", "standard", { candidates: [], floor: "light" })?.tier, "deep");
    const cfg = structuredClone(DEFAULT_CONFIG); cfg.routing.exclude = ["codex:gpt-6-astra"];
    assert.equal(selectModel(catalog, cfg, "codex", "standard", { candidates: [], floor: "standard" }), null);
  });
  it("legado só quando não há moderno no mesmo nível; indisponível não entra", () => {
    const cfg = structuredClone(DEFAULT_CONFIG); cfg.routing.exclude = ["codex:gpt-6.1-sol", "codex:gpt-6-sol"];
    assert.equal(selectModel(adaptiveCatalog, cfg, "codex", "standard", { candidates: [], floor: "standard" })?.model, "gpt-5.6-sol");
    const candidates = [evidence("gpt-6.1-sol", 0.9)]; candidates[0]!.available = false;
    assert.equal(selectModel(adaptiveCatalog, DEFAULT_CONFIG, "codex", "standard", { candidates, floor: "standard" })?.model, "gpt-6-sol");
  });
});
