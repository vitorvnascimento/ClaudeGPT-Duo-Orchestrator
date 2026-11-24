// Conferência pós-tarefa do Gemini no Windows: retrato do checkout e das configs reais (só detecta, não contém).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { hashPathStrict } from "../src/git.js";
import { compareDrift, takeDriftSnapshot } from "../src/orchestration/drift.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) { try { chmodSync(d, 0o755); } catch { /* já removido */ } rmSync(d, { recursive: true, force: true }); } dirs = []; });
function tmp(prefix: string): string { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; }
function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function repo(): string {
  const d = tmp("duo-drift-");
  g(d, "init", "-q");
  writeFileSync(join(d, "a.txt"), "a\n");
  writeFileSync(join(d, "b.txt"), "b\n");
  g(d, "add", ".");
  g(d, "commit", "-q", "-m", "base");
  return d;
}
const snap = (checkouts: string[], configRoots: string[] = []) => takeDriftSnapshot({ checkouts, configRoots });

describe("hashPathStrict", () => {
  it("separates missing from unreadable", { skip: process.platform === "win32" }, () => {
    const d = tmp("duo-hps-");
    writeFileSync(join(d, "f"), "x");
    assert.ok("hash" in hashPathStrict(join(d, "f")));
    assert.deepEqual(hashPathStrict(join(d, "nope")), { missing: true });
    assert.deepEqual(hashPathStrict(join(d, "f", "under-file")), { missing: true });
    chmodSync(join(d, "f"), 0o000);
    assert.ok("error" in hashPathStrict(join(d, "f")));
  });
});

describe("drift snapshot", () => {
  it("a second write to an already-modified file is a change", () => {
    const r = repo();
    writeFileSync(join(r, "a.txt"), "dirty 1\n");
    const before = snap([r]);
    writeFileSync(join(r, "a.txt"), "dirty 2\n");
    const out = compareDrift(before, snap([r]), []);
    assert.deepEqual(out.changed, [join(r, "a.txt")]);
    assert.equal(out.incomplete, false);
  });

  it("nothing changed: empty and complete", () => {
    const r = repo();
    writeFileSync(join(r, "a.txt"), "dirty\n");
    const out = compareDrift(snap([r]), snap([r]), []);
    assert.deepEqual(out, { changed: [], appliedNotes: [], hiddenUnchecked: [], incomplete: false });
  });

  it("a sibling worktree moving between clean commits is a change through its HEAD", () => {
    const r = repo();
    const wt = join(tmp("duo-drift-wt-"), "sib");
    g(r, "worktree", "add", "-q", "--detach", wt);
    const before = snap([r, wt]);
    writeFileSync(join(wt, "b.txt"), "b2\n");
    g(wt, "commit", "-q", "-am", "next");
    const out = compareDrift(before, snap([r, wt]), []);
    assert.deepEqual(out.changed, [`${realpathSync(wt)} (HEAD)`]);
  });

  it("a staged-only change that keeps MM is a change through the index", () => {
    const r = repo();
    writeFileSync(join(r, "a.txt"), "staged 1\n");
    g(r, "add", "a.txt");
    writeFileSync(join(r, "a.txt"), "worktree\n");
    const before = snap([r]);
    writeFileSync(join(r, "a.txt"), "staged 2\n");
    g(r, "add", "a.txt");
    writeFileSync(join(r, "a.txt"), "worktree\n");
    assert.match(g(r, "status", "--porcelain"), /^MM a\.txt/m);
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, [join(r, "a.txt")]);
  });

  it("an untracked file created during the attempt is a change", () => {
    const r = repo();
    const before = snap([r]);
    mkdirSync(join(r, "novo"));
    writeFileSync(join(r, "novo", "x.txt"), "x");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, [join(r, "novo", "x.txt")]);
  });

  it("a .gemini root that appears between snapshots is a change; one that stays absent is not", () => {
    const r = repo();
    const home = tmp("duo-drift-home-");
    const root = join(home, ".gemini");
    const before = snap([r], [root]);
    assert.equal(before.roots[root], "absent");
    assert.deepEqual(compareDrift(before, snap([r], [root]), []), { changed: [], appliedNotes: [], hiddenUnchecked: [], incomplete: false });
    mkdirSync(root);
    writeFileSync(join(root, "settings.json"), "{}");
    const out = compareDrift(before, snap([r], [root]), []);
    assert.deepEqual(out.changed, [root]);
    assert.equal(out.incomplete, false);
  });

  it("a file inside an existing config root changing size is a change", () => {
    const r = repo();
    const root = join(tmp("duo-drift-home-"), ".gemini");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "config.json"), "{}");
    const before = snap([r], [root]);
    writeFileSync(join(root, "config", "config.json"), '{"plugins":{}}');
    assert.deepEqual(compareDrift(before, snap([r], [root]), []).changed, [join(root, "config", "config.json")]);
  });

  it("an unreadable dirty file makes the check incomplete, never clean", { skip: process.platform === "win32" }, () => {
    const r = repo();
    writeFileSync(join(r, "a.txt"), "dirty\n");
    const before = snap([r]);
    chmodSync(join(r, "a.txt"), 0o000);
    const after = snap([r]);
    assert.ok(after.errors.length > 0);
    assert.equal(compareDrift(before, after, []).incomplete, true);
  });

  it("a failing git (checkout that is not a repository) makes the check incomplete", () => {
    const notRepo = tmp("duo-drift-norepo-");
    const s = snap([notRepo]);
    assert.ok(s.errors.length > 0);
    assert.equal(compareDrift(s, s, []).incomplete, true);
  });

  it("skip-worktree files are listed as not checked", () => {
    const r = repo();
    g(r, "update-index", "--skip-worktree", "b.txt");
    const out = compareDrift(snap([r]), snap([r]), []);
    assert.deepEqual(out.hiddenUnchecked, [join(r, "b.txt")]);
  });

  it("a path touched by an apply stays changed and gets a note naming the apply", () => {
    const r = repo();
    const before = snap([r]);
    writeFileSync(join(r, "a.txt"), "applied\n");
    const out = compareDrift(before, snap([r]), [{ taskId: "t-sib", files: [join(r, "a.txt")] }]);
    assert.deepEqual(out.changed, [join(r, "a.txt")]);
    assert.deepEqual(out.appliedNotes, [{ path: join(r, "a.txt"), taskId: "t-sib" }]);
  });
});
