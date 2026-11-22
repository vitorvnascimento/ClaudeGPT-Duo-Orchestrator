// Catálogo do Gemini a partir de `agy models` (texto real da 1.5.3).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { discover, findModel, geminiModelId, geminiVariants, parseAgyModels, reportedMatchesRequested, type Catalog } from "../src/adapters/catalog.js";
import { tierOf } from "../src/adapters/tiers.js";
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
  it("drops claude and gpt-oss ids", () => {
    const ids = parseAgyModels(TEXT).map((m) => m.id);
    assert.ok(ids.every((id) => id.startsWith("gemini-")));
    assert.equal(ids.length, 6);
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
  it("discovers gemini-* models through agy models with a private HOME, only when enabled", async () => {
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
      assert.deepEqual(on.providers.gemini.models.map((m) => m.id), ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-3.8-flash-low"]);
      const call = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cmd: string; home: string }).find((c) => c.cmd === "agy-models");
      assert.ok(call && call.home !== home && call.home.includes("gemini-state"), JSON.stringify(call));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
