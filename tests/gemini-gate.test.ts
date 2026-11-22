// Gate do executor Gemini (hook PreToolUse do agy). Offline: decisões, alvos e arquivos do hook.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { decideToolCall, gateHookScriptPath, listDeniedFiles, resolveGeminiTargets, writeGateFiles, type GateAllowlist } from "../src/adapters/gemini-gate.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
function tmp(prefix: string): string { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; }

const DENY = [".git/**", ".duo/**", "**/*.key", "**/.env"];
function call(name: string, args: Record<string, unknown>, modelName = "gemini-3.8-flash-low") {
  return { toolCall: { id: "t1", name, args }, modelName, hookEventName: "PreToolUse" };
}

describe("decideToolCall", () => {
  const wt = "/WT";
  const allow: GateAllowlist = { worktreeRoot: wt, write: [{ rel: "src/ok.ts", isDir: false }, { rel: "docs", isDir: true }], deny: DENY, readOnly: false, deniedFiles: [] };
  const canon = (p: string) => p; // caminhos já canônicos no teste puro
  it("allows only exact targets for writes", () => {
    assert.equal(decideToolCall(call("write_file", { Path: "/WT/src/ok.ts", Content: "1" }), allow, canon).decision, "allow");
    assert.equal(decideToolCall(call("edit_file", { TargetFile: "/WT/docs/new/a.md" }), allow, canon).decision, "allow");
  });
  it("denies a sibling, .agents, denied globs and paths outside the worktree", () => {
    for (const p of ["/WT/src/other.ts", "/WT/.agents/hooks.json", "/WT/docs/x.key", "/WT/docs/.env", "/WT/../out.txt", "/elsewhere/a", "/WT/srcx"]) {
      assert.equal(decideToolCall(call("write_file", { Path: p, Content: "x" }), allow, canon).decision, "deny", p);
    }
  });
  it("protected dirs are denied in any letter case", () => {
    const wide: GateAllowlist = { ...allow, write: [{ rel: ".", isDir: true }] };
    for (const p of ["/WT/.AGENTS/hooks.json", "/WT/.Git/config", "/WT/.DUO/x"]) assert.equal(decideToolCall(call("write_file", { Path: p }), wide, canon).decision, "deny", p);
  });
  it("recursive search is denied when it reaches a denied file of the worktree", () => {
    const withDenied: GateAllowlist = { ...allow, deniedFiles: ["docs/a.key", "config/.env"] };
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/docs" }), withDenied, canon).decision, "deny");
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT" }), withDenied, canon).decision, "deny");
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/src" }), withDenied, canon).decision, "allow");
    const { deniedFiles: _omit, ...noList } = allow;
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/src" }), noList, canon).decision, "deny", "sem a lista de negados, a busca recursiva falha fechada");
  });
  it("recursive search compares names case-insensitively (APFS) and treats nested repos as opaque", () => {
    const a: GateAllowlist = { ...allow, deniedFiles: ["Docs/a.key", "vendor/sub/"] };
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/docs" }), a, canon).decision, "deny");
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/DOCS/inner" }), { ...allow, deniedFiles: ["docs/inner/b.key"] }, canon).decision, "deny");
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/vendor" }), a, canon).decision, "deny");
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/vendor/sub/lib" }), a, canon).decision, "deny");
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/src" }), a, canon).decision, "allow");
  });
  it("denies writes without a path and every write in read-only mode", () => {
    assert.equal(decideToolCall(call("write_file", { Content: "x" }), allow, canon).decision, "deny");
    assert.equal(decideToolCall(call("write_file", { Path: "/WT/src/ok.ts" }), { ...allow, readOnly: true }, canon).decision, "deny");
  });
  it("allows reads inside the worktree and denies reads outside", () => {
    assert.equal(decideToolCall(call("read_file", { Path: "/WT/src/app.ts" }), allow, canon).decision, "allow");
    assert.equal(decideToolCall(call("list_dir", { DirectoryPath: "/WT" }), allow, canon).decision, "allow");
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/src" }), allow, canon).decision, "allow");
    assert.equal(decideToolCall(call("grep_search", { Query: "x" }), allow, canon).decision, "deny");
    assert.equal(decideToolCall(call("read_file", { Path: "/WT/.env" }), allow, canon).decision, "deny");
    assert.equal(decideToolCall(call("read_file", { Path: "/WT/docs/a.key" }), allow, canon).decision, "deny");
    assert.equal(decideToolCall(call("view_file", { AbsolutePath: "/Users/x/.ssh/id_rsa" }), allow, canon).decision, "deny");
  });
  it("denies every non-file tool seen in the fixtures and unknown tools", () => {
    for (const name of ["run_command", "search_web", "invoke_subagent", "send_message", "schedule", "run_workflow", "swarm", "call_mcp_tool", "open_browser_url", "browser_subagent", "list_browser_pages", "browser_navigate", "browser_click", "read_url_content", "define_subagent", "manage_task", "read_resource", "brand_new_tool"]) {
      assert.equal(decideToolCall(call(name, { CommandLine: "ls", Path: "/WT/src/ok.ts" }), allow, canon).decision, "deny", name);
    }
  });
  it("finish (structured result delivery) is allowed, even in read-only mode", () => {
    assert.equal(decideToolCall(call("finish", { Result: "{}" }), { ...allow, readOnly: true }, canon).decision, "allow");
  });
  it("malformed input → deny", () => {
    for (const bad of [null, 1, "x", {}, { toolCall: null }, { toolCall: { name: 3 } }]) {
      assert.equal(decideToolCall(bad, allow, canon).decision, "deny");
    }
  });
});

describe("resolveGeminiTargets", () => {
  it("new file with missing parent lists missingAncestors inside worktree", () => {
    const wt = tmp("duo-gate-wt-");
    mkdirSync(join(wt, "src"));
    const r = resolveGeminiTargets(wt, [{ rel: "src/new/deep/mod.ts", isDir: false }, { rel: "src/app.ts", isDir: false }], ["node_modules"]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.ok && r.targets[0]?.missingAncestors, [join(wt, "src/new"), join(wt, "src/new/deep")]);
    assert.deepEqual(r.ok && r.targets[1]?.missingAncestors, []);
  });
  it("target through a linked dir (node_modules) is refused", () => {
    const wt = tmp("duo-gate-wt-");
    const outside = tmp("duo-gate-out-");
    symlinkSync(outside, join(wt, "node_modules"));
    const r = resolveGeminiTargets(wt, [{ rel: "node_modules/pkg/x.js", isDir: false }], ["node_modules"]);
    assert.equal(r.ok, false);
  });
  it("protected targets (.agents, .git, .duo, any case) are refused before setup", () => {
    const wt = tmp("duo-gate-wt-");
    for (const rel of [".agents/hooks.json", ".AGENTS/hooks.json", ".git/config", ".duo/config.json", ".Duo", "src/.git/x"]) {
      assert.equal(resolveGeminiTargets(wt, [{ rel, isDir: false }], []).ok, false, rel);
    }
  });
  it("target escaping the worktree after realpath is refused", () => {
    const wt = tmp("duo-gate-wt-");
    const outside = tmp("duo-gate-out-");
    symlinkSync(outside, join(wt, "lnk"));
    assert.equal(resolveGeminiTargets(wt, [{ rel: "lnk/a.txt", isDir: false }], []).ok, false);
    assert.equal(resolveGeminiTargets(wt, [{ rel: "../a.txt", isDir: false }], []).ok, false);
  });
});

describe("arquivos do hook", () => {
  it("writeGateFiles replaces the worktree .agents and keeps the allowlist in the private home", () => {
    const wt = tmp("duo-gate-wt-");
    const home = tmp("duo-gate-home-");
    mkdirSync(join(wt, ".agents", "skills"), { recursive: true });
    writeFileSync(join(wt, ".agents", "hooks.json"), '{"evil":{"PreToolUse":[]}}');
    const allow: GateAllowlist = { worktreeRoot: wt, write: [{ rel: "ok.txt", isDir: false }], deny: DENY, readOnly: false };
    const files = writeGateFiles(wt, home, allow, { nodePath: process.execPath });
    assert.equal(existsSync(join(wt, ".agents", "skills")), false);
    const hooks = JSON.parse(readFileSync(join(wt, ".agents", "hooks.json"), "utf8")) as Record<string, { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }>;
    assert.deepEqual(Object.keys(hooks), ["duo-gate"]);
    assert.equal(hooks["duo-gate"]?.PreToolUse[0]?.matcher, "*");
    assert.ok(files.allowlistPath.startsWith(home));
    assert.ok(files.logPath.startsWith(home));
    assert.deepEqual(JSON.parse(readFileSync(files.allowlistPath, "utf8")), allow);
  });

  it("each gate setup gets its own log (no evidence from an earlier attempt)", () => {
    const wt = tmp("duo-gate-wt-");
    const home = tmp("duo-gate-home-");
    const a: GateAllowlist = { worktreeRoot: wt, write: [], deny: DENY, readOnly: true, deniedFiles: [] };
    const first = writeGateFiles(wt, home, a, { nodePath: process.execPath });
    writeFileSync(first.logPath, '{"tool":"x","decision":"allow","modelName":"gemini-old"}\n');
    const second = writeGateFiles(wt, home, a, { nodePath: process.execPath });
    assert.notEqual(second.logPath, first.logPath);
    assert.equal(existsSync(second.logPath) ? readFileSync(second.logPath, "utf8") : "", "");
  });
  it("the denied inventory is taken after the gate files exist (generated hooks.json included)", () => {
    const wt = tmp("duo-gate-wt-");
    const home = tmp("duo-gate-home-");
    spawnSync("git", ["init", "-q"], { cwd: wt });
    const a: GateAllowlist = { worktreeRoot: wt, write: [], deny: ["**/hooks.json"], readOnly: true };
    const files = writeGateFiles(wt, home, a, { nodePath: process.execPath, listDenied: true });
    const saved = JSON.parse(readFileSync(files.allowlistPath, "utf8")) as GateAllowlist;
    assert.ok(saved.deniedFiles?.includes(".agents/hooks.json"), JSON.stringify(saved.deniedFiles));
  });
  it("listDeniedFiles lists a nested repository as an opaque directory", () => {
    const wt = tmp("duo-gate-wt-");
    spawnSync("git", ["init", "-q"], { cwd: wt });
    mkdirSync(join(wt, "vendor", "sub"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: join(wt, "vendor", "sub") });
    writeFileSync(join(wt, "vendor", "sub", "x.txt"), "x");
    assert.ok(listDeniedFiles(wt, DENY)?.includes("vendor/sub/"));
  });
  it("listDeniedFiles finds committed and untracked denied files without following links", () => {
    const wt = tmp("duo-gate-wt-");
    spawnSync("git", ["init", "-q"], { cwd: wt });
    mkdirSync(join(wt, "docs")); writeFileSync(join(wt, "docs", "a.key"), "k"); writeFileSync(join(wt, "ok.ts"), "1");
    spawnSync("git", ["add", "."], { cwd: wt }); spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: wt });
    writeFileSync(join(wt, ".env"), "s");
    assert.deepEqual(listDeniedFiles(wt, DENY)?.sort(), [".env", "docs/a.key"]);
  });
  it("the hook script decides from stdin, logs modelName and fails closed on garbage", () => {
    const wt = tmp("duo-gate-wt-");
    const home = tmp("duo-gate-home-");
    const allow: GateAllowlist = { worktreeRoot: wt, write: [{ rel: "ok.txt", isDir: false }], deny: DENY, readOnly: false };
    const files = writeGateFiles(wt, home, allow, { nodePath: process.execPath });
    const hooks = JSON.parse(readFileSync(join(wt, ".agents", "hooks.json"), "utf8")) as Record<string, { PreToolUse: { hooks: { command: string }[] }[] }>;
    const command = hooks["duo-gate"]?.PreToolUse[0]?.hooks[0]?.command as string;
    const run = (stdin: string) => spawnSync("sh", ["-c", command], { input: stdin, encoding: "utf8", cwd: join(wt, ".agents") });
    const ok = run(JSON.stringify(call("write_file", { Path: join(wt, "ok.txt"), Content: "1" }, "gemini-4-argon-high")));
    assert.equal(JSON.parse(ok.stdout).decision, "allow", ok.stderr);
    const sib = run(JSON.stringify(call("write_file", { Path: join(wt, "other.txt"), Content: "1" })));
    assert.equal(JSON.parse(sib.stdout).decision, "deny");
    const garbage = run("not json");
    assert.equal(JSON.parse(garbage.stdout).decision, "deny");
    const log = readFileSync(files.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tool: string; decision: string; modelName: string | null });
    assert.equal(log[0]?.modelName, "gemini-4-argon-high");
    assert.deepEqual(log.map((l) => l.decision), ["allow", "deny", "deny"]);
    assert.ok(existsSync(gateHookScriptPath()));
  });
});
