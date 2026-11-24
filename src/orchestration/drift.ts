// Conferência pós-tarefa do Gemini no Windows (decisão do dono, 2026-11-23: só avisa).
// Retrato antes/depois do checkout principal, das worktrees irmãs e das raízes de config reais do agy.
// Só detecta, não contém. Qualquer falha de leitura ou do git deixa a conferência incompleta, nunca limpa.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, normalize } from "node:path";
import { git, hashPathStrict } from "../git.js";

export type CheckoutSnap = { head: string | null; files: Record<string, string>; index: Record<string, string>; hidden: string[] };
export type DriftSnapshot = { checkouts: Record<string, CheckoutSnap>; roots: Record<string, Record<string, string> | "absent">; errors: string[] };
export type DriftResult = { changed: string[]; appliedNotes: { path: string; taskId: string }[]; hiddenUnchecked: string[]; incomplete: boolean };

// O observador nunca pega o index.lock de um stage, commit ou `duo apply` concorrente.
const observe = (cwd: string, args: string[]) => git(cwd, ["--no-optional-locks", ...args]);
const MISSING = "missing";

function snapCheckout(co: string, errors: string[]): CheckoutSnap | null {
  const fail = (what: string, r: { stderr: string; error?: string }) => { errors.push(`${co}: git ${what}: ${(r.error ?? r.stderr).trim() || "falhou"}`); return null; };
  const head = observe(co, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  // código 1 sem stderr = repositório sem commits; qualquer outra falha é erro
  if (!head.ok && !(head.code === 1 && !head.stderr.trim() && !head.error)) return fail("rev-parse", head);
  const status = observe(co, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return fail("status", status);
  const dirty: string[] = [];
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    dirty.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && parts[i + 1]) dirty.push(parts[++i] as string);
  }
  const files: Record<string, string> = {};
  for (const rel of new Set(dirty)) {
    const h = hashPathStrict(join(co, rel));
    if ("error" in h) errors.push(h.error);
    else files[rel] = "hash" in h ? h.hash : MISSING;
  }
  const index: Record<string, string> = {};
  const rels = Object.keys(files);
  for (let i = 0; i < rels.length; i += 200) {
    const r = observe(co, ["ls-files", "-s", "-z", "--", ...rels.slice(i, i + 200).map((rel) => `:(literal)${rel}`)]);
    if (!r.ok) return fail("ls-files -s", r);
    for (const line of r.stdout.split("\0").filter(Boolean)) {
      const tab = line.indexOf("\t");
      const [mode, blob, stage] = line.slice(0, tab).split(" ");
      const path = line.slice(tab + 1);
      const val = stage === "0" ? `${mode} ${blob}` : `${mode} ${blob} ${stage}`;
      index[path] = index[path] ? `${index[path]},${val}` : val;
    }
  }
  const tags = observe(co, ["ls-files", "-v", "-z"]);
  if (!tags.ok) return fail("ls-files -v", tags);
  // minúscula = assume-unchanged; S = skip-worktree: o status omite esses caminhos
  const hidden = tags.stdout.split("\0").filter((e) => e.length > 2 && (e[0] === "S" || e[0] !== e[0]!.toUpperCase())).map((e) => e.slice(2));
  return { head: head.ok ? head.stdout.trim() : null, files, index, hidden };
}

function snapRoot(root: string, errors: string[]): Record<string, string> | "absent" | null {
  let real: string;
  try { real = realpathSync(root); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    errors.push(`${root}: ${code ?? (error as Error).message}`);
    return null;
  }
  // tipo, tamanho e mtime (sem hash de conteúdo por tarefa); diretório só pelo tipo, o conteúdo aparece nas entradas
  const manifest: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    let st;
    try { st = lstatSync(abs); }
    catch (error) { errors.push(`${abs}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`); return; }
    if (st.isDirectory()) {
      manifest[rel] = "d";
      let names: string[];
      try { names = readdirSync(abs); }
      catch (error) { errors.push(`${abs}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`); return; }
      for (const n of names) walk(join(abs, n), rel === "." ? n : `${rel}/${n}`);
    } else manifest[rel] = `${st.isFile() ? "f" : st.isSymbolicLink() ? "l" : "o"}:${st.size}:${st.mtimeMs}`;
  };
  walk(real, ".");
  return manifest;
}

export function takeDriftSnapshot(opts: { checkouts: string[]; configRoots: string[] }): DriftSnapshot {
  const out: DriftSnapshot = { checkouts: {}, roots: {}, errors: [] };
  for (const co of opts.checkouts) {
    const s = snapCheckout(co, out.errors);
    if (s) out.checkouts[co] = s;
  }
  for (const root of opts.configRoots) {
    const m = snapRoot(root, out.errors);
    if (m) out.roots[root] = m;
  }
  return out;
}

function diffMaps(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
}

export function compareDrift(before: DriftSnapshot, after: DriftSnapshot, applies: { taskId: string; files: string[] }[]): DriftResult {
  const changed = new Set<string>();
  const hidden = new Set<string>();
  for (const co of new Set([...Object.keys(before.checkouts), ...Object.keys(after.checkouts)])) {
    const a = before.checkouts[co], b = after.checkouts[co];
    if (!a || !b) { changed.add(co); continue; } // um lado falhou (já em errors) ou o checkout surgiu/sumiu
    if (a.head !== b.head) changed.add(`${co} (HEAD)`);
    // ausente de um lado = igual ao HEAD daquele retrato; aparecer, sumir ou mudar de hash conta
    for (const rel of [...diffMaps(a.files, b.files), ...diffMaps(a.index, b.index)]) changed.add(join(co, rel));
    for (const rel of [...a.hidden, ...b.hidden]) hidden.add(join(co, rel));
  }
  for (const root of new Set([...Object.keys(before.roots), ...Object.keys(after.roots)])) {
    const a = before.roots[root], b = after.roots[root];
    if (a === undefined || b === undefined) continue; // leitura falhou: errors já deixa incompleto
    if (a === "absent" || b === "absent") { if (a !== b) changed.add(root); continue; }
    for (const rel of diffMaps(a, b)) changed.add(rel === "." ? root : join(root, rel));
  }
  const list = [...changed].sort();
  // o apply não absolve o caminho: outro escritor pode ter mexido depois dele
  const appliedNotes = list.flatMap((path) => applies.filter((ap) => ap.files.some((f) => normalize(f) === path)).map((ap) => ({ path, taskId: ap.taskId })));
  return { changed: list, appliedNotes, hiddenUnchecked: [...hidden].sort(), incomplete: before.errors.length > 0 || after.errors.length > 0 };
}
