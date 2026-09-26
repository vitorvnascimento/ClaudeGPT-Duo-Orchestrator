// Operações Git não destrutivas. Este módulo nunca executa reset, clean, stash, checkout de arquivos
// ou qualquer comando que descarte alterações do usuário.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Patch das mudanças do worktree descartável (o índice alterado é o do worktree, não o do usuário). */
export function worktreePatch(wt: string, base: string): { ok: boolean; patch: string; files: string[]; error?: string } {
  const add = git(wt, ["add", "-A"]);
  if (!add.ok) return { ok: false, patch: "", files: [], error: add.stderr };
  const names = git(wt, ["diff", "--cached", "--name-only", "-z", base]);
  const patch = git(wt, ["diff", "--cached", "--binary", "--no-color", base]);
  if (!patch.ok) return { ok: false, patch: "", files: [], error: patch.stderr };
  return { ok: true, patch: patch.stdout, files: names.stdout.split("\0").filter(Boolean) };
}
