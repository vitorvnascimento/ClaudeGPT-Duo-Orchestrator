// Executor Gemini (v0.5): tipos, config, schema e ambiente. Offline: nenhum agy real é chamado.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConfigError, configPath, DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { delegate } from "../src/orchestration/delegate.js";
import { childEnv } from "../src/permissions/auth.js";
import { baseRequest, makeSandbox, type Sandbox } from "./helpers.js";

let root: string | undefined;
let sb: Sandbox | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  sb?.cleanup();
  sb = undefined;
});

function withConfig(cfg: Record<string, unknown>): string {
  root ??= mkdtempSync(join(tmpdir(), "duo-gemini-config-"));
  mkdirSync(join(root, ".duo"), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(cfg));
  return root;
}

describe("config do executor gemini", () => {
  it("gemini disabled by default", () => {
    assert.equal(DEFAULT_CONFIG.executors.gemini.enabled, false);
    assert.equal(DEFAULT_CONFIG.executors.gemini.command, null);
    assert.equal(DEFAULT_CONFIG.billing.acknowledgeUnverifiableExtraUsage.gemini, false);
  });

  it("gemini command override must be one absolute path", () => {
    const dir = withConfig({ executors: { gemini: { command: ["/usr/local/bin/agy", "--dangerously-skip-permissions"] } } });
    assert.throws(() => loadConfig(dir), (e: unknown) => e instanceof ConfigError && /executors\.gemini\.command/.test((e as Error).message));
    writeFileSync(configPath(dir), JSON.stringify({ executors: { gemini: { command: ["agy"] } } }));
    assert.throws(() => loadConfig(dir), /executors\.gemini\.command/);
    writeFileSync(configPath(dir), JSON.stringify({ executors: { gemini: { command: ["/usr/local/bin/agy"] } } }));
    assert.deepEqual(loadConfig(dir).executors.gemini.command, ["/usr/local/bin/agy"]);
  });

  it("gemini.enabled must be a literal boolean", () => {
    const dir = withConfig({ executors: { gemini: { enabled: "yes" } } });
    assert.throws(() => loadConfig(dir), /executors\.gemini\.enabled/);
  });

  it("config with gemini enabled loads on any platform", () => {
    const dir = withConfig({ executors: { gemini: { enabled: true } }, billing: { acknowledgeUnverifiableExtraUsage: { gemini: true } } });
    const cfg = loadConfig(dir);
    assert.equal(cfg.executors.gemini.enabled, true);
    assert.equal(cfg.billing.acknowledgeUnverifiableExtraUsage.gemini, true);
  });

  it("childEnv strips Google credentials", () => {
    const { env, removed } = childEnv({
      PATH: "/bin",
      GEMINI_API_KEY: "x", GOOGLE_API_KEY: "x", GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_APPLICATION_CREDENTIALS: "/x.json",
      GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "us", AGY_ADC_AUTH: "1",
    });
    for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "AGY_ADC_AUTH"]) {
      assert.ok(removed.includes(k), k);
      assert.equal(env[k], undefined, k);
    }
    assert.equal(env.PATH, "/bin");
  });
});

describe("pedido com executor gemini", () => {
  it("readRequest accepts executor gemini and rejects brain gemini", async () => {
    sb = makeSandbox();
    const path = join(sb.root, ".duo", "req-gemini.json");
    writeFileSync(path, JSON.stringify(baseRequest("claude", { executor: "gemini" })));
    const out = await delegate({ cwd: sb.root, requestPath: path, env: sb.env, authPaths: sb.authPaths });
    assert.notEqual(out.summary.error, "pedido fora do schema");
    assert.match(String(out.summary.outcome ?? out.summary.error), /gemini.*desabilitado/);
    writeFileSync(path, JSON.stringify(baseRequest("claude", { brain: "gemini" })));
    const bad = await delegate({ cwd: sb.root, requestPath: path, env: sb.env, authPaths: sb.authPaths });
    assert.equal(bad.summary.error, "pedido fora do schema");
    assert.equal(sb.execCalls().length, 0);
  });

  it("enabled gemini with an agy version outside the verified list blocks before invoking", async () => {
    sb = makeSandbox({ executors: { gemini: { enabled: true } }, billing: { acknowledgeUnverifiableExtraUsage: { gemini: true } } });
    const path = join(sb.root, ".duo", "req-gemini.json");
    writeFileSync(path, JSON.stringify(baseRequest("claude", { executor: "gemini" })));
    const out = await delegate({ cwd: sb.root, requestPath: path, env: sb.env, authPaths: sb.authPaths });
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.match(String(out.summary.outcome), /gemini|agy/);
    assert.equal(sb.execCalls().length, 0);
  });
});
