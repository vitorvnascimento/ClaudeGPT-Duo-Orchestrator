// Catálogo do Gemini a partir de `agy models` (texto real da 1.5.3).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { agyBase, agyVendor, sameAsBrainModel, sameVendorAsBrain, discover, findModel, geminiModelId, geminiVariants, parseAgyModels, reportedMatchesRequested, type Catalog } from "../src/adapters/catalog.js";
import { tierOf } from "../src/adapters/tiers.js";
import { selectModel } from "../src/orchestration/select.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../src/paths.js";

const TEXT = `Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

function catalog(): Catalog {
  const models = parseAgyModels(TEXT);
  return { discoveredAt: "x", cliVersions: { claude: null, codex: null, gemini: null }, providers: {
    claude: { ok: false, source: "t", tools: [], models: [] }, codex: { ok: false, source: "t", tools: [], models: [] },
    gemini: { ok: true, source: "agy models", tools: [], models } } };
}

describe("catálogo do gemini", () => {
  it("keeps every agy model, Claude and GPT-OSS included (same as the Codex catalog)", () => {
    const models = parseAgyModels(TEXT);
    assert.equal(models.length, 8);
    assert.ok(models.every((m) => m.provider === "gemini"));
    assert.deepEqual(findModel(catalog(), "gemini", "claude-opus-5-5-high")?.efforts, ["high"]);
    assert.deepEqual(findModel(catalog(), "gemini", "gpt-oss-120b-medium")?.efforts, ["medium"]);
  });
  it("ignores lines that are not model ids", () => {
    assert.deepEqual(parseAgyModels("Fetching available models...\n\nBad Id\tx\n-flag\tx\nok-1\tOk\n").map((m) => m.id), ["ok-1"]);
  });
  it("classifies non-Gemini agy models by family; unknown ones are presumed", () => {
    assert.deepEqual(tierOf({ id: "claude-opus-5-5-high", aliases: [], displayName: "Claude Opus 5.5 (High)" }, DEFAULT_CONFIG), { tier: "deep", presumed: false });
    assert.deepEqual(tierOf({ id: "claude-sonnet-5-5-low", aliases: [], displayName: "Claude Sonnet 5.5 (Low)" }, DEFAULT_CONFIG), { tier: "standard", presumed: false });
    assert.equal(tierOf({ id: "gpt-oss-120b-medium", aliases: [], displayName: "GPT-OSS 120B (Medium)" }, DEFAULT_CONFIG).presumed, true);
  });
  it("the brain's own model is recognized across accounts", () => {
    assert.equal(sameAsBrainModel(null, "claude", "claude-opus-5-5", "gemini", "claude-opus-5-5-high"), true);
    assert.equal(sameAsBrainModel(null, "claude", "claude-opus-5-5", "gemini", "claude-sonnet-5-5-high"), false);
    assert.equal(sameAsBrainModel(null, "codex", "claude-opus-5-5", "gemini", "claude-opus-5-5-high"), false);
    assert.equal(sameAsBrainModel(null, "claude", "claude-opus-5-5", "claude", "claude-opus-5-5"), true);
    assert.equal(sameVendorAsBrain("claude", "gemini", "claude-sonnet-5-5-low"), true);
    assert.equal(sameVendorAsBrain("claude", "gemini", "gemini-4-argon-high"), false);
    assert.equal(sameVendorAsBrain("codex", "codex", null), true);
  });
  it("selection skips an effort variant that cannot reach its own tier's effort", () => {
    const models = parseAgyModels("claude-opus-5-5-low\tClaude Opus 5.5 (Low)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n");
    const c: Catalog = { ...catalog(), providers: { ...catalog().providers, gemini: { ok: true, source: "agy models", tools: [], models } } };
    const cfg = structuredClone(DEFAULT_CONFIG); cfg.executors.gemini.enabled = true;
    const sel = selectModel(c, cfg, "gemini", "deep", { candidates: [], floor: "standard" });
    assert.equal(sel?.model, "claude-opus-5-5-high");
  });
  it("a low-effort Gemini variant stays eligible for a standard task", () => {
    const models = parseAgyModels("gemini-4-argon-low\tGemini 4 Argon (Low)\n");
    const c: Catalog = { ...catalog(), providers: { ...catalog().providers, gemini: { ok: true, source: "agy models", tools: [], models } } };
    const cfg = structuredClone(DEFAULT_CONFIG); cfg.executors.gemini.enabled = true;
    assert.equal(selectModel(c, cfg, "gemini", "standard", { candidates: [], floor: "standard" })?.model, "gemini-4-argon-low");
  });
  it("agyVendor/agyBase map an agy id to the vendor model it serves", () => {
    assert.equal(agyVendor("claude-opus-5-5-high"), "claude");
    assert.equal(agyVendor("gpt-oss-120b-medium"), "codex");
    assert.equal(agyVendor("gemini-4-argon-high"), "gemini");
    assert.equal(agyBase("claude-opus-5-5-high"), "claude-opus-5-5");
    assert.equal(agyBase("gemini-pro-orchestrator-neon"), "gemini-pro-orchestrator-neon");
  });
  it("variants grouped for selection but each full id resolvable", () => {
    const c = catalog();
    assert.deepEqual(geminiVariants(c, "gemini-4-argon").map((v) => v.effort), ["low", "medium", "high"]);
    assert.equal(findModel(c, "gemini", "gemini-4-argon-high")?.id, "gemini-4-argon-high");
    assert.deepEqual(findModel(c, "gemini", "gemini-4-argon-high")?.efforts, ["high"]);
    assert.equal(geminiModelId(c, "gemini-4-argon", "medium"), "gemini-4-argon-medium");
    assert.equal(geminiModelId(c, "gemini-4-neon", "low"), null);
  });
  it("served -low does not confirm requested -high", () => {
    assert.equal(reportedMatchesRequested(catalog(), "gemini", "gemini-4-argon-high", "gemini-4-argon-low"), false);
    assert.equal(reportedMatchesRequested(catalog(), "gemini", "gemini-4-argon-high", "gemini-4-argon-high"), true);
  });
  it("flash is light, other families presumed standard", () => {
    assert.deepEqual(tierOf({ id: "gemini-3.8-flash-low", aliases: [], displayName: "Gemini 3.8 Flash (Low)" }, DEFAULT_CONFIG), { tier: "light", presumed: false });
    assert.deepEqual(tierOf({ id: "gemini-4-argon-high", aliases: [], displayName: "Gemini 4 Argon (High)" }, DEFAULT_CONFIG), { tier: "standard", presumed: true });
  });
});

describe("descoberta do gemini", () => {
  const FAKE = join(packageRoot(), "tests", "fixtures", "fake-agy.mjs");
  it("discovers every agy model through agy models with a private HOME, only when enabled", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-disc-")));
    try {
      const home = join(base, "home"); mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
      const log = join(base, "log.jsonl");
      const env = { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: home, FAKE_LOG: log };
      const off = await discover(structuredClone(DEFAULT_CONFIG), base, env);
      assert.equal(off.providers.gemini.ok, false);
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.executors.gemini.enabled = true;
      cfg.executors.gemini.command = [FAKE];
      const on = await discover(cfg, base, env);
      assert.equal(on.providers.gemini.ok, true, on.providers.gemini.error);
      assert.deepEqual(on.providers.gemini.models.map((m) => m.id), ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-3.8-flash-low", "claude-opus-5-5-high"]);
      const call = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cmd: string; home: string }).find((c) => c.cmd === "agy-models");
      assert.ok(call && call.home !== home && call.home.includes("gemini-state"), JSON.stringify(call));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
