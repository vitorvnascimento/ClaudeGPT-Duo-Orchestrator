import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { InvocationInput } from "../src/adapters/types.js";
import { loadConfig } from "../src/config.js";
import { computerUseBlockReason } from "../src/permissions/computer-use.js";
import { readEffectiveCodexConfig } from "../src/permissions/codex-effective-config.js";
import { resolveExecutable } from "../src/adapters/resolve.js";
import { evaluateCandidates } from "../src/orchestration/router.js";
import { Store } from "../src/state/store.js";
import { adaptiveCatalog } from "./adaptive-catalog.js";
import { FAKE_CODEX, makeSandbox } from "./helpers.js";

describe("computer use gates and extension isolation", () => {
  it("requires opt-in, Codex and macOS, with a nonempty bounded app list", () => {
    const cu = { executor: "codex", needs: ["computer_use"] };
    assert.match(computerUseBlockReason(cu, true, "darwin")!, /apps/);
    assert.match(computerUseBlockReason({ ...cu, apps: [] }, true, "darwin")!, /apps/);
    for (const app of ["Mail", "Passwords", "com.apple.ScriptEditor2", "com.apple.shortcuts", "com.apple.Automator",
      "com.mitchellh.ghostty", "dev.warp.Warp-Stable", "org.alacritty", "net.kovidgoyal.kitty", "com.github.wez.wezterm",
      "co.zeit.hyper", "com.anthropic.claudefordesktop", "Settings", "com.apple.Preferences", "com.apple.Console",
      "com.apple.ActivityMonitor", "com.apple.DiskUtility", "Keychain"]) {
      assert.match(computerUseBlockReason({ ...cu, apps: [app] }, true, "darwin")!, /proibido/, app);
    }
    assert.match(computerUseBlockReason(cu, false, "darwin")!, /enabled/);
    assert.match(computerUseBlockReason({ ...cu, executor: "claude" }, true, "darwin")!, /codex/);
    assert.match(computerUseBlockReason(cu, true, "linux")!, /plataforma/);
    assert.match(computerUseBlockReason({ ...cu, needs: ["computer_use", "image_generation"] }, true, "darwin")!, /image_generation/);
    assert.match(computerUseBlockReason({ executor: "codex", apps: ["Finder"] }, true, "darwin")!, /needs/);
    for (const apps of [null, [""], ["/path/to/App"], Array(21).fill("Finder"), [7]]) assert.ok(computerUseBlockReason({ ...cu, apps }, true, "darwin"));
  });

  it("selects only Codex candidates even if a Claude catalog entry claims computer use", t => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    t.after(() => { Object.defineProperty(process, "platform", platform); });
    const s = makeSandbox();
    t.after(() => s.cleanup());
    const catalog = structuredClone(adaptiveCatalog);
    for (const model of catalog.providers.claude.models) model.capabilities.push("computer_use");
    const result = evaluateCandidates(new Store(s.root), loadConfig(s.root), { kind: "review", tags: [], risk: "low",
      brain: null, needs: ["computer_use"] }, () => ({ available: true, reasons: [] }), catalog);
    assert.deepEqual([...new Set(result.evals.map(entry => entry.executor))], ["codex"]);
  });

  it("disables configured plugins and MCPs even when ordinary extension disabling is off", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const s = makeSandbox({ computerUse: { enabled: true }, executors: { codex: { disableUserExtensions: false } } });
    try {
      const env = { ...s.env, FAKE_CODEX_CONFIG: JSON.stringify({ plugins: { "other@market": { enabled: true } }, mcp_servers: { extra: { enabled: true } } }),
        FAKE_CODEX_LAYERS: JSON.stringify([{ config: { plugins: { "layer@market": { enabled: true } }, mcp_servers: { old: {} } } }]) };
      const resolved = resolveExecutable("codex", ["node", FAKE_CODEX], env); assert.ok(resolved.ok);
      const effective = await readEffectiveCodexConfig({ cwd: s.root, env, resolved }); assert.ok(effective);
      const input: InvocationInput = { resolved, caps: { version: null, flags: { config: true, enable: true, disable: true, outputLastMessage: true }, missingRequired: [], divergences: [] }, cfg: loadConfig(s.root), cwd: s.root, kind: "review", prompt: "", writableAbs: [], denyGlobs: [], acceptanceArgv: [], needs: ["computer_use"], apps: ["Finder"], model: null, resumeSessionId: null, artifactsDir: s.tmp, env };
      const adapter = new CodexAdapter();
      const plan = adapter.plan(input, effective);
      const writePlan = adapter.plan({ ...input, kind: "implement" }, effective);
      assert.ok(writePlan.args.includes("sandbox_workspace_write.writable_roots=[]"));
      for (const flag of ["plugins._default.enabled=false", 'plugins.other@market.enabled=false', 'plugins.layer@market.enabled=false', 'plugins.unified-computer-use@openai-bundled.enabled=true', 'mcp_servers.extra.enabled=false', 'mcp_servers.old.enabled=false', "hooks", "plugins"]) assert.ok(plan.args.includes(flag), flag);
      assert.equal(plan.lastMessagePath, null);
      const disabled = plan.args.filter((_, i) => plan.args[i - 1] === "--disable");
      assert.deepEqual(disabled, ["hooks", "apps"]);
      assert.ok(!plan.args.includes("--output-last-message"));
      assert.throws(() => adapter.plan(input, null), /enumeração/);
      for (const key of ["pluginKeys", "mcpKeys"] as const) {
        assert.throws(() => adapter.plan(input, { ...effective, [key]: ["unsafe.name"] }), /isolado com segurança/);
      }
      assert.throws(() => adapter.plan({ ...input, caps: { ...input.caps, flags: { ...input.caps.flags, disable: false } } }, effective), /--disable/);
      const ordinary = adapter.plan({ ...input, apps: undefined, needs: [] }, effective);
      assert.ok(ordinary.args.includes("plugins.unified-computer-use@openai-bundled.enabled=false"));
      assert.ok(!ordinary.args.includes("plugins._default.enabled=false"));
      assert.ok(ordinary.args.includes("--output-last-message"));
    } finally { s.cleanup(); Object.defineProperty(process, "platform", descriptor); }
  });
});
