import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { cliUpdateWarnings, fetchCliLatest, loadCliLatest, type FetchLike } from "../src/adapters/cli-latest.js";
import { doctor, formatDoctor } from "../src/cli/doctor.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/state/store.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | null = null;
afterEach(() => { sb?.cleanup(); sb = null; });
const HOUR = 60 * 60 * 1000;
const response = (version: unknown) => ({ ok: true, json: async () => ({ version, secret: "não gravar", name: "ignorado" }) });
function setup() {
  sb = makeSandbox();
  const env = { ...sb.env };
  for (const k of ["DUO_NO_UPDATE_CHECK", "DUO_DEPTH", "CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"]) delete env[k];
  return { s: sb, env, store: new Store(sb.root), cfg: loadConfig(sb.root) };
}

describe("versões publicadas das CLIs, sem rede real", () => {
  it("URLs fixas, somente Accept/User-Agent, sem credenciais, redirect error e timeout 5 s", async () => {
    const { store, cfg, env } = setup();
    let calls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls++;
      assert.ok(url === "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest" || url === "https://registry.npmjs.org/@openai%2Fcodex/latest");
      assert.deepEqual(init.headers, { Accept: "application/json", "User-Agent": "duo-orchestrator/0.2.0" });
      assert.equal(init.redirect, "error");
      assert.equal(init.signal.aborted, false);
      assert.ok(init.signal instanceof AbortSignal);
      return response(url.includes("openai") ? "0.159.2" : "2.1.285");
    };
    const latest = await loadCliLatest(store, cfg, { env: { ...env, NPM_TOKEN: "segredo", OPENAI_API_KEY: "segredo", HTTP_PROXY: "segredo" }, fetchImpl });
    assert.equal(calls, 2);
    assert.deepEqual(latest?.versions, { claude: "2.1.285", codex: "0.159.2" });
    const cache = readFileSync(join(store.base, "cli-latest.json"), "utf8");
    assert.ok(!cache.includes("segredo") && !cache.includes("secret"));
    assert.deepEqual(cliUpdateWarnings({ claude: "2.1.283", codex: "0.157.1" }, latest), [
      "CLI claude desatualizada (2.1.283 < 2.1.285): modelos mais novos podem não aparecer. Atualize com: npm i -g @anthropic-ai/claude-code@latest",
      "CLI codex desatualizada (0.157.1 < 0.159.2): modelos mais novos podem não aparecer. Atualize com: npm i -g @openai/codex@latest",
    ]);
    assert.deepEqual(cliUpdateWarnings({ claude: "2.1.285", codex: "0.160.0" }, latest), []);
  });

  it("validação estrita; HTTP, JSON e rede inválidos retornam null", async () => {
    for (const version of [null, 1, "0.159", "v0.159.2", "0.159.2-beta", "0.159.2\n", "0.159.2\u001b[31m", "https://evil.test", "9999999.1.1"]) assert.equal(await fetchCliLatest("codex", async () => response(version)), null);
    assert.equal(await fetchCliLatest("codex", async () => ({ ok: false, json: async () => { throw new Error(); } })), null);
    assert.equal(await fetchCliLatest("codex", async () => { throw new Error("offline"); }), null);
    assert.equal(await fetchCliLatest("codex", async () => ({ ok: true, json: async () => { throw new Error("JSON"); } })), null);
  });

  it("cache de 6 h, inclusive falhas, e expiração não reutiliza dado sem rede", async () => {
    const { store, cfg, env } = setup();
    const now = Date.parse("2026-09-29T00:00:00Z");
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; return response("0.159.2"); };
    await loadCliLatest(store, cfg, { env, fetchImpl, now });
    await loadCliLatest(store, cfg, { env, fetchImpl, now: now + 6 * HOUR - 1 });
    assert.equal(calls, 2);
    const offline: FetchLike = async () => { calls++; throw new Error("offline"); };
    const failed = await loadCliLatest(store, cfg, { env, fetchImpl: offline, now: now + 6 * HOUR });
    assert.deepEqual(failed?.versions, { claude: null, codex: null });
    assert.deepEqual(cliUpdateWarnings({ claude: "0.1.0", codex: "0.1.0" }, failed), []);
    await loadCliLatest(store, cfg, { env, fetchImpl: offline, now: now + 7 * HOUR });
    assert.equal(calls, 4);
  });

  it("todos os desligamentos impedem fetch, leitura de avisos e escrita", async () => {
    const { store, cfg, env } = setup();
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; throw new Error("fetch não deve rodar"); };
    for (const patch of [{ DUO_NO_UPDATE_CHECK: "1" }, { DUO_DEPTH: "1" }, { CI: "1" }, { CODEX_SANDBOX: "seatbelt" }, { CODEX_SANDBOX_NETWORK_DISABLED: "1" }]) {
      assert.equal(await loadCliLatest(store, cfg, { env: { ...env, ...patch }, fetchImpl }), null);
    }
    assert.equal(await loadCliLatest(store, { ...cfg, discovery: { checkCliUpdates: false } }, { env, fetchImpl }), null);
    assert.equal(calls, 0);
    assert.equal(existsSync(join(store.base, "cli-latest.json")), false);
    await loadCliLatest(store, cfg, { env, fetchImpl: async () => response("9.9.9") });
    assert.equal(await loadCliLatest(store, cfg, { env: { ...env, DUO_NO_UPDATE_CHECK: "1" }, fetchImpl }), null);
  });

  it("cache inválido, grande, symlink e FIFO não bloqueiam", async () => {
    const { s, store, cfg, env } = setup();
    const path = join(store.base, "cli-latest.json");
    const fetchImpl: FetchLike = async () => response("0.159.2");
    for (const raw of ["{", "null", JSON.stringify({ checkedAt: "bad", versions: {} }), JSON.stringify({ checkedAt: new Date().toISOString(), versions: { claude: "evil", codex: null } }), "x".repeat(65537)]) {
      writeFileSync(path, raw);
      assert.equal((await loadCliLatest(store, cfg, { env, fetchImpl }))?.versions.codex, "0.159.2");
    }
    const target = join(s.tmp, "other.json");
    writeFileSync(target, "não tocar");
    rmSync(path); symlinkSync(target, path);
    assert.equal((await loadCliLatest(store, cfg, { env, fetchImpl }))?.versions.codex, "0.159.2");
    assert.equal(readFileSync(target, "utf8"), "não tocar");
    if (process.platform !== "win32") {
      rmSync(path);
      assert.equal(spawnSync("mkfifo", [path]).status, 0);
      assert.equal((await loadCliLatest(store, cfg, { env, fetchImpl }))?.versions.codex, "0.159.2");
    }
  });

  it("doctor exibe instalada/publicada e flags; falha de rede não gera aviso", async () => {
    const { s, env } = setup();
    const report = await doctor(s.root, { ...env, FAKE_CLAUDE_VERSION: "2.1.283", FAKE_CODEX_VERSION: "0.157.1" }, s.authPaths, async (url) => response(url.includes("openai") ? "0.159.2" : "2.1.285"));
    const text = formatDoctor(report);
    assert.match(text, /--effort: disponível/);
    assert.match(text, /--config: disponível/);
    assert.match(text, /versão instalada 0\.157\.1 \| publicada 0\.159\.2/);
    assert.match(text, /CLI codex desatualizada/);
    rmSync(join(s.root, ".duo", "cli-latest.json"));
    const failed = await doctor(s.root, env, s.authPaths, async () => { throw new Error("offline"); });
    assert.ok(!formatDoctor(failed).includes("CLI codex desatualizada"));
    assert.equal(s.execCalls().length, 0);
  });
});
