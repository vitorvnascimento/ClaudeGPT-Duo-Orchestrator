import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCatalog } from "../src/adapters/catalog.js";
import { isPidAlive } from "../src/adapters/process.js";
import { loadConfig } from "../src/config.js";
import { parseCodexQuota, quotaBlock, quotaStates, saveQuota, type QuotaState } from "../src/orchestration/quota.js";
import { evaluateCandidates, liveAvailability, recommend } from "../src/orchestration/router.js";
import { Store } from "../src/state/store.js";
import { quotaView, setQuota } from "../src/telemetry/report.js";
import { adaptiveCatalog } from "./adaptive-catalog.js";
import { CLI, makeSandbox, type Sandbox } from "./helpers.js";

let s: Sandbox;
afterEach(() => s?.cleanup());
const now = Date.now(), reset = Math.floor(now / 1000) + 3600;
const models = adaptiveCatalog.providers.codex.models;
const raw = (used: number, extra: Record<string, unknown> = {}) => ({ ordinaryUsageAllowed: true, rateLimitsByLimitId: {
  main: { primary: { usedPercent: used, resetsAt: reset }, rateLimitReachedType: null, ...extra },
} });
const state = (status: QuotaState["status"], extra: Partial<QuotaState> = {}): QuotaState => ({ status, usedPercent: null, resetsAt: new Date(reset * 1000).toISOString(), observedAt: new Date(now).toISOString(), source: "manual", affectedModels: null, ...extra });

describe("estado mínimo de cota", () => {
  it("interpreta janelas, warning configurável, exhausted e dados ausentes", () => {
    assert.equal(parseCodexQuota(raw(10), models)?.status, "ok");
    assert.equal(parseCodexQuota(raw(90), models)?.status, "warning");
    assert.equal(parseCodexQuota(raw(85), models, 80)?.status, "warning");
    assert.equal(parseCodexQuota(raw(100), models)?.status, "exhausted");
    assert.equal(parseCodexQuota(raw(1, { rateLimitReachedType: "included" }), models)?.status, "exhausted");
    assert.equal(parseCodexQuota({ ...raw(1), ordinaryUsageAllowed: false }, models)?.status, "exhausted");
    assert.equal(parseCodexQuota(raw(1, { secondary: { usedPercent: 99, resetsAt: reset + 200 } }), models)?.usedPercent, 99);
    assert.equal(parseCodexQuota(raw(1, { primary: null }), models)?.status, "unknown");
    for (const bad of [null, {}, { rateLimitsByLimitId: [] }, raw(1, { primary: { usedPercent: "99" } }), raw(1, { primary: { usedPercent: -1 } }), raw(1, { primary: { usedPercent: 1, resetsAt: "tomorrow" } }), { ...raw(1), ordinaryUsageAllowed: "false" }]) assert.equal(parseCodexQuota(bad, models), null);
  });
  it("escopo por slug só quando todos os limites esgotados são inequívocos", () => {
    assert.deepEqual(parseCodexQuota(raw(100, { normalModelSlug: "gpt-6.1-sol" }), models)?.affectedModels, ["gpt-6.1-sol"]);
    assert.equal(parseCodexQuota(raw(100, { normalModelSlug: "absent" }), models)?.affectedModels, null);
    assert.equal(parseCodexQuota(raw(100, { normalModelSlug: "gpt-6.1-sol" }), [...models, { ...models[0]!, aliases: ["gpt-6.1-sol"] }])?.affectedModels, null);
    assert.equal(parseCodexQuota({ ...raw(100, { normalModelSlug: "gpt-6.1-sol" }), ordinaryUsageAllowed: false }, models)?.affectedModels, null);
    const mixed = raw(100, { normalModelSlug: "gpt-6.1-sol" });
    Object.assign(mixed.rateLimitsByLimitId, { unknown: { primary: { usedPercent: 100, resetsAt: reset } } });
    assert.equal(parseCodexQuota(mixed, models)?.affectedModels, null);
  });
  it("expira no reset ou após 6 h sem reset; mantém observação e fonte", () => {
    s = makeSandbox(); const store = new Store(s.root);
    for (const status of ["ok", "warning", "exhausted", "unknown"] as const) {
      saveQuota(store, "codex", state(status));
      assert.equal(quotaStates(store, now).codex?.status, status);
      assert.equal(quotaStates(store, (reset + 1) * 1000).codex?.status, "unknown");
    }
    saveQuota(store, "codex", state("exhausted", { resetsAt: null }));
    assert.equal(quotaStates(store, now + 5 * 3600000).codex?.status, "exhausted");
    assert.equal(quotaStates(store, now + 6 * 3600000 + 1).codex?.status, "unknown");
    assert.equal(quotaStates(store).codex?.source, "manual");
  });
  it("registro manual mantém quotaView e registra estado separado", () => {
    s = makeSandbox(); const store = new Store(s.root);
    setQuota(store, { provider: "codex", usedPercent: 93, resetsAt: null, note: "manual" });
    assert.equal(quotaStates(store).codex?.status, "warning");
    assert.equal(quotaView(store).codex.source, "manual");
    assert.equal(quotaView(store).codex.status, "informada manualmente");
    assert.equal((quotaView(store).codex.state as QuotaState).status, "warning");
  });
});

describe("cota no catálogo e na seleção", () => {
  it("descarta dados de conta de todos os arquivos .duo e só chama account/rateLimits/read", async () => {
    s = makeSandbox(); const store = new Store(s.root);
    const forbidden = ["secret-account", "secret-plan", "secret-credit", "secret-individual", "secret-reset-credit", "secret-email@example.com", "pessoa-secreta@example.com"];
    const response = { ...raw(95, { planType: forbidden[1], credits: forbidden[2], individualLimit: forbidden[3], spendControlReached: true }), accountId: forbidden[0], rateLimitResetCredits: forbidden[4], email: forbidden[5] };
    await loadCatalog(store, loadConfig(s.root), { env: { ...s.env, FAKE_QUOTA: JSON.stringify(response) } });
    assert.equal(quotaStates(store).codex?.status, "warning");
    const visit = (dir: string): void => { for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name); if (e.isDirectory()) visit(p); else { const contents = readFileSync(p, "utf8"); for (const value of forbidden) assert.ok(!contents.includes(value), p);
        for (const key of ["accountId", "planType", "credits", "individualLimit", "rateLimitResetCredits", "spendControlReached"]) assert.ok(!contents.includes(`"${key}":`), p); }
    } };
    visit(store.base);
    assert.deepEqual(s.log().filter((e) => String(e.method).startsWith("account/")).map((e) => e.method), ["account/rateLimits/read"]);
    assert.equal(s.log().find((e) => e.method === "account/rateLimits/read")?.hasParams, false);
  });
  for (const quota of ["{}", "error", "hang", "close"]) it(`resposta ${quota}: catálogo disponível, cota sem dado`, async () => {
    s = makeSandbox(); const store = new Store(s.root);
    const catalog = await loadCatalog(store, loadConfig(s.root), { env: { ...s.env, FAKE_QUOTA: quota } });
    assert.equal(catalog.providers.codex.sourceKind, "codex-app-server");
    assert.equal(quotaStates(store).codex, undefined);
    const pid = Number(s.log().find((e) => e.cmd === "app-server")?.pid);
    assert.ok(pid > 0);
    for (let i = 0; i < 30 && isPidAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isPidAlive(pid), false, "consulta opcional não pode deixar app-server órfão");
  });
  it("warning penaliza só light/standard; exhausted filtra modelo ou conta", async () => {
    s = makeSandbox(); const store = new Store(s.root), cfg = loadConfig(s.root);
    const evals = (complexity: "light" | "standard" | "deep") => evaluateCandidates(store, cfg, { kind: "implement", tags: [], risk: "low", brain: null, complexity }, () => ({ available: true, reasons: [] }), adaptiveCatalog).evals;
    const before = evals("standard"); saveQuota(store, "codex", state("warning", { usedPercent: 95 }));
    for (const tier of ["light", "standard", "deep"] as const) {
      const e = evals(tier).find((c) => c.model === "gpt-6.1-sol")!;
      assert.equal(e.score, before.find((c) => c.model === e.model)!.score - (tier === "deep" ? 0 : 0.15));
      assert.equal(e.reasons.some((r) => r.includes("poupando")), tier !== "deep");
    }
    const highRisk = evaluateCandidates(store, cfg, { kind: "implement", tags: [], risk: "high", brain: null, complexity: "light" }, () => ({ available: true, reasons: [] }), adaptiveCatalog).evals;
    assert.equal(highRisk.find((c) => c.model === "gpt-6.1-sol")?.reasons.some((r) => r.includes("poupando")), false);
    saveQuota(store, "codex", state("exhausted", { affectedModels: ["gpt-6.1-sol"] }));
    assert.equal(evals("standard").find((c) => c.model === "gpt-6.1-sol")?.available, false);
    assert.equal(evals("standard").find((c) => c.model === "gpt-6-sol")?.available, true);
    assert.equal((await liveAvailability(store, cfg, s.env, s.authPaths))("codex").available, true);
    saveQuota(store, "codex", state("exhausted"));
    assert.equal((await liveAvailability(store, cfg, s.env, s.authPaths))("codex").available, false);
    assert.match(quotaBlock(quotaStates(store).codex)!, /cota esgotada até/);
    saveQuota(store, "codex", state("exhausted", { resetsAt: new Date(now - 1).toISOString() }));
    assert.equal((await liveAvailability(store, cfg, s.env, s.authPaths))("codex").available, true);
    assert.ok(recommend(store, cfg, { kind: "implement", tags: [], risk: "low", brain: null }, () => ({ available: true, reasons: [] }), adaptiveCatalog).notes.some((n) => n.includes("Saúde de cota")));
  });
  it("CLI refresh usa descoberta, show expõe estado e set respeita limiar", () => {
    s = makeSandbox({ routing: { adaptive: { quotaWarnPercent: 80 } } });
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [CLI, "quota", ...args], { cwd: s.root, env: { ...s.env, FAKE_QUOTA: JSON.stringify(raw(95)) }, encoding: "utf8" }));
    assert.equal(cli("refresh").codex.state.source, "codex-rate-limits");
    assert.equal(cli("show").codex.state.usedPercent, 95);
    assert.equal(cli("show").codex.remainingPercent, 5);
    cli("set", "--provider", "claude", "--used-percent", "85");
    assert.equal(cli("show").claude.state.status, "warning");
  });
});
