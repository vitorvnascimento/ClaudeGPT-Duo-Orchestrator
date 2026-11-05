import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { delegate } from "../src/orchestration/delegate.js";
import { applyTask } from "../src/orchestration/control.js";
import { Store } from "../src/state/store.js";
import { baseRequest, makeSandbox } from "./helpers.js";

describe("computer use runtime with fake Codex", () => {
  it("audits actions and screenshots, blocks permission denial, and resumes the same session without persisting private content", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const s = makeSandbox({ computerUse: { enabled: true }, executors: { codex: { disableUserExtensions: false } } });
    try {
      s.env.FAKE_CODEX_LAYERS = "[]";
      s.env.FAKE_SCENARIO = "cu-permission";
      const req = s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"], objective: "PRIVATE_USER_PROMPT_CANARY", acceptance: { criteria: ["PRIVATE_CRITERION_CANARY"] } }));
      const first = await delegate({ cwd: s.root, requestPath: req, env: s.env, authPaths: s.authPaths });
      assert.equal(first.summary.state, "blocked", JSON.stringify(first.summary));
      assert.deepEqual(first.summary.blockedReason, { kind: "app_permission", app: "Finder" });
      assert.match(String(first.summary.outcome), /aprove Finder no app do Codex \(sempre permitir\) e rode duo delegate --resume/);
      assert.match(JSON.stringify(first.summary.next), /sempre permitir/);
      const store = new Store(s.root);
      const before = store.findTask(String(first.summary.taskId)); assert.ok(before);
      assert.equal(before.native.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
      assert.equal(before.executorReport, null);
      s.env.FAKE_SCENARIO = "cu-success";
      const second = await delegate({ cwd: s.root, resumeTaskId: before.taskId, env: s.env, authPaths: s.authPaths });
      assert.equal(second.summary.state, "succeeded", JSON.stringify(second.summary));
      const task = store.findTask(before.taskId); assert.ok(task);
      assert.equal(task.blockedReason, undefined);
      assert.ok(task.evidence?.computerUse?.actions.some((a) => a.kind === "type"));
      assert.equal(task.evidence?.computerUse?.screenshots.length, 1);
      assert.equal(s.execCalls()[1]?.resume, before.native.sessionId);
      assert.equal(s.execCalls()[1]?.rebindPrompt, true);
      assert.ok(!applyTask(s.root, task.taskId).ok);
      const inspect = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) inspect(path);
          else if (!/\.(png|jpg)$/.test(entry.name)) assert.doesNotMatch(readFileSync(path, "utf8"), /PRIVATE_(USER_PROMPT|CRITERION|SCREEN|TYPED|STDERR|SUMMARY|LIMITATION|COMMAND)_CANARY/, path);
        }
      };
      inspect(join(s.root, ".duo"));
      assert.equal(existsSync(join(task.artifactsDir, "last-message.json")), false);
      assert.equal(existsSync(join(task.artifactsDir, "prompt.txt")), false);
    } finally { s.cleanup(); Object.defineProperty(process, "platform", platform); }
  });

  for (const scenario of ["cu-unlisted", "cu-sensitive", "cu-unknown", "cu-mismatch", "cu-modified", "cu-no-audit", "cu-permission-unlisted"]) {
    it(`fails closed for ${scenario}`, async () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      const s = makeSandbox({ computerUse: { enabled: true } });
      try {
        s.env.FAKE_CODEX_LAYERS = "[]"; s.env.FAKE_SCENARIO = scenario;
        if (scenario === "cu-modified") s.env.FAKE_WRITE = JSON.stringify({ "src/private.txt": "PRIVATE_REPO_CANARY" });
        const result = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
        assert.equal(result.summary.state, "failed", JSON.stringify(result.summary));
        const task = new Store(s.root).findTask(String(result.summary.taskId)); assert.ok(task);
        assert.equal(task.blockedReason, undefined);
        if (scenario === "cu-modified") {
          assert.equal(task.verification?.filesChangedCount, 1);
          assert.equal(task.verification?.patchPath, null);
          assert.equal(existsSync(join(task.worktree!, "src/private.txt")), true);
          assert.doesNotMatch(JSON.stringify(task), /PRIVATE_REPO_CANARY|private\.txt/);
        } else assert.ok(task.evidence?.computerUse?.violations.length);
      } finally { s.cleanup(); Object.defineProperty(process, "platform", platform); }
    });
  }

  it("backfills native calls from a bounded rollout when the stream omits them", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const s = makeSandbox({ computerUse: { enabled: true } });
    try {
      s.env.FAKE_CODEX_LAYERS = "[]"; s.env.FAKE_SCENARIO = "cu-rollout";
      const result = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"] })), env: s.env, authPaths: s.authPaths });
      assert.equal(result.summary.state, "succeeded", JSON.stringify(result.summary));
      const task = new Store(s.root).findTask(String(result.summary.taskId)); assert.ok(task);
      assert.deepEqual(task.evidence?.computerUse?.appsUsed, ["finder"]);
      assert.equal(task.evidence?.computerUse?.actions.length, 1);
      assert.doesNotMatch(JSON.stringify(task), /PRIVATE_SCREEN_CANARY/);
    } finally { s.cleanup(); Object.defineProperty(process, "platform", platform); }
  });

  it("does not approve an empty resume using only the prior permission attempt", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const s = makeSandbox({ computerUse: { enabled: true } });
    try {
      s.env.FAKE_CODEX_LAYERS = "[]"; s.env.FAKE_SCENARIO = "cu-permission";
      const first = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
      assert.equal(first.summary.state, "blocked");
      s.env.FAKE_SCENARIO = "cu-no-audit";
      const result = await delegate({ cwd: s.root, resumeTaskId: String(first.summary.taskId), env: s.env, authPaths: s.authPaths });
      assert.equal(result.summary.state, "failed");
      const task = new Store(s.root).findTask(String(first.summary.taskId)); assert.ok(task);
      assert.ok(task.evidence?.computerUse?.actions.length);
      assert.ok(task.evidence?.computerUse?.violations.includes("missing_auditable_actions"));
    } finally { s.cleanup(); Object.defineProperty(process, "platform", platform); }
  });

  it("rejects a different native session on resume", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const s = makeSandbox({ computerUse: { enabled: true } });
    try {
      s.env.FAKE_CODEX_LAYERS = "[]"; s.env.FAKE_SCENARIO = "cu-permission";
      const first = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
      assert.equal(first.summary.state, "blocked");
      s.env.FAKE_SCENARIO = "cu-session-mismatch";
      const result = await delegate({ cwd: s.root, resumeTaskId: String(first.summary.taskId), env: s.env, authPaths: s.authPaths });
      assert.equal(result.summary.state, "failed", JSON.stringify(result.summary));
      const task = new Store(s.root).findTask(String(first.summary.taskId)); assert.ok(task);
      assert.equal(task.native.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
      assert.ok(task.evidence?.computerUse?.violations.includes("native_session_mismatch"));
    } finally { s.cleanup(); Object.defineProperty(process, "platform", platform); }
  });
});
