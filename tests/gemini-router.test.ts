// Roteador, doctor e limpeza de estado com o gemini presente.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseAgyModels, type Catalog } from "../src/adapters/catalog.js";
import { loadConfig } from "../src/config.js";
import { packageRoot } from "../src/paths.js";
import { liveAvailability, recommend, type AvailabilityFn } from "../src/orchestration/router.js";
import { quotaStates, saveQuota } from "../src/orchestration/quota.js";
import { Store } from "../src/state/store.js";
import { adaptiveCatalog } from "./adaptive-catalog.js";
import { CLI, makeSandbox, type Sandbox } from "./helpers.js";

const FAKE_AGY = join(packageRoot(), "tests", "fixtures", "fake-agy.mjs");
let sb: Sandbox | undefined;
afterEach(() => { sb?.cleanup(); sb = undefined; });
const allUp: AvailabilityFn = () => ({ available: true, reasons: [] });
const withGemini: Catalog = { ...adaptiveCatalog, providers: { ...adaptiveCatalog.providers, gemini: { ok: true, source: "agy models", tools: [], models: parseAgyModels("gemini-4-argon-high\tA\ngemini-3.8-flash-low\tF\n") } } };

describe("roteador com gemini", () => {
  it("router ignores gemini when disabled", () => {
    sb = makeSandbox();
    const r = recommend(new Store(sb.root), loadConfig(sb.root), { kind: "implement", tags: [], risk: "medium", brain: null }, allUp, withGemini);
    assert.notEqual(r.decision.executor, "gemini");
    assert.ok(!JSON.stringify(r).includes("gemini-4-argon-high"));
  });
  it("adaptive recommendation never picks an unverified gemini even when enabled and cataloged", () => {
    sb = makeSandbox({ executors: { gemini: { enabled: true } }, billing: { acknowledgeUnverifiableExtraUsage: { gemini: true } } });
    const r = recommend(new Store(sb.root), loadConfig(sb.root), { kind: "implement", tags: [], risk: "low", brain: null }, allUp, withGemini);
    assert.notEqual(r.decision.executor, "gemini");
  });
});

describe("CLI com gemini", () => {
  // O agy falso é um .mjs com shebang: no Windows não roda como executável (e o gemini é bloqueado lá de qualquer forma).
  it("doctor shows a gemini section (json and text) and never runs agy in headless mode", { skip: process.platform === "win32" }, () => {
    sb = makeSandbox({ executors: { gemini: { enabled: true, command: [FAKE_AGY] } } });
    const env = { ...sb.env, PATH: `${join(process.execPath, "..")}${delimiter}${sb.env.PATH ?? ""}` };
    const text = spawnSync(process.execPath, [CLI, "doctor"], { cwd: sb.root, env, encoding: "utf8" });
    assert.doesNotMatch(text.stderr, /Cannot read properties/);
    assert.match(text.stdout, /\[gemini\][\s\S]*verificada: não/);
    assert.match(text.stdout, /login: subscription/);
    const r = spawnSync(process.execPath, [CLI, "doctor", "--json"], { cwd: sb.root, env, encoding: "utf8" });
    const report = JSON.parse(r.stdout) as { providers: Record<string, { installed?: boolean; version?: string; sandbox?: { ok: boolean } }> };
    assert.equal(report.providers.gemini?.version, "1.5.3", r.stdout.slice(0, 400));
    assert.ok("sandbox" in (report.providers.gemini ?? {}));
    assert.equal(sb.log().filter((e) => e.cmd === "agy-run").length, 0);
  });
  it("gemini-state prune rejects an empty --older-than", () => {
    sb = makeSandbox();
    const r = spawnSync(process.execPath, [CLI, "gemini-state", "prune", "--older-than", " "], { cwd: sb.root, env: sb.env, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /older-than/);
  });

  it("gemini-state prune runs and reports what it removed", () => {
    sb = makeSandbox();
    const r = spawnSync(process.execPath, [CLI, "gemini-state", "prune"], { cwd: sb.root, env: sb.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removid/);
  });
});

describe("executores simultâneos acima do recomendado", () => {
  it("doctor avisa quando maxConcurrentExecutors passa de 4 ou é null", () => {
    for (const value of [8, null]) {
      sb = makeSandbox({ limits: { maxConcurrentExecutors: value } });
      const r = spawnSync(process.execPath, [CLI, "doctor", "--json"], { cwd: sb.root, env: sb.env, encoding: "utf8" });
      const report = JSON.parse(r.stdout) as { warnings: string[] };
      assert.ok(report.warnings.some((w) => /maxConcurrentExecutors/.test(w) && /recomendado/.test(w)), JSON.stringify(report.warnings));
      sb.cleanup(); sb = undefined;
    }
    sb = makeSandbox();
    const ok = JSON.parse(spawnSync(process.execPath, [CLI, "doctor", "--json"], { cwd: sb.root, env: sb.env, encoding: "utf8" }).stdout) as { warnings: string[] };
    assert.ok(!ok.warnings.some((w) => /maxConcurrentExecutors/.test(w)));
  });
});

describe("disponibilidade e cota do gemini", () => {
  it("live availability returns a gemini entry (unverified → unavailable) without breaking the others", async () => {
    sb = makeSandbox({ executors: { gemini: { enabled: true, command: [FAKE_AGY] } } });
    const avail = await liveAvailability(new Store(sb.root), loadConfig(sb.root), sb.env, sb.authPaths);
    const g = avail("gemini");
    assert.equal(g.available, false);
    assert.ok(g.reasons.length > 0);
    assert.equal(typeof avail("codex").available, "boolean");
  });
  it("an odd agy --version output shows up bounded and on one line", { skip: process.platform !== "darwin" }, async () => {
    sb = makeSandbox({ executors: { gemini: { enabled: true, command: [FAKE_AGY] } } });
    const avail = await liveAvailability(new Store(sb.root), loadConfig(sb.root), { ...sb.env, PATH: `${join(process.execPath, "..")}${delimiter}${sb.env.PATH ?? ""}`, FAKE_AGY_VERSION: `1.5.14\n${"x".repeat(5000)}` }, sb.authPaths);
    const reason = avail("gemini").reasons.find((r) => r.includes("agy")) ?? "";
    assert.ok(reason.length > 0 && reason.length < 200, reason.slice(0, 300));
    assert.ok(!reason.includes("\n"));
  });
  it("live availability checks the agy login (and sandbox-exec) before offering gemini", { skip: process.platform !== "darwin" }, async () => {
    sb = makeSandbox({ executors: { gemini: { enabled: true, command: [FAKE_AGY] } }, billing: { acknowledgeUnverifiableExtraUsage: { gemini: true } } });
    const env = { ...sb.env, PATH: `${join(process.execPath, "..")}${delimiter}${sb.env.PATH ?? ""}`, FAKE_AGY_VERSION: "1.5.14" };
    const ok = await liveAvailability(new Store(sb.root), loadConfig(sb.root), env, sb.authPaths);
    assert.equal(ok("gemini").available, true, JSON.stringify(ok("gemini")));
    const bad = await liveAvailability(new Store(sb.root), loadConfig(sb.root), { ...env, FAKE_AGY_AUTH: "apikey" }, sb.authPaths);
    assert.equal(bad("gemini").available, false);
    assert.ok(bad("gemini").reasons.some((r) => /login/.test(r)), JSON.stringify(bad("gemini")));
  });
  it("a failing probe setup (no usable TMPDIR) only makes gemini unavailable", { skip: process.platform !== "darwin" }, async () => {
    sb = makeSandbox({ executors: { gemini: { enabled: true, command: [FAKE_AGY] } }, billing: { acknowledgeUnverifiableExtraUsage: { gemini: true } } });
    const env = { ...sb.env, PATH: `${join(process.execPath, "..")}${delimiter}${sb.env.PATH ?? ""}`, FAKE_AGY_VERSION: "1.5.14" };
    const baseline = await liveAvailability(new Store(sb.root), loadConfig(sb.root), env, sb.authPaths);
    const blocker = join(sb.root, "not-a-dir");
    writeFileSync(blocker, "x");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = blocker;
    try {
      const avail = await liveAvailability(new Store(sb.root), loadConfig(sb.root), env, sb.authPaths);
      assert.equal(avail("gemini").available, false);
      assert.ok(avail("gemini").reasons.some((r) => /tempor|sonda|login/.test(r)), JSON.stringify(avail("gemini")));
      for (const p of ["claude", "codex"] as const) assert.deepEqual(avail(p), baseline(p), p);
    } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  });
  it("version labels never carry unexpected --version text", async () => {
    const { agyVersionLabel } = await import("../src/adapters/gemini.js");
    assert.equal(agyVersionLabel("1.5.14+build.7"), "1.5.14+build.7");
    assert.match(agyVersionLabel("signed in as pessoa@exemplo.com"), /^sha256:[0-9a-f]{16}$/);
    assert.equal(agyVersionLabel(null), "desconhecida");
    assert.match(agyVersionLabel(`1.5.14+${"a".repeat(8192)}`), /^sha256:[0-9a-f]{16}$/);
  });
  it("inside the Codex sandbox, inconclusive checks are deferred but a disallowed login still blocks", { skip: process.platform !== "darwin" }, async () => {
    sb = makeSandbox({ executors: { gemini: { enabled: true, command: [FAKE_AGY] } }, billing: { acknowledgeUnverifiableExtraUsage: { gemini: true } } });
    const env = { ...sb.env, PATH: `${join(process.execPath, "..")}${delimiter}${sb.env.PATH ?? ""}`, FAKE_AGY_VERSION: "1.5.14", CODEX_SANDBOX: "seatbelt" };
    const check = async (extra: Record<string, string>) => (await liveAvailability(new Store(sb!.root), loadConfig(sb!.root), { ...env, ...extra }, sb!.authPaths))("gemini");
    const ok = await check({});
    assert.equal(ok.available, true, JSON.stringify(ok));
    assert.ok(ok.reasons.some((r) => /não verificáve/.test(r)));
    const unreadable = await check({ FAKE_AGY_NO_MODELS: "1" });
    assert.equal(unreadable.available, true, JSON.stringify(unreadable));
    const apikey = await check({ FAKE_AGY_AUTH: "apikey" });
    assert.equal(apikey.available, false, JSON.stringify(apikey));
    const conflict = await check({ FAKE_AGY_AUTH: "conflict" });
    assert.equal(conflict.available, false, JSON.stringify(conflict));
    const failedApikey = await check({ FAKE_AGY_AUTH: "apikey", FAKE_AGY_NO_MODELS: "1" });
    assert.equal(failedApikey.available, false, JSON.stringify(failedApikey));
  });
  it("a saved gemini exhaustion shows up in quotaStates", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    saveQuota(store, "gemini", { status: "exhausted", usedPercent: 100, resetsAt: new Date(Date.now() + 3600_000).toISOString(), observedAt: new Date().toISOString(), source: "task-error", affectedModels: null });
    assert.equal(quotaStates(store).gemini?.status, "exhausted");
  });
});

describe("capacidade do gemini", () => {
  it("a gemini capacity cooldown blocks and survives the next write", async () => {
    const { recordCapacity, capacityBlock } = await import("../src/orchestration/capacity.js");
    sb = makeSandbox();
    const store = new Store(sb.root);
    recordCapacity(store, "gemini", "gemini-4-argon-high");
    recordCapacity(store, "codex", "gpt-6.1-sol");
    assert.match(String(capacityBlock(store, "gemini", "gemini-4-argon-high")), /sem capacidade/);
  });
});
