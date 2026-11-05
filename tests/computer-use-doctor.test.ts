import { strict as assert } from "node:assert";
import childProcess = require("node:child_process");
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, mock } from "node:test";
import { computerUseDiagnostics, doctor, formatDoctor } from "../src/cli/doctor.js";

const roots: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "duo-cu-doctor-"));
  roots.push(home);
  const codexHome = join(home, ".codex");
  return { home, codexHome, env: { HOME: home, USERPROFILE: home } };
}
function cache(codexHome: string, name: string) {
  const version = join(codexHome, "plugins", "cache", "openai-bundled", name, "1.0.0");
  mkdirSync(join(version, ".codex-plugin"), { recursive: true });
  writeFileSync(join(version, ".codex-plugin", "plugin.json"), JSON.stringify({ name }));
  return version;
}
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reports default opt-out, missing plugins and unsupported per-task enforcement", () => {
  const { env } = fixture();
  const report = computerUseDiagnostics({ enabled: false }, env, "darwin");
  assert.equal(report.configuredOptIn, false);
  assert.equal(report.platform, "darwin");
  assert.equal(report.macosSupported, true);
  assert.equal(report.plugin, "computer-use@openai-bundled");
  assert.equal(report.runtime, "unified-computer-use@openai-bundled");
  assert.equal(report.pluginPresent, false);
  assert.equal(report.runtimePresent, false);
  assert.equal(report.available, false);
  assert.equal(report.appEnforcement, "unsupported");
  assert.match(report.reason, /DISABLED.*per-task app enforcement is unsupported/);
});

it("distinguishes the old plugin from the actual runtime cache", () => {
  const { codexHome, env } = fixture();
  cache(codexHome, "computer-use");
  let report = computerUseDiagnostics({ enabled: true }, env, "darwin");
  assert.equal(report.pluginPresent, true);
  assert.equal(report.runtimePresent, false);
  assert.equal(report.available, false);
  cache(codexHome, "unified-computer-use");
  report = computerUseDiagnostics({ enabled: true }, env, "darwin");
  assert.equal(report.configuredOptIn, true);
  assert.equal(report.pluginPresent, true);
  assert.equal(report.runtimePresent, true);
  assert.equal(report.available, false);
  assert.equal(report.appEnforcement, "unsupported");
});

it("reports runtime-only presence without claiming the old plugin is present", () => {
  const { codexHome, env } = fixture();
  cache(codexHome, "unified-computer-use");
  const report = computerUseDiagnostics({ enabled: false }, env, "darwin");
  assert.equal(report.pluginPresent, false);
  assert.equal(report.runtimePresent, true);
  assert.equal(report.available, false);
});

it("keeps Linux and Windows unsupported even with opt-in and both caches", () => {
  const { codexHome, env } = fixture();
  cache(codexHome, "computer-use");
  cache(codexHome, "unified-computer-use");
  for (const platform of ["linux", "win32"] as const) {
    const report = computerUseDiagnostics({ enabled: true }, env, platform);
    assert.equal(report.platform, platform);
    assert.equal(report.macosSupported, false);
    assert.equal(report.pluginPresent, true);
    assert.equal(report.runtimePresent, true);
    assert.equal(report.available, false);
    assert.equal(report.appEnforcement, "unsupported");
  }
});

it("honors CODEX_HOME instead of merging evidence from the default home", () => {
  const { home, codexHome, env } = fixture();
  cache(codexHome, "computer-use");
  const customHome = join(home, "custom-codex");
  cache(customHome, "unified-computer-use");
  const report = computerUseDiagnostics({ enabled: true }, { ...env, CODEX_HOME: customHome }, "darwin");
  assert.equal(report.pluginPresent, false);
  assert.equal(report.runtimePresent, true);
  assert.equal(report.available, false);
});

it("does not count empty cache directories, version files or missing manifests", () => {
  const { codexHome, env } = fixture();
  const plugin = join(codexHome, "plugins", "cache", "openai-bundled", "computer-use");
  mkdirSync(plugin, { recursive: true });
  assert.equal(computerUseDiagnostics({ enabled: true }, env, "darwin").pluginPresent, false);
  writeFileSync(join(plugin, "1.0.0"), "incomplete cache");
  mkdirSync(join(plugin, "2.0.0"));
  mkdirSync(join(plugin, "3.0.0", ".codex-plugin", "plugin.json"), { recursive: true });
  assert.equal(computerUseDiagnostics({ enabled: true }, env, "darwin").pluginPresent, false);
});

it("discovers presence without launching subprocesses, UI, MCP or inference", () => {
  const { codexHome, env } = fixture();
  const version = cache(codexHome, "unified-computer-use");
  cache(codexHome, "computer-use");
  // Even an installed MCP must remain inert; discovery must not execute it.
  writeFileSync(join(version, ".mcp.json"), JSON.stringify({ mcpServers: { cua: { command: "must-not-run" } } }));
  const spies = (["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const).map((name) =>
    mock.method(childProcess, name, () => { throw new Error("discovery must not launch a process"); }));
  syncBuiltinESMExports();
  const report = computerUseDiagnostics({ enabled: true }, env, "darwin");
  assert.equal(report.pluginPresent, true);
  assert.equal(report.runtimePresent, true);
  assert.equal(report.available, false);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

it("includes loaded project opt-in and cache evidence in doctor JSON and text without AI CLIs", async () => {
  const { home, codexHome, env } = fixture();
  cache(codexHome, "computer-use");
  cache(codexHome, "unified-computer-use");
  mkdirSync(join(home, ".duo"));
  const absent = join(home, "absent-cli");
  for (const enabled of [false, true]) {
    writeFileSync(join(home, ".duo", "config.json"), JSON.stringify({
      computerUse: { enabled },
      discovery: { checkCliUpdates: false },
      executors: { claude: { command: [absent] }, codex: { command: [absent] } },
    }));
    const report = await doctor(home, { ...env, PATH: "" }, undefined, async () => {
      throw new Error("offline doctor must not fetch");
    });
    assert.equal(report.computerUse?.configuredOptIn, enabled);
    assert.equal(report.computerUse?.platform, process.platform);
    assert.equal(report.computerUse?.pluginPresent, true);
    assert.equal(report.computerUse?.runtimePresent, true);
    assert.equal(report.computerUse?.available, false);
    const text = formatDoctor(report);
    assert.match(text, new RegExp(`configuredOptIn=${enabled}`));
    assert.match(text, /computer-use@openai-bundled: pluginPresent=true/);
    assert.match(text, /unified-computer-use@openai-bundled: runtimePresent=true/);
    assert.match(text, /available=false \| per-task appEnforcement=unsupported/);
    assert.match(text, /DISABLED/);
  }
});
