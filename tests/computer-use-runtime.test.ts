import { strict as assert } from "node:assert";
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { type as osType } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { delegate } from "../src/orchestration/delegate.js";
import { applyTask, refreshInterrupted } from "../src/orchestration/control.js";
import { Store } from "../src/state/store.js";
import { baseRequest, makeSandbox } from "./helpers.js";

function setup(t: TestContext, config: Record<string, unknown> = {}) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => { Object.defineProperty(process, "platform", platform); });
  const sandbox = makeSandbox({ computerUse: { enabled: true }, ...config });
  t.after(() => sandbox.cleanup());
  sandbox.env.FAKE_CODEX_LAYERS = "[]";
  return sandbox;
}

describe("computer use runtime with fake Codex", () => {
  it("audits actions and screenshots, blocks permission denial, and resumes the same session without persisting private content", async t => {
    const s = setup(t, { executors: { codex: { disableUserExtensions: false } } });
    s.env.FAKE_SCENARIO = "cu-permission";
    const req = s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"], objective: "PRIVATE_USER_PROMPT_CANARY", acceptance: { criteria: ["PRIVATE_CRITERION_CANARY"] } }));
    const first = await delegate({ cwd: s.root, requestPath: req, env: s.env, authPaths: s.authPaths });
    assert.equal(first.summary.state, "blocked", JSON.stringify(first.summary));
    assert.deepEqual(first.summary.blockedReason, { kind: "app_permission", app: "Finder" });
    assert.match(String(first.summary.outcome), /Aprove somente Finder.*uma vez/);
    assert.match(JSON.stringify(first.summary.next), /uma vez/);
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
  });

  for (const scenario of ["cu-unlisted", "cu-sensitive", "cu-unknown", "cu-mismatch", "cu-modified", "cu-no-audit", "cu-permission-unlisted", "cu-stream-abort", "cu-missing-rollout"]) {
    it(`fails closed for ${scenario}`, async t => {
      const s = setup(t);
      s.env.FAKE_SCENARIO = scenario;
      if (scenario === "cu-missing-rollout") { s.env.FAKE_NO_ROLLOUT = "1"; s.env.FAKE_SCENARIO = "cu-success"; }
      if (scenario === "cu-modified") s.env.FAKE_WRITE = JSON.stringify({ "src/private.txt": "PRIVATE_REPO_CANARY" });
      const result = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
      assert.equal(result.summary.state, "failed", JSON.stringify(result.summary));
      const task = new Store(s.root).findTask(String(result.summary.taskId)); assert.ok(task);
      assert.equal(task.blockedReason, undefined);
      if (scenario === "cu-stream-abort") {
        assert.equal(existsSync(join(task.worktree!, "continued-after-violation")), false);
        if (osType() !== "Windows_NT") assert.equal(s.log().find(entry => entry.cmd === "violation-checkpoint")?.observed, true);
      }
      if (scenario === "cu-missing-rollout") assert.ok(task.evidence?.computerUse?.violations.includes("rollout_missing"));
      if (scenario === "cu-modified") {
        assert.equal(task.verification?.filesChangedCount, 1);
        assert.equal(task.verification?.patchPath, null);
        assert.equal(existsSync(join(task.worktree!, "src/private.txt")), true);
        assert.doesNotMatch(JSON.stringify(task), /PRIVATE_REPO_CANARY|private\.txt/);
      } else assert.ok(task.evidence?.computerUse?.violations.length);
    });
  }

  it("backfills native calls from a bounded rollout when the stream omits them", async t => {
    const s = setup(t);
    s.env.FAKE_SCENARIO = "cu-rollout";
    const result = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
    assert.equal(result.summary.state, "succeeded", JSON.stringify(result.summary));
    const task = new Store(s.root).findTask(String(result.summary.taskId)); assert.ok(task);
    assert.deepEqual(task.evidence?.computerUse?.appsUsed, ["finder"]);
    assert.equal(task.evidence?.computerUse?.actions.length, 1);
    assert.doesNotMatch(JSON.stringify(task), /PRIVATE_SCREEN_CANARY/);
  });

  it("publishes session and action evidence before the executor exits", async t => {
    const s = setup(t);
    Object.assign(s.env, { FAKE_SCENARIO: "cu-checkpoint" });
    const out = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const checkpoint = s.log().find(entry => entry.cmd === "checkpoint");
    assert.equal(checkpoint?.observed, true);
    assert.equal(checkpoint?.childRegistered, true);
    assert.equal(checkpoint?.isolation, "in-place");
    assert.equal(checkpoint?.exclusive, true);
  });

  for (const mode of ["bom", "historical violation", "missing rollout", "non-permission block", "missing session"]) it(`checks ${mode} on permission resume`, async t => {
    const s = setup(t);
    Object.assign(s.env, { FAKE_SCENARIO: "cu-permission" });
    const req = s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] }));
    if (mode === "bom") writeFileSync(req, "\uFEFF" + readFileSync(req, "utf8"));
    const first = await delegate({ cwd: s.root, requestPath: req, env: s.env, authPaths: s.authPaths });
    assert.equal(first.summary.state, "blocked");
    const store = new Store(s.root);
    const task = store.findTask(String(first.summary.taskId))!;
    if (mode === "historical violation" || mode === "missing rollout") {
      const sessions = join(s.env.CODEX_HOME!, "sessions");
      const rollout = readdirSync(sessions, { recursive: true, encoding: "utf8" }).find(file => file.endsWith(".jsonl"))!;
      if (mode === "missing rollout") unlinkSync(join(sessions, rollout));
      else appendFileSync(join(sessions, rollout), JSON.stringify({ type: "response_item", timestamp: task.evidence!.computerUse!.actions[0]!.at,
        payload: { type: "function_call", name: "mcp__cua_repl__js", call_id: "historical", arguments: JSON.stringify({ code: 'await cua.getApp("Mail");' }) } }) + "\n");
    }
    if (mode === "non-permission block") delete task.blockedReason;
    if (mode === "missing session") task.native.sessionId = null;
    store.saveTask(task);
    s.env.FAKE_SCENARIO = "cu-success";
    const out = await delegate({ cwd: s.root, resumeTaskId: task.taskId, env: s.env, authPaths: s.authPaths });
    if (mode === "bom") assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    else if (mode === "historical violation" || mode === "missing rollout") {
      assert.equal(s.execCalls().length, 1);
      assert.equal(out.summary.state, "failed");
      assert.ok(store.findTask(task.taskId)?.evidence?.computerUse?.violations.includes(mode === "missing rollout" ? "rollout_missing" : "denied_app:mail"));
    } else {
      assert.equal(out.summary.state, "rejected");
      assert.equal(s.execCalls().length, 1);
    }
  });

  it("routes a default adaptive request to a Codex model", async t => {
    const s = setup(t);
    const req = baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] });
    delete req.adaptive;
    Object.assign(s.env, { FAKE_SCENARIO: "cu-success", FAKE_ADAPTIVE_CATALOG: "1" });
    const out = await delegate({ cwd: s.root, requestPath: s.request(req), env: s.env, authPaths: s.authPaths });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const task = new Store(s.root).findTask(String(out.summary.taskId))!;
    assert.equal(task.executor, "codex");
    assert.ok(task.selection?.adaptive && task.model.requested);
  });

  for (const via of ["resume", "refresh", "admitted"]) it(`fails orphaned computer use during ${via}`, async t => {
    const s = setup(t);
    Object.assign(s.env, { FAKE_SCENARIO: "cu-permission" });
    const first = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
    const store = new Store(s.root);
    const task = store.findTask(String(first.summary.taskId))!;
    task.state = via === "admitted" ? "approved" : "running";
    task.pids = { bridge: via === "admitted" ? 2147483647 : null, child: null };
    store.saveTask(task);
    if (via === "refresh") refreshInterrupted(store);
    await delegate({ cwd: s.root, resumeTaskId: task.taskId, env: s.env, authPaths: s.authPaths });
    assert.equal(store.findTask(task.taskId)?.state, "failed");
    assert.equal(store.chainForTask(task).status, "failed");
    assert.equal(s.execCalls().length, 1);
  });

  it("does not approve an empty resume using only the prior permission attempt", async t => {
    const s = setup(t);
    s.env.FAKE_SCENARIO = "cu-permission";
    const first = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
    assert.equal(first.summary.state, "blocked");
    s.env.FAKE_SCENARIO = "cu-no-audit";
    const result = await delegate({ cwd: s.root, resumeTaskId: String(first.summary.taskId), env: s.env, authPaths: s.authPaths });
    assert.equal(result.summary.state, "failed");
    const task = new Store(s.root).findTask(String(first.summary.taskId)); assert.ok(task);
    assert.ok(task.evidence?.computerUse?.actions.length);
    assert.ok(task.evidence?.computerUse?.violations.includes("missing_auditable_actions"));
  });

  for (const scenario of ["cu-no-thread", "cu-session-mismatch"]) it(`rejects ${scenario} on resume`, async t => {
    const s = setup(t);
    s.env.FAKE_SCENARIO = "cu-permission";
    const first = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { needs: ["computer_use"], apps: ["Finder"] })), env: s.env, authPaths: s.authPaths });
    assert.equal(first.summary.state, "blocked");
    s.env.FAKE_SCENARIO = scenario;
    const result = await delegate({ cwd: s.root, resumeTaskId: String(first.summary.taskId), env: s.env, authPaths: s.authPaths });
    assert.equal(result.summary.state, "failed", JSON.stringify(result.summary));
    const task = new Store(s.root).findTask(String(first.summary.taskId)); assert.ok(task);
    assert.equal(task.native.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    assert.ok(task.evidence?.computerUse?.violations.includes("native_session_mismatch"));
  });
});
