import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConfigError, configPath, DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { childEnv, claudeSettingsConflicts, codexConfigConflicts, loopbackProxyOrigin, type AuthPaths } from "../src/permissions/auth.js";

describe("proxy local de loopback", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function sandbox(): { root: string; paths: AuthPaths; env: NodeJS.ProcessEnv; claudeSettings: string; codexConfig: string } {
    const root = mkdtempSync(join(tmpdir(), "duo-auth-loopback-"));
    roots.push(root);
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const claudeDir = join(home, ".claude");
    const codexDir = join(home, ".codex");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    return {
      root,
      paths: { home, projectRoot, claudeManagedSettings: [] },
      env: { HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir },
      claudeSettings: join(claudeDir, "settings.json"),
      codexConfig: join(codexDir, "config.toml"),
    };
  }

  it("aceita somente host raw de loopback e devolve origem sem path/query", () => {
    for (const value of ["http://127.0.0.1:8787/v1", "https://localhost", "http://[::1]:443"]) {
      assert.ok(loopbackProxyOrigin(value));
    }
    assert.equal(loopbackProxyOrigin("https://127.0.0.1/v1?token=SESSION_SECRET"), "https://127.0.0.1");
    for (const value of [
      "http://127.0.0.1.evil.com",
      "http://127.0.0.1@evil.com",
      "http://2130706433",
      "http://127.000.000.001",
      "http://[::ffff:127.0.0.1]",
      "ftp://127.0.0.1",
    ]) {
      assert.equal(loopbackProxyOrigin(value), null, value);
    }
  });

  it("mantém o bloqueio do Claude por padrão e autoriza somente a exceção explícita", () => {
    const s = sandbox();
    writeFileSync(s.claudeSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/v1" } }));
    const blocked = claudeSettingsConflicts(s.paths, s.env);
    assert.equal(blocked.conflicts.length, 1);
    assert.match(blocked.conflicts[0]!, /billing\.allowLoopbackProxy/);

    const allowed = claudeSettingsConflicts(s.paths, s.env, true);
    assert.deepEqual(allowed.conflicts, []);
    assert.match(allowed.warnings[0]!, /proxy local \(loopback\) autorizado por billing\.allowLoopbackProxy: http:\/\/127\.0\.0\.1:8787/);
  });

  it("aceita localhost e IPv6 nas settings somente com opt-in", () => {
    const s = sandbox();
    for (const url of ["https://localhost:8787/v1", "http://[::1]:8787/v1"]) {
      writeFileSync(s.claudeSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }));
      assert.equal(claudeSettingsConflicts(s.paths, s.env).conflicts.length, 1);
      const claude = claudeSettingsConflicts(s.paths, s.env, true);
      assert.deepEqual(claude.conflicts, []);
      assert.match(claude.warnings[0]!, /proxy local \(loopback\) autorizado por billing\.allowLoopbackProxy/);
    }

    for (const host of ["localhost:8787", "[::1]:8787"]) {
      writeFileSync(s.codexConfig, [
        'model_provider = "headroom"',
        "[model_providers.headroom]",
        `base_url = "http://${host}/v1"`,
        "requires_openai_auth = true",
      ].join("\n"));
      const blocked = codexConfigConflicts(s.paths, s.env);
      assert.equal(blocked.conflicts.length, 1);
      assert.match(blocked.conflicts[0]!, /billing\.allowLoopbackProxy/);
      assert.deepEqual(codexConfigConflicts(s.paths, s.env, true).conflicts, []);
    }
  });

  it("não ecoa valor sensível quando a URL do Claude não é autorizável", () => {
    const s = sandbox();
    const secret = "SESSION_SECRET";
    writeFileSync(s.claudeSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://evil.example/?token=${secret}` } }));
    const result = claudeSettingsConflicts(s.paths, s.env, true);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.conflicts.length, 1);
    assert.ok(!JSON.stringify(result).includes(secret));
  });

  it("autoriza o Codex só com auth OpenAI e sem chaves de credencial", () => {
    const s = sandbox();
    writeFileSync(s.codexConfig, [
      'model_provider = "headroom"',
      "[model_providers.headroom]",
      'base_url = "http://127.0.0.1:8787/v1"',
      "requires_openai_auth = true",
    ].join("\n"));
    const allowed = codexConfigConflicts(s.paths, s.env, true);
    assert.deepEqual(allowed.conflicts, []);
    assert.match(allowed.warnings[0]!, /proxy local \(loopback\) autorizado/);
    const optOut = codexConfigConflicts(s.paths, s.env);
    assert.equal(optOut.conflicts.length, 1);
    assert.match(optOut.conflicts[0]!, /billing\.allowLoopbackProxy/);

    writeFileSync(s.codexConfig, [
      'model_provider = "headroom"',
      "[model_providers.headroom]",
      'base_url = "http://127.0.0.1:8787/v1"',
      "requires_openai_auth = true",
      'env_key = "SESSION_SECRET"',
    ].join("\n"));
    const secret = codexConfigConflicts(s.paths, s.env, true);
    assert.equal(secret.warnings.length, 0);
    assert.equal(secret.conflicts.length, 1);
    assert.ok(!JSON.stringify(secret).includes("SESSION_SECRET"));
  });

  it("recusa Codex sem requires_openai_auth ou com qualquer forma de credencial", () => {
    const s = sandbox();
    const base = ['model_provider = "headroom"', "[model_providers.headroom]", 'base_url = "http://127.0.0.1:8787/v1"'];
    writeFileSync(s.codexConfig, [...base].join("\n"));
    assert.equal(codexConfigConflicts(s.paths, s.env, true).conflicts.length, 1);

    const secret = "SESSION_SECRET";
    for (const credential of [
      `experimental_bearer_token = "${secret}"`,
      `http_headers = { Authorization = "${secret}" }`,
      `[model_providers.headroom.http_headers]\nAuthorization = "${secret}"`,
    ]) {
      writeFileSync(s.codexConfig, [...base, "requires_openai_auth = true", credential].join("\n"));
      const result = codexConfigConflicts(s.paths, s.env, true);
      assert.equal(result.warnings.length, 0);
      assert.equal(result.conflicts.length, 1);
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  });

  it("rejeita provedor remoto ou sem requires_openai_auth mesmo com a opção ligada", () => {
    const s = sandbox();
    writeFileSync(s.codexConfig, [
      'model_provider = "remote"',
      "[model_providers.remote]",
      'base_url = "https://api.example.test/v1"',
      "requires_openai_auth = true",
    ].join("\n"));
    assert.equal(codexConfigConflicts(s.paths, s.env, true).warnings.length, 0);
    assert.equal(codexConfigConflicts(s.paths, s.env, true).conflicts.length, 1);

    writeFileSync(s.codexConfig, [
      'model_provider = "headroom"',
      "[model_providers.headroom]",
      'base_url = "http://127.0.0.1:8787/v1"',
      "requires_openai_auth = false",
    ].join("\n"));
    assert.equal(codexConfigConflicts(s.paths, s.env, true).conflicts.length, 1);
  });

  it("adiciona o default false e rejeita tipo inválido na configuração", () => {
    const root = sandbox().root;
    assert.equal(DEFAULT_CONFIG.billing.allowLoopbackProxy, false);
    assert.equal(loadConfig(root).billing.allowLoopbackProxy, false);
    mkdirSync(join(root, ".duo"), { recursive: true });
    writeFileSync(configPath(root), JSON.stringify({ billing: { allowLoopbackProxy: true } }));
    assert.equal(loadConfig(root).billing.allowLoopbackProxy, true);
    writeFileSync(configPath(root), JSON.stringify({ billing: { allowLoopbackProxy: "true" } }));
    assert.throws(() => loadConfig(root), (error: unknown) => error instanceof ConfigError && /billing\.allowLoopbackProxy/.test(error.message));
  });

  it("remove ANTHROPIC_BASE_URL do ambiente do processo filho mesmo com proxy autorizado", () => {
    const result = childEnv({ PATH: "/bin", ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/v1" });
    assert.equal(result.env.ANTHROPIC_BASE_URL, undefined);
    assert.ok(result.removed.includes("ANTHROPIC_BASE_URL"));
    assert.equal(result.env.PATH, "/bin");
  });
});
