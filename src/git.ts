// Operações Git não destrutivas. Este módulo nunca executa reset, clean, stash, checkout de arquivos
// ou qualquer comando que descarte alterações do usuário.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync, statSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep, resolve } from "node:path";
import { isDenied, normalizeRel } from "./permissions/scope.js";
import { runQuick } from "./adapters/process.js";

export function git(cwd: string, args: string[], timeoutMs = 60_000) {
  return runQuick("git", args, { cwd, timeoutMs });
}

export function repoRoot(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.stdout.trim() : null;
}

export function headCommit(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

/** Arquivos rastreados + não rastreados não ignorados sob os caminhos dados. */
export function listFiles(cwd: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const r = git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths]);
  if (!r.ok) return [];
  return [...new Set(r.stdout.split("\0").filter(Boolean))];
}

/** Caminhos com alteração no working tree (inclui não rastreados). */
export function dirtyPaths(cwd: string): string[] {
  const r = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!r.ok) return [];
  const out: string[] = [];
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    out.push(entry.slice(3));
    if (xy.includes("R") || xy.includes("C")) {
      const orig = parts[++i];
      if (orig) out.push(orig);
    }
  }
  return [...new Set(out)];
}

export function hashPath(abs: string): string | null {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    if (!st.isFile()) return null;
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

export type TreeState = {
  head: string | null;
  /** rel -> sha256 (null = inexistente) para arquivos do escopo e arquivos sujos. */
  hashes: Record<string, string | null>;
  scopeFiles: string[];
};

export function captureState(root: string, scopeRels: string[]): TreeState {
  const scopePaths = scopeRels.filter((r) => r !== ".");
  const scopeFiles = scopeRels.includes(".") ? listFiles(root, ["."]) : listFiles(root, scopePaths);
  // Arquivos explicitamente autorizados que ainda não existem também entram (hash null).
  for (const r of scopePaths) if (!scopeFiles.includes(r) && !existsSync(join(root, r))) scopeFiles.push(r);
  const keys = new Set([...scopeFiles, ...dirtyPaths(root)]);
  const hashes: Record<string, string | null> = {};
  for (const k of keys) hashes[k] = hashPath(join(root, k));
  return { head: headCommit(root), hashes, scopeFiles };
}

export type ChangeSet = { changed: string[]; created: string[]; deleted: string[] };

export function diffStates(root: string, before: TreeState, scopeRels: string[]): ChangeSet {
  const after = captureState(root, scopeRels);
  const keys = new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)]);
  const changed: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  for (const k of [...keys].sort()) {
    const a = k in before.hashes ? before.hashes[k] : hashPathIfClean(root, k, before);
    const b = k in after.hashes ? after.hashes[k] : hashPath(join(root, k));
    if (a === b) continue;
    changed.push(k);
    if (a === null && b !== null) created.push(k);
    if (a !== null && b === null) deleted.push(k);
  }
  return { changed, created, deleted };
}

// Arquivo que não estava sujo nem no escopo antes estava igual ao HEAD (ou não existia).
// Se agora aparece como sujo, mudou: o sentinela nunca coincide com um hash.
function hashPathIfClean(root: string, rel: string, before: TreeState): string | null {
  if (!before.head) return null;
  return git(root, ["cat-file", "-e", `${before.head}:${rel}`]).ok ? "clean-at-head" : null;
}

/** Copia os arquivos do escopo para permitir diff exato do que o executor mudou (preserva alterações prévias). */
export function snapshotFiles(root: string, files: string[], dest: string, maxBytes: number): { saved: string[]; skipped: string[] } {
  const saved: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const rel of files) {
    const src = join(root, rel);
    let size: number;
    try {
      const st = lstatSync(src);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (total + size > maxBytes) {
      skipped.push(rel);
      continue;
    }
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
    total += size;
    saved.push(rel);
  }
  return { saved, skipped };
}

/** Diff unificado entre o snapshot e o estado atual, com cabeçalhos relativos ao projeto. */
export function diffAgainstSnapshot(root: string, snapshotDir: string, rels: string[]): string {
  const empty = join(snapshotDir, ".duo-empty");
  if (!existsSync(empty)) {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(empty, "");
  }
  const chunks: string[] = [];
  for (const rel of rels) {
    const before = join(snapshotDir, rel);
    const after = join(root, rel);
    const hasBefore = existsSync(before);
    const hasAfter = existsSync(after);
    const r = git(root, ["diff", "--no-index", "--no-color", "--", hasBefore ? before : empty, hasAfter ? after : empty]);
    const body = r.stdout.split("\n");
    const hunkStart = body.findIndex((l) => l.startsWith("@@") || l.startsWith("Binary files"));
    if (hunkStart === -1) continue;
    chunks.push(
      [`diff --git a/${rel} b/${rel}`, hasBefore ? `--- a/${rel}` : "--- /dev/null", hasAfter ? `+++ b/${rel}` : "+++ /dev/null", ...body.slice(hunkStart)].join("\n").trimEnd(),
    );
  }
  return chunks.length ? `${chunks.join("\n")}\n` : "";
}

export function worktreeAdd(root: string, path: string, commit: string) {
  return git(root, ["worktree", "add", "--detach", path, commit], 120_000);
}

/** Inclui o estado não commitado sem tocar no índice do projeto e sem levar caminhos privados. */
/**
 * Link só é seguro se for relativo, apontar para um arquivo (não diretório) dentro do projeto e não negado,
 * e continuar dentro da cópia; senão vira porta para fora dela (ou de volta ao projeto).
 */
function unsafeLink(root: string, rel: string, allowed: (rel: string) => boolean): boolean {
  const src = join(root, rel);
  const raw = readlinkSync(src);
  if (isAbsolute(raw)) return true;
  let target: string;
  try {
    const real = realpathSync(src);
    if (statSync(real).isDirectory()) return true;
    target = relative(realpathSync(root), real);
  } catch { return true; }
  if (target.startsWith("..") || isAbsolute(target) || !allowed(target.split(sep).join("/"))) return true;
  const inCopy = normalize(join(dirname(rel), raw));
  return inCopy.startsWith("..") || isAbsolute(inCopy);
}

export function worktreeSnapshot(root: string, wt: string, opts: { deny: string[]; maxBytes: number }): { ok: true; snapshot: string | null; copiedBytes: number } | { ok: false; error: string } {
  const tracked = git(root, ["diff", "HEAD", "--name-only", "--no-renames", "-z"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!tracked.ok || !untracked.ok) return { ok: false, error: tracked.stderr || untracked.stderr };
  const allowed = (rel: string) => rel !== ".duo" && !rel.startsWith(".duo/") && !isDenied(rel, opts.deny);
  const trackedFiles = tracked.stdout.split("\0").filter(Boolean);
  const newFiles = untracked.stdout.split("\0").filter((rel) => rel && allowed(rel));
  let copiedBytes = 0;
  try {
    // Conta tudo antes de aplicar até mesmo o diff rastreado: limite excedido nunca deixa cópia parcial executável.
    for (const rel of [...trackedFiles.filter(allowed), ...newFiles]) {
      try { copiedBytes += lstatSync(join(root, rel)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (copiedBytes > opts.maxBytes) return { ok: false, error: `snapshot de ${copiedBytes} bytes excede limits.maxSnapshotBytes (${opts.maxBytes})` };
    const excludes = [".duo", ...trackedFiles.filter((rel) => !allowed(rel))].map((rel) => `:(exclude,literal)${rel}`);
    // Diff só da lista permitida já enumerada: um arquivo negado que mude depois da enumeração nunca entra.
    const allowedTracked = trackedFiles.filter(allowed);
    let patch = "";
    let emitted: string[] = [];
    for (let i = 0; i < allowedTracked.length; i += 200) {
      const batch = allowedTracked.slice(i, i + 200).map((rel) => `:(literal)${rel}`);
      const diff = spawnSync("git", ["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--", ...batch, ...excludes], {
        cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: Math.max(4 * 1024 * 1024, opts.maxBytes * 4), windowsHide: true,
      });
      if (diff.status !== 0 || diff.error) return { ok: false, error: diff.error?.message ?? diff.stderr };
      patch += diff.stdout;
    }
    if (patch) {
      // Pathspec literal ainda casa descendentes (ex.: `config` virou diretório com `config/.env` negado):
      // confere cada caminho que o patch traz antes de aplicar qualquer coisa.
      const listed = spawnSync("git", ["apply", "--numstat", "-z", "-"], { cwd: wt, input: patch, encoding: "utf8", timeout: 60_000, windowsHide: true });
      if (listed.status !== 0 || listed.error) return { ok: false, error: listed.error?.message ?? listed.stderr };
      emitted = listed.stdout.split("\0").filter(Boolean).map((entry) => entry.split("\t").slice(2).join("\t"));
      const forbidden = emitted.filter((rel) => !allowed(rel));
      if (forbidden.length) return { ok: false, error: `snapshot recusado: o diff traria caminhos negados ou de .duo/ (${forbidden.length})` };
      const applied = spawnSync("git", ["apply", "--index", "--binary", "-"], { cwd: wt, input: patch, encoding: "utf8", timeout: 60_000, windowsHide: true });
      if (applied.status !== 0 || applied.error) return { ok: false, error: applied.error?.message ?? applied.stderr };
    }
    for (const rel of newFiles) {
      const src = join(root, rel), dest = join(wt, rel);
      mkdirSync(dirname(dest), { recursive: true });
      const parent = relative(realpathSync(wt), realpathSync(dirname(dest)));
      if (parent.startsWith("..") || isAbsolute(parent)) return { ok: false, error: `snapshot fora da worktree: ${rel}` };
      if (lstatSync(src).isSymbolicLink()) {
        if (unsafeLink(root, rel, allowed)) continue;
        const raw = readlinkSync(src);
        // Windows sem modo desenvolvedor exige admin para symlink: bloqueia com diagnóstico, nunca omite o link
        // (a cópia ficaria diferente do projeto) nem copia o alvo no lugar.
        try { symlinkSync(raw, dest); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return { ok: false, error: code === "EPERM" ? `criar o link simbólico ${rel} na worktree exige privilégio (no Windows: modo desenvolvedor ou administrador)` : (error as Error).message };
        }
        const inWt = relative(realpathSync(wt), resolve(dirname(dest), raw));
        if (inWt.startsWith("..") || isAbsolute(inWt)) { rmSync(dest, { force: true }); continue; }
      } else copyFileSync(src, dest);
    }
    // Link rastreado (ex.: `git add` de um link novo) segue as regras dos não rastreados. Confere o que o patch
    // gravou na worktree (privada), não o projeto, que pode mudar entre o diff e a conferência.
    // Inseguro recusa o snapshot inteiro (nunca omite um caminho do diff).
    const badLinks = emitted.filter((rel) => {
      try { return lstatSync(join(wt, rel)).isSymbolicLink() && unsafeLink(wt, rel, allowed); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    });
    if (badLinks.length) {
      for (const rel of badLinks) rmSync(join(wt, rel), { force: true }); // a worktree recusada nunca guarda a porta
      return { ok: false, error: `snapshot recusado: link simbólico rastreado que sai do projeto, aponta para diretório ou para caminho negado (${badLinks.join(", ")})` };
    }
    const add = git(wt, ["add", "-A", "--", ".", ...excludes]);
    if (!add.ok) return { ok: false, error: add.stderr };
    const changed = git(wt, ["diff", "--cached", "--name-only", "-z"]);
    if (!changed.ok) return { ok: false, error: changed.stderr };
    if (!changed.stdout) return { ok: true, snapshot: null, copiedBytes };
    const commit = git(wt, ["-c", "user.name=duo", "-c", "user.email=duo@localhost", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "commit", "--no-verify", "-q", "-m", "duo: snapshot"]);
    if (!commit.ok) return { ok: false, error: commit.stderr };
    return { ok: true, snapshot: headCommit(wt), copiedBytes };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}

export function linkIntoWorktree(root: string, wt: string, rels: string[]): { linked: string[]; failed: string[] } {
  const linked: string[] = [], failed: string[] = [];
  for (const rel of rels) {
    if (!normalizeRel(rel) || rel === "." || rel === ".duo" || rel.startsWith(".duo/")) { failed.push(rel); continue; }
    const src = join(root, rel), dest = join(wt, rel);
    if (!existsSync(src) || existsSync(dest)) continue;
    try {
      const target = realpathSync(src), inside = relative(realpathSync(root), target);
      if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("link fora do projeto");
      mkdirSync(dirname(dest), { recursive: true });
      const parent = relative(realpathSync(wt), realpathSync(dirname(dest)));
      if (parent.startsWith("..") || isAbsolute(parent)) throw new Error("link fora da worktree");
      symlinkSync(target, dest, process.platform === "win32" && lstatSync(target).isDirectory() ? "junction" : undefined);
      linked.push(rel);
    } catch { failed.push(rel); }
  }
  return { linked, failed };
}

/** Patch das mudanças do worktree descartável (o índice alterado é o do worktree, não o do usuário). */
export function worktreePatch(wt: string, base: string, exclude: string[] = []): { ok: boolean; patch: string; files: string[]; error?: string } {
  const paths = ["--", ".", ...exclude.map((rel) => `:(exclude,literal)${rel}`)];
  const add = git(wt, ["add", "-A", ...paths]);
  if (!add.ok) return { ok: false, patch: "", files: [], error: add.stderr };
  const names = git(wt, ["diff", "--cached", "--name-only", "--no-renames", "-z", base, ...paths]);
  const patch = git(wt, ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", base, ...paths]);
  if (!names.ok || !patch.ok) return { ok: false, patch: "", files: [], error: names.stderr || patch.stderr };
  return { ok: true, patch: patch.stdout, files: names.stdout.split("\0").filter(Boolean) };
}
