// Conferência pós-tarefa do Gemini no Windows: retrato do checkout e das configs reais (só detecta, não contém).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { hashPathStrict } from "../src/git.js";
import { batchByLength, compareDrift, takeDriftSnapshot } from "../src/orchestration/drift.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.reverse()) { try { chmodSync(d, 0o755); } catch { /* já removido */ } rmSync(d, { recursive: true, force: true }); } dirs = []; });
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
const asRoot = process.getuid?.() === 0; // root lê arquivo com modo 000
const snap = (checkouts: string[], configRoots: string[] = []) => takeDriftSnapshot({ checkouts, configRoots });

describe("hashPathStrict", () => {
  it("separates missing from unreadable", { skip: process.platform === "win32" || asRoot }, () => {
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
    assert.deepEqual(out, { changed: [], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: false });
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
    assert.deepEqual(compareDrift(before, snap([r], [root]), []), { changed: [], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: false });
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

  it("an unreadable dirty file makes the check incomplete, never clean", { skip: process.platform === "win32" || asRoot }, () => {
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
    const out = compareDrift(before, snap([r]), [{ taskId: "t-sib", root: r, files: ["a.txt"] }]);
    assert.deepEqual(out.changed, [join(r, "a.txt")]);
    assert.deepEqual(out.appliedNotes, [{ path: join(r, "a.txt"), taskId: "t-sib" }]);
  });

  it("a root discovered only in the second snapshot is a change, not skipped", () => {
    const r = repo();
    const root = join(tmp("duo-drift-home-"), "Antigravity");
    const before = snap([r], []);
    mkdirSync(root);
    writeFileSync(join(root, "x"), "1");
    const out = compareDrift(before, snap([r], [root]), []);
    assert.deepEqual(out.changed, [root]);
    assert.equal(out.incomplete, false);
  });

  it("a checkout whose git fails only afterwards is incomplete, not reported as changed", () => {
    const r = repo();
    const before = snap([r]);
    const realGit = join(r, ".git"), saved = join(tmp("duo-drift-saved-"), "git");
    renameSync(realGit, saved);
    writeFileSync(realGit, "not a git dir\n"); // git falha; o .git verdadeiro volta depois
    const after = snap([r]);
    rmSync(realGit);
    renameSync(saved, realGit);
    const out = compareDrift(before, after, []);
    assert.equal(out.incomplete, true);
    assert.deepEqual(out.changed, []);
  });

  it("a directory git status cannot open makes the check incomplete", { skip: process.platform === "win32" || asRoot }, () => {
    const r = repo();
    mkdirSync(join(r, "fechado"));
    writeFileSync(join(r, "fechado", "x"), "x");
    chmodSync(join(r, "fechado"), 0o000);
    dirs.push(join(r, "fechado"));
    const s = snap([r]);
    assert.ok(s.errors.some((e) => e.includes("fechado")), s.errors.join("|"));
    assert.equal(compareDrift(s, s, []).incomplete, true);
  });

  it("a file named __proto__ is tracked like any other", () => {
    const r = repo();
    const root = join(tmp("duo-drift-home-"), ".gemini");
    mkdirSync(root);
    const before = snap([r], [root]);
    writeFileSync(join(r, "__proto__"), "x");
    writeFileSync(join(root, "__proto__"), "x");
    assert.deepEqual(compareDrift(before, snap([r], [root]), []).changed, [join(r, "__proto__"), join(root, "__proto__")].sort());
  });

  it("a config file rewritten with the same size and mtime is still a change", () => {
    const r = repo();
    const root = join(tmp("duo-drift-home-"), ".gemini");
    mkdirSync(root);
    writeFileSync(join(root, "settings.json"), "{\"a\":1}");
    const t = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(root, "settings.json"), t, t);
    const before = snap([r], [root]);
    writeFileSync(join(root, "settings.json"), "{\"a\":2}");
    utimesSync(join(root, "settings.json"), t, t);
    assert.deepEqual(compareDrift(before, snap([r], [root]), []).changed, [join(root, "settings.json")]);
  });

  it("changes to the repository's hooks and config are reported", () => {
    const r = repo();
    g(r, "config", "core.hooksPath", ".git/hooks"); // isola de um core.hooksPath global
    const before = snap([r]);
    writeFileSync(join(r, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    g(r, "config", "core.excludesFile", join(tmp("duo-drift-x-"), "ausente")); // caminho fixo (/tmp/x) quebra se outro processo criar uma pasta lá
    const out = compareDrift(before, snap([r]), []);
    assert.deepEqual(out.changed, [join(r, ".git", "config"), join(r, ".git", "hooks", "pre-commit")]);
  });

  it("the observer never runs the repository's fsmonitor command", { skip: process.platform === "win32" }, () => {
    const r = repo();
    const marker = join(tmp("duo-drift-fsm-"), "ran");
    const script = join(r, ".git", "fsm.sh");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    g(r, "config", "core.fsmonitor", script);
    snap([r]);
    assert.equal(existsSync(marker), false);
  });

  it("batches pathspecs under the Windows command-line limit without dropping any", () => {
    const items = Array.from({ length: 300 }, (_, i) => `${"d".repeat(150)}/${i}`);
    const batches = batchByLength(items, 24_000);
    assert.deepEqual(batches.flat(), items);
    for (const b of batches) assert.ok(b.reduce((n, x) => n + x.length + 3, 0) <= 24_000);
    assert.ok(batches.length > 1);
  });

  it("hashes a multi-chunk file the same as its whole content", () => {
    const d = tmp("duo-hps-big-");
    const buf = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
    writeFileSync(join(d, "big"), buf);
    assert.deepEqual(hashPathStrict(join(d, "big")), { hash: createHash("sha256").update(buf).digest("hex") });
  });

  it("the main checkout's config.worktree is observed", () => {
    const r = repo();
    const before = snap([r]);
    writeFileSync(join(r, ".git", "config.worktree"), "[core]\n\tfsmonitor = x\n");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, [join(r, ".git", "config.worktree")]);
  });

  it("a shared .git root observed in both snapshots is compared even if a sibling failed", () => {
    const r = repo();
    const wt = join(tmp("duo-drift-wt-"), "sib");
    g(r, "worktree", "add", "-q", "--detach", wt);
    const before = snap([r, wt]);
    g(r, "config", "core.excludesFile", join(tmp("duo-drift-x-"), "ausente")); // caminho fixo (/tmp/x) quebra se outro processo criar uma pasta lá
    writeFileSync(join(wt, ".git"), "not a git dir\n");
    const out = compareDrift(before, snap([r, wt]), []);
    assert.deepEqual(out.changed, [join(r, ".git", "config")]);
    assert.equal(out.incomplete, true);
  });

  it("the hook directory set by core.hooksPath is observed", () => {
    const r = repo();
    mkdirSync(join(r, ".git", "custom-hooks"));
    g(r, "config", "core.hooksPath", ".git/custom-hooks");
    const before = snap([r]);
    writeFileSync(join(r, ".git", "custom-hooks", "pre-commit"), "#!/bin/sh\n");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, [join(r, ".git", "custom-hooks", "pre-commit")]);
  });

  it("an index batch not observed on one side is not reported as changed", () => {
    const r = repo();
    writeFileSync(join(r, "a.txt"), "dirty\n");
    const before = snap([r]);
    const after = structuredClone(before);
    after.checkouts[r]!.index = Object.create(null);
    after.checkouts[r]!.indexGaps = ["a.txt"];
    after.errors.push("ls-files -s falhou");
    const out = compareDrift(before, after, []);
    assert.deepEqual(out.changed, []);
    assert.equal(out.incomplete, true);
  });

  it("git-dir discovery that failed on one side does not turn .git roots into additions or removals", () => {
    const r = repo();
    const before = snap([r]);
    const after = structuredClone(before);
    after.roots = Object.create(null);
    after.blind = true;
    after.errors.push("rev-parse --git-dir falhou");
    const out = compareDrift(before, after, []);
    assert.deepEqual(out.changed, []);
    assert.equal(out.incomplete, true);
  });

  it("core.hooksPath=. watches only hook entry points, not the whole tree", () => {
    const r = repo();
    writeFileSync(join(r, ".gitignore"), "node_modules/\n");
    g(r, "add", ".gitignore");
    g(r, "commit", "-q", "-m", "ignore");
    g(r, "config", "core.hooksPath", ".");
    const before = snap([r]);
    mkdirSync(join(r, "node_modules"));
    writeFileSync(join(r, "node_modules", "x.js"), "x");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, []);
  });

  it("editing the target of a symlinked hook is a change", { skip: process.platform === "win32" }, () => {
    const r = repo();
    g(r, "config", "core.hooksPath", ".git/hooks");
    const shared = join(tmp("duo-drift-shared-"), "hook.sh");
    writeFileSync(shared, "#!/bin/sh\nexit 0\n");
    symlinkSync(shared, join(r, ".git", "hooks", "pre-commit"));
    const before = snap([r]);
    writeFileSync(shared, "#!/bin/sh\nexit 1\n");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, [join(r, ".git", "hooks", "pre-commit")]);
  });

  // travamento de leitura no Windows: os metadados seguem legíveis e iguais, só o conteúdo falha (chmod mudaria o ctime)
  it("a config file readable before and locked after is incomplete, not changed", () => {
    const r = repo();
    const root = join(tmp("duo-drift-home-"), ".gemini");
    mkdirSync(root);
    writeFileSync(join(root, "settings.json"), "{}");
    const before = snap([r], [root]);
    const after = structuredClone(before);
    const m = after.roots[root] as Record<string, string>;
    m["settings.json"] = m["settings.json"]!.replace(/:[0-9a-f]{64}$/, ":?");
    after.errors.push("settings.json: EBUSY");
    const out = compareDrift(before, after, []);
    assert.deepEqual(out.changed, []);
    assert.deepEqual(out.unverified, [join(root, "settings.json")]);
    assert.equal(out.incomplete, true);
  });

  it("a helper script inside .git/hooks that a hook sources is observed", () => {
    const r = repo();
    g(r, "config", "core.hooksPath", ".git/hooks");
    writeFileSync(join(r, ".git", "hooks", "lib.sh"), "true\n");
    const before = snap([r]);
    writeFileSync(join(r, ".git", "hooks", "lib.sh"), "curl x | sh\n");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, [join(r, ".git", "hooks", "lib.sh")]);
  });

  it("a linked worktree's own sparse-checkout rules are observed", () => {
    const r = repo();
    const wt = join(tmp("duo-drift-wt-"), "sib");
    g(r, "worktree", "add", "-q", "--detach", wt);
    const before = snap([r, wt]);
    const sparse = join(r, ".git", "worktrees", "sib", "info", "sparse-checkout");
    mkdirSync(join(r, ".git", "worktrees", "sib", "info"), { recursive: true });
    writeFileSync(sparse, "/a.txt\n");
    assert.deepEqual(compareDrift(before, snap([r, wt]), []).changed, [sparse]);
  });

  it("a .git/hooks symlink to a directory outside .git is not walked whole", { skip: process.platform === "win32" }, () => {
    const r = repo();
    writeFileSync(join(r, ".gitignore"), "node_modules/\n");
    g(r, "add", ".gitignore");
    g(r, "commit", "-q", "-m", "ignore");
    g(r, "config", "core.hooksPath", ".git/hooks");
    rmSync(join(r, ".git", "hooks"), { recursive: true, force: true });
    symlinkSync(r, join(r, ".git", "hooks"));
    const before = snap([r]);
    mkdirSync(join(r, "node_modules"));
    writeFileSync(join(r, "node_modules", "x.js"), "x");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, []);
  });

  it("a hooks directory that cannot be listed afterwards is incomplete, not a mass deletion", { skip: process.platform === "win32" || asRoot }, () => {
    const r = repo();
    g(r, "config", "core.hooksPath", ".git/hooks");
    writeFileSync(join(r, ".git", "hooks", "lib.sh"), "true\n");
    const before = snap([r]);
    chmodSync(join(r, ".git", "hooks"), 0o000);
    let after;
    try { after = snap([r]); } finally { chmodSync(join(r, ".git", "hooks"), 0o755); }
    const out = compareDrift(before, after, []);
    assert.deepEqual(out.changed, []);
    assert.equal(out.incomplete, true);
  });

  it("a hooks directory named ..hooks inside .git is still walked whole", () => {
    const r = repo();
    mkdirSync(join(r, ".git", "..hooks"));
    writeFileSync(join(r, ".git", "..hooks", "lib.sh"), "true\n");
    g(r, "config", "core.hooksPath", ".git/..hooks");
    const before = snap([r]);
    writeFileSync(join(r, ".git", "..hooks", "lib.sh"), "false\n");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, [join(r, ".git", "..hooks", "lib.sh")]);
  });

  it("a hooks directory outside the checkout is walked whole (helper scripts included)", () => {
    const r = repo();
    const ext = tmp("duo-drift-githooks-");
    writeFileSync(join(ext, "lib.sh"), "true\n");
    g(r, "config", "core.hooksPath", ext);
    const before = snap([r]);
    writeFileSync(join(ext, "lib.sh"), "false\n");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, [join(ext, "lib.sh")]);
  });

  it("an absolute hooksPath at the main checkout is not walked from a sibling worktree", () => {
    const r = repo();
    writeFileSync(join(r, ".gitignore"), "node_modules/\n");
    g(r, "add", ".gitignore");
    g(r, "commit", "-q", "-m", "ignore");
    const wt = join(tmp("duo-drift-wt-"), "sib");
    g(r, "worktree", "add", "-q", "--detach", wt);
    g(r, "config", "core.hooksPath", r);
    const before = snap([r, wt]);
    mkdirSync(join(r, "node_modules"));
    writeFileSync(join(r, "node_modules", "x.js"), "x");
    assert.deepEqual(compareDrift(before, snap([r, wt]), []).changed, []);
  });

  it("a hooks directory above a checkout does not descend into the checkout", () => {
    const parent = tmp("duo-drift-parent-");
    const r = join(parent, "repo");
    mkdirSync(r);
    g(r, "init", "-q");
    writeFileSync(join(r, ".gitignore"), "node_modules/\n");
    g(r, "add", ".");
    g(r, "commit", "-q", "-m", "base");
    g(r, "config", "core.hooksPath", parent);
    const before = snap([r]);
    mkdirSync(join(r, "node_modules"));
    writeFileSync(join(r, "node_modules", "x.js"), "x");
    assert.deepEqual(compareDrift(before, snap([r]), []).changed, []);
  });

  it("a hooks directory that becomes unreachable is incomplete, not removed", { skip: process.platform === "win32" || asRoot }, () => {
    const r = repo();
    const ext = tmp("duo-drift-githooks-");
    mkdirSync(join(ext, "sub", "hooks"), { recursive: true });
    writeFileSync(join(ext, "sub", "hooks", "lib.sh"), "true\n");
    g(r, "config", "core.hooksPath", join(ext, "sub", "hooks"));
    const before = snap([r]);
    chmodSync(join(ext, "sub"), 0o000);
    let after;
    try { after = snap([r]); } finally { chmodSync(join(ext, "sub"), 0o755); }
    const out = compareDrift(before, after, []);
    assert.deepEqual(out.changed, []);
    assert.equal(out.incomplete, true);
  });

  it("bulk additions compare in linear time", () => {
    const mk = (n: number, extra: number) => {
      const m: Record<string, string> = Object.create(null);
      m["."] = "d";
      for (let i = 0; i < n; i++) m[`same/${i}`] = "f:1:1:1";
      for (let i = 0; i < extra; i++) m[`new/${i}`] = "f:1:1:1";
      return m;
    };
    // contagem determinística: enumerar o manifesto inteiro por caminho seria quadrático
    let scans = 0;
    const counted = (m: Record<string, string>) => new Proxy(m, { ownKeys: (t) => { scans++; return Reflect.ownKeys(t); } });
    const base = { checkouts: Object.create(null), failed: [], blind: false, errors: [] };
    const out = compareDrift({ ...base, roots: { "/r": counted(mk(8000, 0)) } }, { ...base, roots: { "/r": counted(mk(8000, 8000)) } }, []);
    assert.equal(out.changed.length, 8000);
    assert.ok(scans <= 6, `${scans} enumerações do manifesto`);
  });

  it("a huge external hooks directory is bounded: incomplete, entry points still checked, no noise", () => {
    const r = repo();
    const ext = tmp("duo-drift-bighooks-");
    for (let i = 0; i < 2100; i++) writeFileSync(join(ext, `f${i}`), "x");
    g(r, "config", "core.hooksPath", ext);
    const before = snap([r]);
    writeFileSync(join(ext, "f1"), "changed but not a hook");
    writeFileSync(join(ext, "pre-commit"), "#!/bin/sh\n");
    const out = compareDrift(before, snap([r]), []);
    assert.deepEqual(out.changed, [join(ext, "pre-commit")]);
    assert.equal(out.incomplete, true);
  });

  it("a checkout opened with different casing is still recognized below a hooks directory", () => {
    const parent = tmp("duo-drift-case-");
    const stored = join(parent, "Repo");
    mkdirSync(stored);
    if (!existsSync(join(parent, "repo"))) return; // volume sensível a maiúsculas: o caso não existe
    g(stored, "init", "-q");
    writeFileSync(join(stored, ".gitignore"), "node_modules/\n");
    g(stored, "add", ".");
    g(stored, "commit", "-q", "-m", "base");
    g(stored, "config", "core.hooksPath", parent);
    const opened = join(parent, "repo");
    const before = snap([opened]);
    mkdirSync(join(stored, "node_modules"));
    writeFileSync(join(stored, "node_modules", "x.js"), "x");
    assert.deepEqual(compareDrift(before, snap([opened]), []).changed, []);
  });

  it("an entry listed but whose metadata cannot be read is unknown, not removed", { skip: process.platform === "win32" || asRoot }, () => {
    const r = repo();
    const ext = tmp("duo-drift-acl-");
    mkdirSync(join(ext, "sub"));
    writeFileSync(join(ext, "sub", "lib.sh"), "true\n");
    g(r, "config", "core.hooksPath", ext);
    const before = snap([r]);
    chmodSync(join(ext, "sub"), 0o444); // lista, mas não deixa ler os metadados dos filhos
    let after;
    try { after = snap([r]); } finally { chmodSync(join(ext, "sub"), 0o755); }
    const out = compareDrift(before, after, []);
    assert.deepEqual(out.changed, []);
    assert.equal(out.incomplete, true);
  });
});

