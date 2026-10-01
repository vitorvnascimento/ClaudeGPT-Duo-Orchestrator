import { strict as assert } from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAdapter } from "../src/adapters/codex.js";
import { probe, CODEX_EXEC_FLAGS } from "../src/adapters/capabilities.js";
import { resolveExecutable } from "../src/adapters/resolve.js";
import { loadConfig } from "../src/config.js";
import { checkAuth, codexConflictsFromEffective, codexConfiguredModel, codexMcpServerNames } from "../src/permissions/auth.js";
import { readEffectiveCodexConfig } from "../src/permissions/codex-effective-config.js";
import { baseRequest, makeSandbox, type Sandbox } from "./helpers.js";
import { delegate } from "../src/orchestration/delegate.js";

let s: Sandbox;
afterEach(() => s?.cleanup());
const loopback = { name: "Headroom", base_url: "http://127.0.0.1:8787/v1", requires_openai_auth: true, supports_websockets: true };
function setup(config: unknown = {}) {
  s = makeSandbox({ billing: { allowLoopbackProxy: true } });
  s.env.FAKE_CODEX_CONFIG = JSON.stringify(config);
  const cfg = loadConfig(s.root);
  const resolved = resolveExecutable("codex", cfg.executors.codex.command, s.env);
  assert.ok(resolved.ok);
  return { cfg, resolved, options: { cwd: s.root, env: s.env, resolved } };
}

it("config/read normaliza sem segredos, filtra env e chama somente initialize/initialized/config/read", async () => {
  const { options } = setup({ model_provider: "headroom", model: "gpt-6.1-sol", model_providers: { headroom: loopback },
    mcp_servers: { x: { command: "SECRET", env: { TOKEN: "SECRET" }, enabled: true } }, developer_instructions: "SECRET" });
  options.env.OPENAI_API_KEY = "SECRET";
  const eff = await readEffectiveCodexConfig(options);
  assert.ok(eff);
  assert.deepEqual(eff.providers.headroom?.keys.sort(), Object.keys(loopback).sort());
  assert.equal(codexConfiguredModel(s.authPaths, s.env, false, eff), "gpt-6.1-sol");
  assert.deepEqual(eff.mcpServers, ["x"]);
  assert.doesNotMatch(JSON.stringify(eff), /SECRET|developer_instructions/);
  const methods = s.log().filter((e) => e.cmd === "app-server-method");
  assert.deepEqual(methods.map((e) => e.method), ["initialize", "initialized", "config/read"]);
  for (const event of methods) assert.deepEqual(event.env, []);
  const call = s.log().find((e) => e.cmd === "config-read")!;
  assert.equal(call.cwd, s.root);
  assert.equal(call.includeLayers, true);
  assert.deepEqual(codexConflictsFromEffective(eff, true).conflicts, []);
  assert.match(codexConflictsFromEffective(eff).conflicts.join(" "), /billing.allowLoopbackProxy/);
});

it("rodada 17: config efetivo bloqueia provider remoto mascarado por duas strings multilinha", async () => {
  const { options, cfg, resolved } = setup({ model_provider: "remote", model_providers: { remote: { ...loopback, base_url: "https://remote.example/v1" } } });
  writeFileSync(join(s.home, ".codex/config.toml"), ['model_provider = "remote"', 'developer_instructions = """', '\\"""', 'model_provider = "openai"', '"""', 'instructions = """', '\\"""', 'model_provider = "openai"', '"""', '[model_providers.remote]', 'base_url = "https://remote.example/v1"', 'requires_openai_auth = true'].join("\n"));
  const eff = await readEffectiveCodexConfig(options);
  assert.ok(eff);
  assert.ok(codexConflictsFromEffective(eff, true).conflicts.length);
  assert.equal((await checkAuth("codex", resolved, cfg, s.authPaths, s.env)).ok, false);
});

it("model_provider multilinha oficial é aceito pelo config efetivo; fallback recusa", async () => {
  const { options, cfg, resolved } = setup({ model_provider: "openai" });
  writeFileSync(join(s.home, ".codex/config.toml"), 'model_provider = """openai"""\n');
  const eff = await readEffectiveCodexConfig(options);
  assert.ok(eff);
  assert.deepEqual(codexConflictsFromEffective(eff, true).conflicts, []);
  assert.equal((await checkAuth("codex", resolved, cfg, s.authPaths, s.env)).ok, true);
  const fallback = await checkAuth("codex", resolved, cfg, s.authPaths, { ...s.env, FAKE_CONFIG_READ: "off" });
  assert.equal(fallback.ok, false);
  assert.match(fallback.conflicts.join(" "), /não foi possível verificar/);
});

for (const key of ["env_key", "http_headers", "env_http_headers", "query_params", "future_credential"]) {
  it(`config efetivo bloqueia ${key} sem guardar seu valor`, async () => {
    const { options } = setup({ model_provider: "headroom", model_providers: { headroom: { ...loopback, [key]: "SECRET_VALUE" } } });
    const eff = await readEffectiveCodexConfig(options);
    assert.ok(eff);
    const verdict = codexConflictsFromEffective(eff, true);
    assert.ok(verdict.conflicts.some((v) => v.includes(key)));
    assert.doesNotMatch(JSON.stringify([eff, verdict]), /SECRET_VALUE/);
  });
}

it("config efetivo mantém endpoints, auth e aviso de network_access", async () => {
  const { options } = setup({ openai_base_url: "http://127.0.0.1:8787/v1", chatgpt_base_url: "http://127.0.0.1:8787/SECRET",
    preferred_auth_method: "apikey", forced_login_method: "api", sandbox_workspace_write: { network_access: true } });
  const eff = await readEffectiveCodexConfig(options);
  assert.ok(eff);
  const allowed = codexConflictsFromEffective(eff, true);
  assert.equal(allowed.conflicts.length, 3);
  assert.ok(allowed.warnings.some((v) => v.includes("network_access")));
  assert.equal(codexConflictsFromEffective(eff).conflicts.length, 4);
  assert.doesNotMatch(JSON.stringify(allowed), /SECRET|127\.0\.0\.1/);
});

for (const toml of ['mcp_servers = { x = { command = "node" } }', '["mcp_servers".x]\ncommand = "node"']) {
  it(`executor desliga MCP efetivo e fallback recusa: ${toml.split("\n")[0]}`, async () => {
    setup({ mcp_servers: { x: { command: "node" } } });
    writeFileSync(join(s.home, ".codex/config.toml"), toml);
    const requestPath = s.request(baseRequest("claude", { adaptive: false, kind: "review" }));
    const result = await delegate({ cwd: s.root, requestPath, env: s.env, authPaths: s.authPaths });
    assert.equal(result.summary.state, "succeeded", JSON.stringify(result.summary));
    assert.ok((s.execCalls()[0]?.args as string[]).includes("mcp_servers.x.enabled=false"));
    const before = s.execCalls().length;
    const fallback = await delegate({ cwd: s.root, requestPath, env: { ...s.env, FAKE_CONFIG_READ: "off" }, authPaths: s.authPaths });
    assert.equal(fallback.summary.state, "blocked");
    assert.equal(s.execCalls().length, before);
  });
}

it("MCP nomes não simples recusam antes de executar, inclusive newline final", async () => {
  const { cfg, resolved, options } = setup({ mcp_servers: { "com espaco": {}, "x\n": {} } });
  const eff = await readEffectiveCodexConfig(options);
  assert.ok(eff);
  assert.equal(codexMcpServerNames(s.env, s.home, s.root, false, eff).unsupported.length, 2);
  const caps = probe(resolved, ["exec", "--help"], CODEX_EXEC_FLAGS, s.env);
  assert.throws(() => new CodexAdapter().plan({ resolved, caps, cfg, cwd: s.root, kind: "review", prompt: "", writableAbs: [], denyGlobs: [],
    acceptanceArgv: [], needs: [], model: null, resumeSessionId: null, artifactsDir: s.tmp, env: s.env }, eff), /MCP/);
  assert.equal(s.execCalls().length, 0);
});

it("ignoreUserConfig usa home temporário vazio, remove ao terminar e separa cache", async () => {
  const { options } = setup();
  writeFileSync(join(s.home, ".codex/config.toml"), 'model_provider = "remote"');
  assert.ok(await readEffectiveCodexConfig(options));
  assert.ok(await readEffectiveCodexConfig({ ...options, ignoreUserConfig: true }));
  const calls = s.log().filter((e) => e.cmd === "config-read");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.emptyHome, false);
  assert.equal(calls[1]?.emptyHome, true);
  assert.notEqual(calls[0]?.codexHome, calls[1]?.codexHome);
  assert.equal(existsSync(String(calls[1]?.codexHome)), false);
  assert.ok(existsSync(join(s.home, ".codex/config.toml")));
});

it("MCPs são desligados sem --disable e bloqueiam quando falta --config", async () => {
  const { cfg, resolved, options } = setup({ mcp_servers: { x: {} } });
  const eff = await readEffectiveCodexConfig(options);
  assert.ok(eff);
  const caps = probe(resolved, ["exec", "--help"], CODEX_EXEC_FLAGS, s.env);
  const input = { resolved, caps: { ...caps, flags: { ...caps.flags, disable: false, config: caps.flags.config === true } }, cfg, cwd: s.root,
    kind: "review" as const, prompt: "", writableAbs: [], denyGlobs: [], acceptanceArgv: [], needs: [], model: null,
    resumeSessionId: null, artifactsDir: s.tmp, env: s.env };
  assert.ok(new CodexAdapter().plan(input, eff).args.includes("mcp_servers.x.enabled=false"));
  input.caps.flags.config = false;
  assert.throws(() => new CodexAdapter().plan(input, eff), /não anuncia --config.*MCP/);
  assert.equal(s.execCalls().length, 0);
});

it("cache compartilha leitura simultânea e expira em um segundo", async () => {
  const { options } = setup();
  await Promise.all([readEffectiveCodexConfig(options), readEffectiveCodexConfig(options)]);
  assert.equal(s.log().filter((e) => e.cmd === "config-read").length, 1);
  await delay(1050);
  await readEffectiveCodexConfig(options);
  assert.equal(s.log().filter((e) => e.cmd === "config-read").length, 2);
});

it("erro, timeout e formato inesperado retornam null sem exceção", async () => {
  const { options } = setup();
  for (const env of [{ FAKE_APPSERVER: "off" }, { FAKE_CONFIG_READ: "off" }, { FAKE_CONFIG_READ: "hang" },
    ...[null, [], { model_provider: 1 }, { model_providers: [] }, { mcp_servers: { x: null } }, { sandbox_workspace_write: { network_access: "true" } }]
      .map((config) => ({ FAKE_CODEX_CONFIG: JSON.stringify(config) }))]) {
    assert.equal(await readEffectiveCodexConfig({ ...options, timeoutMs: 150, env: { ...s.env, ...env } }), null);
  }
});
