// Perfil sandbox-exec do executor Gemini. Testes com sandbox real só rodam no macOS.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildProfile, globToSbplRegex, probeSandbox, SANDBOX_EXEC } from "../src/adapters/sandbox-profile.js";

const DARWIN = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
function tmp(prefix: string): string { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; }
const DENY = [".git/**", "**/*.key", "**/secrets/**"];

function sh(profile: string, script: string, cwd: string) {
  const p = join(cwd, "..", `p-${process.pid}-${Math.random().toString(36).slice(2)}.sb`);
  writeFileSync(p, profile);
  try { return spawnSync(SANDBOX_EXEC, ["-f", p, "/bin/sh", "-c", script], { cwd, encoding: "utf8" }); }
  finally { rmSync(p, { force: true }); }
}

describe("buildProfile", () => {
  it("profile allows only listed paths", () => {
    const r = buildProfile({ worktreeRoot: "/W", targets: [{ rel: "a.txt", abs: "/W/a.txt", isDir: false, missingAncestors: [] }, { rel: "docs", abs: "/W/docs", isDir: true, missingAncestors: [] }], denyGlobs: DENY, privateHome: "/H", tmpDir: "/H/tmp" });
    assert.ok(r.ok);
    const p = r.ok ? r.profile : "";
    assert.match(p, /\(deny file-write\*\)/);
    assert.match(p, /\(literal "\/W\/a\.txt"\)/);
    assert.match(p, /\(subpath "\/W\/docs"\)/);
    assert.match(p, /\(subpath "\/H"\)/);
    assert.match(p, /\[aA\]\[gG\]\[eE\]\[nN\]\[tT\]\[sS\]/);
    assert.doesNotMatch(p, /\(subpath "\/W"\)/);
    assert.match(p, /\(deny file-link\)/);
    assert.match(p, /\(deny appleevent-send\)/);
  });

  it("protected dirs and deny globs are denied even with file-only targets", () => {
    const r = buildProfile({ worktreeRoot: "/W", targets: [{ rel: "a.txt", abs: "/W/a.txt", isDir: false, missingAncestors: [] }], denyGlobs: DENY, privateHome: "/H", tmpDir: "/H/tmp" });
    const p = r.ok ? r.profile : "";
    const denyLine = p.split("\n").find((l) => l.startsWith("(deny file-write* (")) ?? "";
    for (const d of ["[aA][gG][eE][nN][tT][sS]", "[gG][iI][tT]", "[dD][uU][oO]"]) assert.ok(denyLine.includes(d), d);
    assert.ok(denyLine.includes("[kK][eE][yY]"));
  });
  it("refuses control characters in any path", () => {
    const r = buildProfile({ worktreeRoot: "/W", targets: [{ rel: "a\nb", abs: "/W/a\nb", isDir: false, missingAncestors: [] }], denyGlobs: [], privateHome: "/H", tmpDir: "/H/t" });
    assert.equal(r.ok, false);
  });

  it("glob conversion is anchored and case-insensitive", () => {
    const re = new RegExp(globToSbplRegex("/W", "**/*.key"));
    assert.ok(re.test("/W/a/b/x.KEY"));
    assert.ok(re.test("/W/x.key"));
    assert.ok(!re.test("/W/x.keys"));
    assert.ok(!re.test("/X/x.key"));
  });
});

describe("sandbox real", { skip: !DARWIN }, () => {
  it("escapes hostile paths and still confines the sibling", () => {
    const base = tmp("duo-sbx-");
    const wt = join(base, 'we"ird (x) \\ y');
    mkdirSync(wt);
    const r = buildProfile({ worktreeRoot: wt, targets: [{ rel: "ok.txt", abs: join(wt, "ok.txt"), isDir: false, missingAncestors: [] }], denyGlobs: DENY, privateHome: join(base, "h"), tmpDir: join(base, "h", "t") });
    assert.ok(r.ok);
    const out = sh(r.ok ? r.profile : "", "echo 1 > ok.txt && echo ok; echo 2 > other.txt || echo sibling-denied", wt);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ok/);
    assert.match(out.stdout, /sibling-denied/);
    assert.ok(existsSync(join(wt, "ok.txt")));
    assert.ok(!existsSync(join(wt, "other.txt")));
  });

  it("denies a previously nonexistent file matching **/*.key under a granted dir (OS layer alone)", () => {
    const wt = tmp("duo-sbx-");
    mkdirSync(join(wt, "docs"));
    const r = buildProfile({ worktreeRoot: wt, targets: [{ rel: "docs", abs: join(wt, "docs"), isDir: true, missingAncestors: [] }], denyGlobs: DENY, privateHome: join(wt, "..", "h"), tmpDir: join(wt, "..", "h", "t") });
    assert.ok(r.ok);
    const out = sh(r.ok ? r.profile : "", "mkdir -p docs/new && echo a > docs/new/a.md && echo md-ok; echo k > docs/new/A.KEY || echo key-denied", wt);
    assert.match(out.stdout, /md-ok/);
    assert.match(out.stdout, /key-denied/);
    assert.ok(!existsSync(join(wt, "docs", "new", "A.KEY")));
  });

  it("denies hard links from an allowed path to a file outside", () => {
    const base = tmp("duo-sbx-");
    const wt = join(base, "wt");
    mkdirSync(wt);
    writeFileSync(join(base, "victim.txt"), "secret");
    const r = buildProfile({ worktreeRoot: wt, targets: [{ rel: "d", abs: join(wt, "d"), isDir: true, missingAncestors: [] }], denyGlobs: [], privateHome: join(base, "h"), tmpDir: join(base, "h", "t") });
    assert.ok(r.ok);
    mkdirSync(join(wt, "d"));
    const out = sh(r.ok ? r.profile : "", `ln ${JSON.stringify(join(base, "victim.txt"))} d/hl.txt && echo 1 > d/hl.txt; echo done`, wt);
    assert.match(out.stdout, /done/);
    assert.equal(existsSync(join(wt, "d", "hl.txt")), false);
    assert.equal(readFileSync(join(base, "victim.txt"), "utf8"), "secret");
  });

  it("a literal target inside .agents is still denied by the OS layer", () => {
    const wt = tmp("duo-sbx-wt-");
    mkdirSync(join(wt, ".agents"));
    const r = buildProfile({ worktreeRoot: wt, targets: [{ rel: ".agents/hooks.json", abs: join(wt, ".agents", "hooks.json"), isDir: false, missingAncestors: [] }], denyGlobs: [], privateHome: join(wt, "..", "h"), tmpDir: join(wt, "..", "h", "tmp") });
    assert.ok(r.ok);
    sh(r.ok ? r.profile : "", "echo x > .agents/hooks.json", wt);
    assert.equal(existsSync(join(wt, ".agents", "hooks.json")), false);
  });
  it("the gate dir is read-only for the executor except its own log", () => {
    const wt = tmp("duo-sbx-wt-");
    const home = tmp("duo-sbx-home-");
    mkdirSync(join(home, "duo-gate")); writeFileSync(join(home, "duo-gate", "allowlist.json"), "{}");
    const log = join(home, "duo-gate", "gate-log-1.jsonl"); writeFileSync(log, "");
    const r = buildProfile({ worktreeRoot: wt, targets: [], denyGlobs: [], privateHome: home, tmpDir: join(home, "tmp"), gateLog: log });
    assert.ok(r.ok);
    sh(r.ok ? r.profile : "", `echo x >> '${log}'; echo y > '${join(home, "duo-gate", "allowlist.json")}'; echo z > '${join(home, "duo-gate", "profile.sb")}'; echo w > '${join(home, "ok.txt")}'`, wt);
    assert.equal(readFileSync(log, "utf8"), "x\n");
    assert.equal(readFileSync(join(home, "duo-gate", "allowlist.json"), "utf8"), "{}");
    assert.equal(existsSync(join(home, "duo-gate", "profile.sb")), false);
    assert.equal(existsSync(join(home, "ok.txt")), true);
  });
  it("a non-ASCII deny glob is enforced by the OS in both Unicode forms and any case", () => {
    const wt = tmp("duo-sbx-wt-");
    mkdirSync(join(wt, "docs"));
    const r = buildProfile({ worktreeRoot: wt, targets: [{ rel: "docs", abs: join(wt, "docs"), isDir: true, missingAncestors: [] }], denyGlobs: ["**/Caf\u00e9/**"], privateHome: join(wt, "..", "h2"), tmpDir: join(wt, "..", "h2", "tmp") });
    assert.ok(r.ok);
    for (const name of ["Caf\u00e9", "Cafe\u0301", "CAF\u00c9"]) {
      sh(r.ok ? r.profile : "", `mkdir -p 'docs/${name}' && echo x > 'docs/${name}/s.txt'`, wt);
      assert.equal(existsSync(join(wt, "docs", name, "s.txt")), false, name);
    }
    sh(r.ok ? r.profile : "", "echo ok > docs/livre.txt", wt);
    assert.ok(existsSync(join(wt, "docs", "livre.txt")));
  });
  it("deny regexes match mixed Unicode forms per component and titlecase letters", () => {
    const toRe = (g: string) => new RegExp(globToSbplRegex("/W", g).replace(/\\\//g, "/"));
    const mixed = "docs/Caf\u00e9/Cafe\u0301/s.txt";
    for (const p of [mixed, mixed.normalize("NFC"), mixed.normalize("NFD"), "docs/CAF\u00c9/cafe\u0301/s.txt"]) {
      assert.ok(toRe("docs/Caf\u00e9/Caf\u00e9/*").test(`/W/${p}`), p);
    }
    assert.ok(toRe("\u01c5x").test("/W/\u01c5x"), "titlecase casa a si mesma");
    assert.ok(toRe("\u01c5x").test("/W/\u01c4X") && toRe("\u01c5x").test("/W/\u01c6x"));
  });
  it("canonicalizes /tmp to /private/tmp", () => {
    const r = buildProfile({ worktreeRoot: "/tmp", targets: [], denyGlobs: [], privateHome: "/tmp", tmpDir: "/tmp" });
    assert.ok(r.ok && r.profile.includes('(subpath "/private/tmp")'));
  });

  it("probe passes on darwin", () => {
    assert.deepEqual(probeSandbox(), { ok: true });
  });
});

describe("sonda", () => {
  it("probe reports missing sandbox-exec", () => {
    const r = probeSandbox({ sandboxExec: "/nonexistent/sandbox-exec" });
    assert.equal(r.ok, false);
  });
});
