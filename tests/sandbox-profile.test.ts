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
    assert.match(p, /\(subpath "\/W\/docs\/\.agents"\)|\(subpath "\/W\/\.agents"\)/);
    assert.doesNotMatch(p, /\(subpath "\/W"\)/);
    assert.match(p, /\(deny file-link\)/);
    assert.match(p, /\(deny appleevent-send\)/);
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
