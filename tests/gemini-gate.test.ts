// Gate do executor Gemini (hook PreToolUse do agy). Offline: decisões, alvos e arquivos do hook.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalPath, decideToolCall, gateHookScriptPath, resolveGeminiTargets, writeGateFiles, type GateAllowlist } from "../src/adapters/gemini-gate.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
function tmp(prefix: string): string { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; }

const DENY = [".git/**", ".duo/**", "**/*.key", "**/.env"];
function call(name: string, args: Record<string, unknown>, modelName = "gemini-3.8-flash-low") {
  return { toolCall: { id: "t1", name, args }, modelName, hookEventName: "PreToolUse" };
}

describe("decideToolCall", () => {
  const wt = "/WT";
  const allow: GateAllowlist = { worktreeRoot: wt, write: [{ rel: "src/ok.ts", isDir: false }, { rel: "docs", isDir: true }], deny: DENY, readOnly: false };
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
  it("inside a granted dir only ASCII names are writable; a listed accented file is", () => {
    const a: GateAllowlist = { worktreeRoot: "/WT", write: [{ rel: "docs", isDir: true }, { rel: "docs/ol\u00e1.txt", isDir: false }], deny: DENY, readOnly: false };
    const id = (p: string) => p;
    assert.equal(decideToolCall(call("write_file", { Path: "/WT/docs/caf\u00e9.txt" }), a, id).decision, "deny");
    assert.equal(decideToolCall(call("write_file", { Path: "/WT/docs/ol\u00e1.txt" }), a, id).decision, "allow");
    assert.equal(decideToolCall(call("write_file", { Path: "/WT/docs/ok.txt" }), a, id).decision, "allow");
    const accentedDir: GateAllowlist = { ...a, write: [{ rel: "tradu\u00e7\u00f5es", isDir: true }] };
    assert.equal(decideToolCall(call("write_file", { Path: "/WT/tradu\u00e7\u00f5es/index.md" }), accentedDir, id).decision, "allow");
    assert.equal(decideToolCall(call("write_file", { Path: "/WT/tradu\u00e7\u00f5es/caf\u00e9.md" }), accentedDir, id).decision, "deny");
  });
  it("denies writes without a path and every write in read-only mode", () => {
    assert.equal(decideToolCall(call("write_file", { Content: "x" }), allow, canon).decision, "deny");
    assert.equal(decideToolCall(call("write_file", { Path: "/WT/src/ok.ts" }), { ...allow, readOnly: true }, canon).decision, "deny");
  });
  it("allows reads inside the worktree and denies reads outside", () => {
    assert.equal(decideToolCall(call("read_file", { Path: "/WT/src/app.ts" }), allow, canon).decision, "allow");
    assert.equal(decideToolCall(call("list_dir", { DirectoryPath: "/WT" }), allow, canon).decision, "allow");
    assert.equal(decideToolCall(call("grep_search", { Query: "x", SearchPath: "/WT/src" }), allow, canon).decision, "deny", "grep só em arquivo");
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

describe("links no caminho pedido", () => {
  it("link/.. is resolved through the link, never lexically", () => {
    const wt = tmp("duo-gate-wt-");
    const out = tmp("duo-gate-out-");
    mkdirSync(join(out, "a")); writeFileSync(join(out, "secret"), "s");
    mkdirSync(join(wt, "docs")); symlinkSync(join(out, "a"), join(wt, "docs", "l"));
    const a: GateAllowlist = { worktreeRoot: wt, write: [{ rel: "docs", isDir: true }], deny: DENY, readOnly: false };
    // Concatenação literal: path.join colapsaria "l/.." antes do gate.
    const raw = `${wt}/docs/l/../secret`;
    assert.equal(decideToolCall(call("read_file", { Path: raw }), a).decision, "deny");
    assert.equal(canonicalPath(raw), join(out, "secret"));
    assert.equal(decideToolCall(call("read_file", { Path: "docs/l/../secret" }), a).decision, "deny", "relativo");
  });
  it("a dangling committed link resolves to its target (outside → denied)", () => {
    const wt = tmp("duo-gate-wt-");
    mkdirSync(join(wt, "docs"));
    symlinkSync("../../fora.txt", join(wt, "docs", "d"));
    symlinkSync("../.env", join(wt, "docs", "e"));
    const a: GateAllowlist = { worktreeRoot: wt, write: [{ rel: "docs", isDir: true }], deny: DENY, readOnly: false };
    assert.equal(decideToolCall(call("write_file", { Path: join(wt, "docs", "d"), Content: "x" }), a).decision, "deny");
    assert.equal(decideToolCall(call("read_file", { Path: join(wt, "docs", "e") }), a).decision, "deny");
  });
  it("a '..' after a missing component is refused (no lexical shortcut past an unchecked link)", () => {
    const wt = tmp("duo-gate-wt-");
    const out = tmp("duo-gate-out-");
    mkdirSync(join(wt, "docs")); symlinkSync(out, join(wt, "docs", "l"));
    const raw = `${wt}/missing/../docs/l/x`;
    assert.throws(() => canonicalPath(raw));
    const a: GateAllowlist = { worktreeRoot: wt, write: [{ rel: "docs", isDir: true }], deny: DENY, readOnly: false };
    assert.equal(decideToolCall(call("read_file", { Path: raw }), a).decision, "deny");
    assert.equal(decideToolCall(call("write_file", { Path: raw, Content: "x" }), a).decision, "deny");
    assert.equal(canonicalPath(`${wt}/missing/new.ts`), join(wt, "missing", "new.ts"), "sem '..' o resto inexistente é literal");
  });
  it("a target spelled differently from the disk is refused with the real spelling; links are refused", () => {
    const wt = tmp("duo-gate-wt-");
    writeFileSync(join(wt, "README.md"), "r");
    symlinkSync("README.md", join(wt, "alias.md"));
    assert.equal(resolveGeminiTargets(wt, [{ rel: "alias.md", isDir: false }], []).ok, false);
    assert.ok(resolveGeminiTargets(wt, [{ rel: "README.md", isDir: false }], []).ok);
    if (existsSync(join(wt, "readme.md"))) {
      const r = resolveGeminiTargets(wt, [{ rel: "readme.md", isDir: false }], []);
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.reason, /README\.md/);
      const upperRoot = wt.toUpperCase();
      if (existsSync(upperRoot)) assert.ok(resolveGeminiTargets(upperRoot, [{ rel: "README.md", isDir: false }], []).ok);
    }
  });
  it("a missing worktree root is refused before any target is prepared", () => {
    const base = tmp("duo-gate-wt-");
    assert.equal(resolveGeminiTargets(join(base, "sumiu"), [{ rel: "src/a.ts", isDir: false }], []).ok, false);
  });
  it("the gate root is pinned at setup: replacing the worktree by a link does not move the read boundary", () => {
    const base = tmp("duo-gate-pin-");
    const wt = join(base, "wt"); mkdirSync(wt);
    const other = join(base, "other"); mkdirSync(other); writeFileSync(join(other, "s.txt"), "s");
    const home = tmp("duo-gate-home-");
    const files = writeGateFiles(wt, home, { worktreeRoot: wt, write: [], deny: DENY, readOnly: true }, { nodePath: process.execPath });
    const saved = JSON.parse(readFileSync(files.allowlistPath, "utf8")) as GateAllowlist;
    fs.renameSync(wt, join(base, "wt-old")); symlinkSync(other, wt);
    assert.equal(decideToolCall(call("read_file", { Path: join(wt, "s.txt") }), saved).decision, "deny");
  });
  it("a filesystem error while resolving a target becomes a refusal, not an exception", () => {
    const wt = tmp("duo-gate-wt-");
    writeFileSync(join(wt, "README.md"), "r");
    const r = resolveGeminiTargets(wt, [{ rel: "README.md/child", isDir: false }], []);
    assert.equal(r.ok, false);
  });
  it("a '..' after a link to a missing target is refused too", () => {
    const wt = tmp("duo-gate-wt-");
    mkdirSync(join(wt, "docs")); mkdirSync(join(wt, "src"));
    symlinkSync("../gone", join(wt, "docs", "l"));
    const raw = `${wt}/docs/l/../src/x.ts`;
    assert.throws(() => canonicalPath(raw));
    const a: GateAllowlist = { worktreeRoot: wt, write: [{ rel: "src", isDir: true }], deny: DENY, readOnly: false };
    assert.equal(decideToolCall(call("write_file", { Path: raw, Content: "x" }), a).decision, "deny");
  });
  it("a target whose missing ancestor is a dangling link is refused", () => {
    const wt = tmp("duo-gate-wt-");
    symlinkSync("/nao/existe/dir", join(wt, "gen"));
    assert.equal(resolveGeminiTargets(wt, [{ rel: "gen/x.ts", isDir: false }], []).ok, false);
  });
});

describe("busca de conteúdo e grafias equivalentes", () => {
  function repo(): string {
    const wt = tmp("duo-gate-wt-");
    mkdirSync(join(wt, "Docs", "inner"), { recursive: true }); mkdirSync(join(wt, "src"));
    writeFileSync(join(wt, "Docs", "inner", "a.key"), "k"); writeFileSync(join(wt, "src", "x.ts"), "1");
    return wt;
  }
  const allowOf = (wt: string, deny = DENY): GateAllowlist => ({ worktreeRoot: wt, write: [], deny, readOnly: true });
  const grep = (p: string) => call("grep_search", { Query: "x", SearchPath: p });
  it("grep_search runs only on a file: any directory (root, clean or not) is denied", () => {
    const wt = repo();
    for (const p of [wt, join(wt, "src"), join(wt, "Docs"), join(wt, "nao-existe")]) assert.equal(decideToolCall(grep(p), allowOf(wt)).decision, "deny", p);
    assert.equal(decideToolCall(grep(join(wt, "src", "x.ts")), allowOf(wt)).decision, "allow");
    assert.equal(decideToolCall(grep(join(wt, "Docs", "inner", "a.key")), allowOf(wt)).decision, "deny");
  });
  it("a denied file is denied under another case or Unicode form, and when the rule itself uses the other form", () => {
    const wt = repo();
    mkdirSync(join(wt, "Caf\u00e9")); writeFileSync(join(wt, "Caf\u00e9", "secret.txt"), "s");
    const nfcRule = ["Caf\u00e9/secret.txt"], nfdRule = ["Cafe\u0301/secret.txt"];
    for (const rule of [nfcRule, nfdRule]) {
      for (const spelling of ["Caf\u00e9", "Cafe\u0301", "CAF\u00c9"]) {
        const p = join(wt, spelling, "secret.txt");
        assert.equal(decideToolCall(call("read_file", { Path: p }), allowOf(wt, rule), (x) => x).decision, "deny", `${rule[0]} vs ${spelling}`);
      }
    }
    assert.equal(decideToolCall(call("read_file", { Path: join(wt, "DOCS", "INNER", "A.KEY") }), allowOf(wt), (x) => x).decision, "deny");
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
    const a: GateAllowlist = { worktreeRoot: wt, write: [], deny: DENY, readOnly: true };
    const first = writeGateFiles(wt, home, a, { nodePath: process.execPath });
    writeFileSync(first.logPath, '{"tool":"x","decision":"allow","modelName":"gemini-old"}\n');
    const second = writeGateFiles(wt, home, a, { nodePath: process.execPath });
    assert.notEqual(second.logPath, first.logPath);
    assert.equal(existsSync(second.logPath) ? readFileSync(second.logPath, "utf8") : "", "");
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
