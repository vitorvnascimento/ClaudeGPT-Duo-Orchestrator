// Catálogo do Gemini a partir de `agy models` (texto real da 1.5.3).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { discover, findModel, geminiModelId, geminiVariants, parseAgyModels, reportedMatchesRequested, type Catalog } from "../src/adapters/catalog.js";
import { tierOf } from "../src/adapters/tiers.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
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
  it("the catalog cache is rediscovered when gemini is enabled or the agy version changes", async () => {
    const { loadCatalog } = await import("../src/adapters/catalog.js");
    const { Store } = await import("../src/state/store.js");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-cache-")));
    try {
      const home = join(base, "home"); mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
      mkdirSync(join(base, "proj", ".duo"), { recursive: true });
      const store = new Store(join(base, "proj"));
      const log = join(base, "log.jsonl");
      const env = { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: home, FAKE_LOG: log, FAKE_AGY_VERSION: "1.5.14" };
      const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"agy-models"')).length : 0;
      const off = structuredClone(DEFAULT_CONFIG); off.executors.gemini.command = [FAKE];
      await loadCatalog(store, off, { env });
      assert.equal(calls(), 0);
      const on = structuredClone(off); on.executors.gemini.enabled = true;
      const c1 = await loadCatalog(store, on, { env });
      assert.equal(c1.providers.gemini.ok, true);
      assert.equal(calls(), 1);
      await loadCatalog(store, on, { env });
      assert.equal(calls(), 1, "mesma versão: cache");
      await loadCatalog(store, on, { env: { ...env, FAKE_AGY_VERSION: "1.5.15" } });
      assert.equal(calls(), 2, "versão nova do agy: redescobre");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("a fresh v0.4.0 cache without providers.gemini loads without errors", async () => {
    const { loadCatalog, catalogPath } = await import("../src/adapters/catalog.js");
    const { Store } = await import("../src/state/store.js");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-cache-")));
    try {
      mkdirSync(join(base, "proj", ".duo"), { recursive: true });
      const store = new Store(join(base, "proj"));
      const old = { discoveredAt: new Date().toISOString(), cliVersions: { claude: null, codex: null }, providers: {
        claude: { ok: true, source: "t", tools: [], models: [] }, codex: { ok: true, source: "t", tools: [], models: [] } } };
      writeFileSync(catalogPath(store), JSON.stringify(old));
      const cfg = structuredClone(DEFAULT_CONFIG); cfg.routing.extraModels = ["gemini:gemini-4-argon-high"];
      const c = await loadCatalog(store, cfg, { env: { PATH: "/usr/bin:/bin", HOME: join(base, "home") } });
      assert.ok(c.providers.gemini);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("a legacy cache without version metadata is never reused; a malformed provider map is rediscovered", async () => {
    const { loadCatalog, catalogPath } = await import("../src/adapters/catalog.js");
    const { Store } = await import("../src/state/store.js");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-cache-")));
    try {
      mkdirSync(join(base, "proj", ".duo"), { recursive: true });
      const store = new Store(join(base, "proj"));
      const env = { PATH: "/nonexistent", HOME: join(base, "home") };
      const legacy = { discoveredAt: new Date().toISOString(), providers: {
        claude: { ok: true, source: "legado", tools: [], models: [{ provider: "claude", id: "velho", aliases: [], displayName: "velho", description: "", efforts: [], contextWindow: null, vendorRecommended: false, legacy: false, capabilities: ["code"] }] },
        codex: { ok: true, source: "legado", tools: [], models: [] } } };
      writeFileSync(catalogPath(store), JSON.stringify(legacy));
      const c = await loadCatalog(store, structuredClone(DEFAULT_CONFIG), { env });
      // Redescoberto (sem CLIs, o último catálogo bom volta marcado como desatualizado), nunca servido como fresco.
      assert.ok(c.providers.claude.source !== "legado" || c.providers.claude.stale === true, JSON.stringify(c.providers.claude));
      for (const cliVersions of [[], "unknown"]) {
        writeFileSync(catalogPath(store), JSON.stringify({ ...legacy, cliVersions }));
        const m = await loadCatalog(store, structuredClone(DEFAULT_CONFIG), { env });
        assert.ok(m.providers.claude.source !== "legado" || m.providers.claude.stale === true, JSON.stringify(cliVersions));
      }
      writeFileSync(catalogPath(store), JSON.stringify({ discoveredAt: new Date().toISOString(), providers: "x" }));
      const r = await loadCatalog(store, structuredClone(DEFAULT_CONFIG), { env, refresh: true });
      assert.ok(r.providers.gemini);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("unexpected agy --version output is cached as a digest, not as text", async () => {
    const { loadCatalog, catalogPath } = await import("../src/adapters/catalog.js");
    const { Store } = await import("../src/state/store.js");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-cache-")));
    try {
      const home = join(base, "home"); mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
      mkdirSync(join(base, "proj", ".duo"), { recursive: true });
      const store = new Store(join(base, "proj"));
      const cfg = structuredClone(DEFAULT_CONFIG); cfg.executors.gemini.enabled = true; cfg.executors.gemini.command = [FAKE];
      await loadCatalog(store, cfg, { env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: home, FAKE_AGY_VERSION: "1.5.14\nsigned in as pessoa@exemplo.com" } });
      const saved = readFileSync(catalogPath(store), "utf8");
      assert.doesNotMatch(saved, /pessoa@exemplo/);
      assert.match(saved, /sha256:/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("a failed agy models never stores raw stderr, only the failure class", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-disc-")));
    try {
      const home = join(base, "home"); mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
      const cfg = structuredClone(DEFAULT_CONFIG); cfg.executors.gemini.enabled = true; cfg.executors.gemini.command = [FAKE];
      const c = await discover(cfg, base, { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: home, FAKE_AGY_NO_MODELS: "1" });
      assert.equal(c.providers.gemini.ok, false);
      assert.doesNotMatch(JSON.stringify(c.providers.gemini), /Please sign in/);
      assert.match(String(c.providers.gemini.error), /agy models falhou/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("a broken private HOME setup fails only the gemini catalog, not claude and codex", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-disc-")));
    try {
      const home = join(base, "home"); mkdirSync(join(home, "Library"), { recursive: true });
      // O diretório de estado vira arquivo: o setup do HOME do catálogo falha.
      writeFileSync(join(home, "Library", "Application Support"), "x");
      writeFileSync(join(base, "xdg-file"), "x");
      const cfg = structuredClone(DEFAULT_CONFIG); cfg.executors.gemini.enabled = true; cfg.executors.gemini.command = [FAKE];
      const c = await discover(cfg, base, { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: home, XDG_STATE_HOME: join(base, "xdg-file") });
      assert.equal(c.providers.gemini.ok, false);
      assert.ok(c.providers.claude && c.providers.codex);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
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
