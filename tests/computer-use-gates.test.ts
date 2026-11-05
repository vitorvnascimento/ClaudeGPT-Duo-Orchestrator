import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { InvocationInput } from "../src/adapters/types.js";
import { loadConfig } from "../src/config.js";
import { delegate } from "../src/orchestration/delegate.js";
import { computerUseBlockReason } from "../src/permissions/computer-use.js";
import { Store } from "../src/state/store.js";
import { baseRequest, makeSandbox } from "./helpers.js";

const cu = { needs: ["computer_use"], apps: ["Finder"], executor: "codex" };
const unavailable = /restrição de apps por tarefa/;

describe("computer use fail-closed", () => {
  it("validates opt-in, executor, platform, bounded apps and forbidden aliases", () => {
    assert.match(computerUseBlockReason({ executor: "codex", apps: ["Finder"] }, true, "darwin")!, /needs/);
    assert.equal(computerUseBlockReason({ executor: "codex" }, false, "linux"), null);
    assert.match(computerUseBlockReason(cu, false, "darwin")!, /enabled/);
    assert.match(computerUseBlockReason({ ...cu, executor: "claude" }, true, "darwin")!, /codex/);
    for (const platform of ["linux", "win32"]) {
      assert.match(computerUseBlockReason(cu, true, platform)!, /ainda não validado nesta plataforma/);
    }
    for (const apps of [undefined, [], [" "], ["x".repeat(201)], Array(21).fill("Finder"), [7]]) {
      assert.match(computerUseBlockReason({ ...cu, apps }, true, "darwin")!, /exige apps/);
    }
    const forbidden = ["MAIL.app", "/Applications/Messages.app", "com.apple.MobileSMS", "Keychain Access.app", "com.apple.keychainaccess",
      "1Password 8.app", "com.1password.1password", "BITWARDEN.app", "com.bitwarden.desktop",
      "System Settings.app", "System Preferences.app", "com.apple.systempreferences", "Terminal.app", "com.apple.Terminal",
      "iTerm.app", "iTerm2.app", "com.googlecode.iterm2", "Codex.app", "com.openai.codex", "ChatGPT.app", "com.openai.chat"];
    for (const app of forbidden) assert.match(computerUseBlockReason({ ...cu, apps: [app] }, true, "darwin")!, /proibido/, app);
    assert.match(computerUseBlockReason(cu, true, "darwin")!, unavailable);
  });

  it("rejects new requests and resumed tasks before invoking either executor", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const s = makeSandbox({ computerUse: { enabled: true }, executors: { codex: { disableUserExtensions: false } } });
    try {
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ apps: ["Finder"] }, /needs/],
        [{ needs: ["computer_use"], apps: ["Finder"], executor: "claude", model: "another-model" }, /codex/],
        [{ needs: ["computer_use"] }, /exige apps/],
        [{ needs: ["computer_use"], apps: ["/Applications/Mail.app"] }, /proibido/],
        [{ needs: ["computer_use"], apps: ["Finder"] }, unavailable],
      ];
      for (const [overrides, reason] of cases) {
        const result = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", overrides)), env: s.env, authPaths: s.authPaths });
        assert.match(String(result.summary.error), reason);
        assert.equal(s.log().length, 0);
      }
      s.config({ computerUse: { enabled: false } });
      const disabled = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", cu)), env: s.env, authPaths: s.authPaths });
      assert.match(String(disabled.summary.error), /enabled/);
      assert.equal(s.log().length, 0);
      s.config({ computerUse: { enabled: true } });

      // Cria uma task bloqueada no aceite e simula uma retomada antiga de CU.
      const seed = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { acceptance: { criteria: ["validado"], commands: [{ name: "blocked", argv: ["forbidden-command"] }] } })), env: s.env, authPaths: s.authPaths });
      assert.equal(seed.summary.state, "blocked", JSON.stringify(seed.summary));
      const store = new Store(s.root);
      const task = store.findTask(String(seed.summary.taskId));
      assert.ok(task);
      const chain = store.chainForTask(task);
      task.needs = ["computer_use"];
      task.apps = ["Finder"];
      store.saveTask(task);
      writeFileSync(chain.originalRequestPath, JSON.stringify(baseRequest("claude", cu)));
      const before = s.log().length;
      const resumed = await delegate({ cwd: s.root, resumeTaskId: task.taskId, env: s.env, authPaths: s.authPaths });
      assert.match(String(resumed.summary.error), unavailable);
      assert.equal(s.log().length, before);
      assert.equal(s.execCalls().length, 0);
      writeFileSync(chain.originalRequestPath, JSON.stringify(baseRequest("claude")));
      const resumedTaskOnly = await delegate({ cwd: s.root, resumeTaskId: task.taskId, env: s.env, authPaths: s.authPaths });
      assert.match(String(resumedTaskOnly.summary.error), unavailable);
      assert.equal(s.log().length, before);
    } finally {
      s.cleanup();
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("blocks direct adapter calls before writing a plan and preserves ordinary argv", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const s = makeSandbox({ computerUse: { enabled: true }, executors: { codex: { disableUserExtensions: false } } });
    try {
      const input: InvocationInput = {
        resolved: { ok: true, command: "codex", prefixArgs: [], source: "config" },
        caps: { version: null, flags: { config: true }, missingRequired: [], divergences: [] },
        cfg: loadConfig(s.root), cwd: s.root, kind: "review", prompt: "prompt", writableAbs: [], denyGlobs: [], acceptanceArgv: [],
        needs: [], model: null, resumeSessionId: null, artifactsDir: s.tmp, env: s.env,
      };
      const adapter = new CodexAdapter();
      const ordinary = adapter.plan(input);
      assert.deepEqual(ordinary.args, ["exec", "--json", "--sandbox", "read-only", "--cd", s.root, "--output-schema", ordinary.args[7], "-"]);
      for (const resumeSessionId of [null, "session-id"]) {
        assert.throws(() => adapter.plan({ ...input, needs: ["computer_use"], apps: ["Finder"], resumeSessionId }), unavailable);
        assert.throws(() => adapter.plan({ ...input, needs: ["computer_use"], apps: ["Mail"], resumeSessionId }), /proibido/);
      }
      assert.throws(() => adapter.plan({ ...input, apps: ["Finder"] }), /needs/);
      assert.equal(s.log().length, 0);
    } finally {
      s.cleanup();
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
