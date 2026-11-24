// Conferência pós-tarefa do Gemini no Windows (decisão do dono, 2026-11-23: só avisa).
// Retrato antes/depois do checkout principal, das worktrees irmãs, do .git de cada uma e das raízes de config
// reais do agy. Só detecta, não contém. Qualquer falha de leitura ou do git deixa a conferência incompleta, nunca limpa.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { hashPathStrict } from "../git.js";

type Dict = Record<string, string>;
/** indexGaps: caminhos sujos cujo lote do `ls-files -s` falhou (índice não observado, não comparado) */
export type CheckoutSnap = { head: string | null; files: Dict; index: Dict; indexGaps: string[]; hidden: string[] };
export type DriftSnapshot = {
  checkouts: Record<string, CheckoutSnap>;
  roots: Record<string, Dict | "absent">;
  /** checkouts e raízes cuja observação falhou inteira: sem retrato, nunca contam como mudança */
  failed: string[];
  /** algum checkout ou a descoberta do .git dele falhou: raízes que faltam neste retrato podem não ter sido vistas */
  blind: boolean;
  errors: string[];
};
/** unverified: caminhos cujo conteúdo falhou na leitura num dos retratos (só metadados comparados); arquivo acima do limite de hash é metadados por desenho (spec) e não entra */
export type DriftResult = { changed: string[]; appliedNotes: { path: string; taskId: string }[]; hiddenUnchecked: string[]; unverified: string[]; incomplete: boolean };
export type DriftApply = { taskId: string; root: string; files: string[] };

// chaves vindas do disco: sem protótipo, `__proto__` é um nome de arquivo como outro
const dict = (): Dict => Object.create(null) as Dict;
const SMALL_FILE = 256 * 1024;
// Pontos de entrada que o git executa: só eles são observados no diretório de hooks (core.hooksPath pode ser
// qualquer pasta, até a raiz do checkout). Cada um é uma raiz própria, e a raiz segue link: vale o alvo que o git roda.
const HOOK_NAMES = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change"];
// O observador nunca pega o index.lock de um stage, commit ou `duo apply` concorrente, nunca roda o fsmonitor
// do repositório (comando arbitrário que também poderia esconder mudanças) e não confia no cache de não rastreados.
function observe(cwd: string, args: string[]) {
  const r = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd, encoding: "utf8", shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0 && !r.error, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message };
}

// Avisos de fim de linha não afetam o que o status lista; qualquer outro stderr pode esconder caminhos.
const BENIGN_STDERR = /^(warning: (in the working copy of |LF will be replaced|CRLF will be replaced)|The file will have its original line endings)/;

/** Lotes de pathspecs abaixo do limite de linha de comando do Windows (32.767), contando prefixo e aspas. */
export function batchByLength(items: string[], budget: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [], used = 0;
  for (const it of items) {
    const cost = it.length + 3;
    if (cur.length && used + cost > budget) { out.push(cur); cur = []; used = 0; }
    cur.push(it);
    used += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

// checkouts observados: caminho real (para classificar a pasta de hooks) e identidade no disco dev:ino (para não descer
// neles; o texto do caminho falha em volume que ignora maiúsculas)
type Checkouts = { reals: string[]; ids: Set<string> };
const fileId = (p: string) => { const st = statSync(p, { bigint: true }); return `${st.dev}:${st.ino}`; };
// teto da varredura da pasta de hooks: core.hooksPath no perfil ou na raiz do disco vira falha daquela raiz
// (conferência incompleta), nunca uma varredura do disco; os pontos de entrada seguem conferidos à parte
const HOOKS_DIR_BUDGET = 2000;

function snapCheckout(co: string, out: DriftSnapshot, checkouts: Checkouts): void {
  const err = (what: string, r: { stderr: string; error?: string }) => out.errors.push(`${co}: git ${what}: ${(r.error ?? r.stderr).trim() || "falhou"}`);
  const fail = (what: string, r: { stderr: string; error?: string }) => { err(what, r); out.failed.push(co); out.blind = true; };
  const head = observe(co, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  // código 1 sem stderr = repositório sem commits; qualquer outra falha é erro
  if (!head.ok && !(head.code === 1 && !head.stderr.trim() && !head.error)) return fail("rev-parse", head);
  const status = observe(co, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return fail("status", status);
  // status com saída 0 ainda pode pular um diretório que não conseguiu abrir
  for (const line of status.stderr.split(/\r?\n/)) if (line.trim() && !BENIGN_STDERR.test(line)) out.errors.push(`${co}: git status: ${line.trim()}`);
  const dirty: string[] = [];
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    dirty.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && parts[i + 1]) dirty.push(parts[++i] as string);
  }
  const files = dict();
  for (const rel of new Set(dirty)) {
    const h = hashPathStrict(join(co, rel));
    if ("error" in h) out.errors.push(h.error);
    else files[rel] = "hash" in h ? h.hash : "missing";
  }
  const index = dict();
  const indexGaps: string[] = [];
  for (const batch of batchByLength(Object.keys(files).map((rel) => `:(literal)${rel}`), 24_000)) {
    const r = observe(co, ["ls-files", "-s", "-z", "--", ...batch]);
    if (!r.ok) { err("ls-files -s", r); indexGaps.push(...batch.map((p) => p.slice(":(literal)".length))); continue; }
    for (const line of r.stdout.split("\0").filter(Boolean)) {
      const tab = line.indexOf("\t");
      const [mode, blob, stage] = line.slice(0, tab).split(" ");
      const path = line.slice(tab + 1);
      const val = stage === "0" ? `${mode} ${blob}` : `${mode} ${blob} ${stage}`;
      index[path] = index[path] ? `${index[path]},${val}` : val;
    }
  }
  let hidden: string[] = [];
  const tags = observe(co, ["ls-files", "-v", "-z"]);
  if (!tags.ok) err("ls-files -v", tags);
  // minúscula = assume-unchanged; S = skip-worktree: o status omite esses caminhos
  else hidden = tags.stdout.split("\0").filter((e) => e.length > 2 && (e[0] === "S" || e[0] !== e[0]!.toUpperCase())).map((e) => e.slice(2));
  out.checkouts[co] = { head: head.ok ? head.stdout.trim() : null, files, index, indexGaps, hidden };
  // .git fica fora do status: config, config.worktree (também do checkout principal), info/exclude e o diretório
  // de hooks que o git usa de fato (core.hooksPath) entram como raízes
  const dirs = observe(co, ["rev-parse", "--git-dir", "--git-common-dir", "--git-path", "hooks", "--git-path", "info/sparse-checkout"]);
  if (!dirs.ok) { err("rev-parse --git-dir", dirs); out.blind = true; return; }
  const [gitDir, common, hooks, sparse] = dirs.stdout.trim().split(/\r?\n/).map((d) => (isAbsolute(d) ? d : resolve(co, d)));
  // Pasta de hooks inteira (scripts auxiliares que um hook carrega) quando o caminho real fica no .git ou fora do
  // checkout. Dentro do checkout (ex.: core.hooksPath=., ou link/junção para ele) só os pontos de entrada: os
  // rastreados passam pelo status e os ignorados ficam fora da conferência (spec). Pasta que não resolve: só entradas.
  // Nenhum checkout observado conta como "fora" (um hooksPath absoluto no checkout principal, visto de uma irmã).
  let hooksReal: string | null = null;
  try { hooksReal = realpathSync(hooks!); }
  catch (error) {
    const c = (error as NodeJS.ErrnoException).code;
    // inacessível (não ausente): falha da raiz, nunca "removida"
    if (c !== "ENOENT" && c !== "ENOTDIR") { out.errors.push(`${hooks}: ${c ?? (error as Error).message}`); if (!out.failed.includes(hooks!)) out.failed.push(hooks!); }
  }
  const commonReal = (() => { try { return realpathSync(common!); } catch { return null; } })();
  const walkHooks = !!hooksReal && ((!!commonReal && inside(commonReal, hooksReal)) || !checkouts.reals.some((c) => inside(c, hooksReal!)));
  for (const p of new Set([join(common!, "config"), join(common!, "info"), join(gitDir!, "config.worktree"), sparse!, ...(walkHooks ? [hooks!] : []), ...HOOK_NAMES.map((n) => join(hooks!, n))])) {
    if (!(p in out.roots) && !out.failed.includes(p)) snapRoot(p, out, p === hooks ? { skipIds: checkouts.ids, budget: HOOKS_DIR_BUDGET } : {});
  }
}

// componente "..", não prefixo: `..hooks` é um nome válido dentro da pasta
function inside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function snapRoot(root: string, out: DriftSnapshot, opts: { skipIds?: Set<string>; budget?: number } = {}): void {
  const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error as Error).message;
  let real: string;
  try { real = realpathSync(root); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(code(error))) { out.roots[root] = "absent"; return; }
    out.errors.push(`${root}: ${code(error)}`);
    out.failed.push(root);
    return;
  }
  // diretório só pelo tipo (o conteúdo aparece nas entradas); arquivo por tipo, tamanho, mtime, ctime e,
  // se pequeno, conteúdo (mtime e tamanho iguais não bastam: o mtime volta com utimes)
  const manifest = dict();
  const walk = (abs: string, rel: string) => {
    let st;
    if (opts.budget !== undefined && ++seen > opts.budget) { truncated = true; return; }
    // listado mas sem metadados legíveis: desconhecido ("?"), nunca removido
    try { st = lstatSync(abs); }
    catch (error) { out.errors.push(`${abs}: ${code(error)}`); manifest[rel] = "?"; return; }
    if (st.isDirectory()) {
      manifest[rel] = "d";
      // pasta acima de um checkout (ex.: hooksPath=$HOME): não desce nele, o status cobre o que é rastreado
      if (opts.skipIds?.size) { try { if (opts.skipIds.has(fileId(abs))) return; } catch { /* lstat já passou; segue */ } }
      let names: string[];
      // listagem que falhou marca "d?": o que havia embaixo no outro retrato não conta como apagado
      try { names = readdirSync(abs); }
      catch (error) { out.errors.push(`${abs}: ${code(error)}`); manifest[rel] = "d?"; return; }
      for (const n of names) { if (truncated) return; walk(join(abs, n), rel === "." ? n : `${rel}/${n}`); }
      return;
    }
    let sig = `${st.isFile() ? "f" : st.isSymbolicLink() ? "l" : "o"}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    if (st.isFile() && st.size <= SMALL_FILE) {
      const h = hashPathStrict(abs);
      // conteúdo ilegível (arquivo travado no Windows) marca "?": compara só os metadados, e errors deixa incompleto
      if ("error" in h) { out.errors.push(h.error); sig += ":?"; }
      else if ("hash" in h) sig += `:${h.hash}`;
    }
    manifest[rel] = sig;
  };
  let seen = 0, truncated = false;
  walk(real, ".");
  if (truncated) { out.errors.push(`${root}: mais de ${opts.budget} entradas; só os pontos de entrada foram conferidos`); out.failed.push(root); return; }
  out.roots[root] = manifest;
}

export function takeDriftSnapshot(opts: { checkouts: string[]; configRoots: string[] }): DriftSnapshot {
  const out: DriftSnapshot = { checkouts: Object.create(null), roots: Object.create(null), failed: [], blind: false, errors: [] };
  const checkouts: Checkouts = { reals: [], ids: new Set() };
  for (const co of opts.checkouts) { try { checkouts.reals.push(realpathSync(co)); checkouts.ids.add(fileId(co)); } catch { /* o snapCheckout registra a falha */ } }
  for (const co of opts.checkouts) snapCheckout(co, out, checkouts);
  for (const root of opts.configRoots) if (!(root in out.roots) && !out.failed.includes(root)) snapRoot(root, out);
  return out;
}

function diffMaps(a: Dict, b: Dict, same = (x?: string, y?: string) => x === y): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));
}

// assinatura de raiz: tipo:tamanho:mtime:ctime[:hash|?]; com conteúdo não lido num lado, valem só os metadados
function sameSig(x?: string, y?: string): boolean {
  if (x === y) return true;
  if (x?.startsWith("d") && y?.startsWith("d")) return true; // "d" e "d?" (diretório não listado)
  if (x === "?" || y === "?") return true; // metadados ilegíveis num lado: desconhecido (errors deixa incompleto)
  if (!x || !y || !(x.endsWith(":?") || y.endsWith(":?"))) return false;
  const meta = (s: string) => s.split(":").slice(0, 4).join(":");
  return meta(x) === meta(y);
}

export function compareDrift(before: DriftSnapshot, after: DriftSnapshot, applies: DriftApply[]): DriftResult {
  const changed = new Set<string>();
  const hidden = new Set<string>();
  const unverified = new Set<string>();
  const failed = new Set([...before.failed, ...after.failed]);
  for (const co of new Set([...Object.keys(before.checkouts), ...Object.keys(after.checkouts)])) {
    if (failed.has(co)) continue; // observação falhou (já em errors): sem prova de mudança
    const a = before.checkouts[co], b = after.checkouts[co];
    if (!a || !b) { changed.add(co); continue; } // checkout surgiu ou sumiu
    if (a.head !== b.head) changed.add(`${co} (HEAD)`);
    // ausente de um lado = igual ao HEAD daquele retrato; aparecer, sumir ou mudar de hash conta
    const gaps = new Set([...a.indexGaps, ...b.indexGaps]); // índice não observado num lado: só o hash do arquivo conta
    for (const rel of [...diffMaps(a.files, b.files), ...diffMaps(a.index, b.index).filter((rel) => !gaps.has(rel))]) changed.add(join(co, rel));
    for (const rel of [...a.hidden, ...b.hidden]) hidden.add(join(co, rel));
  }
  for (const root of new Set([...Object.keys(before.roots), ...Object.keys(after.roots)])) {
    if (failed.has(root)) continue;
    // raiz que falta num retrato: ausente, a menos que esse retrato não tenha conseguido descobrir todas
    if ((!(root in before.roots) && before.blind) || (!(root in after.roots) && after.blind)) continue;
    const a = before.roots[root] ?? "absent", b = after.roots[root] ?? "absent";
    if (a === "absent" || b === "absent") { if (a !== b) changed.add(root); continue; }
    const abs = (rel: string) => (rel === "." ? root : join(root, rel));
    // só os ancestrais do caminho: comparação linear mesmo com milhares de adições
    const unlisted = (m: Dict, rel: string) => {
      if (m["."] === "d?") return true;
      for (let i = rel.indexOf("/"); i > 0; i = rel.indexOf("/", i + 1)) { const v = m[rel.slice(0, i)]; if (v === "d?" || v === "?") return true; }
      return false;
    };
    for (const rel of diffMaps(a, b, sameSig)) {
      // presente só de um lado, sob um diretório que o outro lado não conseguiu listar: sem prova
      if ((a[rel] === undefined && unlisted(a, rel)) || (b[rel] === undefined && unlisted(b, rel))) continue;
      changed.add(abs(rel));
    }
    for (const rel of Object.keys(a)) if (b[rel] !== undefined && (a[rel]!.endsWith("?") || b[rel]!.endsWith("?")) && sameSig(a[rel], b[rel])) unverified.add(abs(rel));
  }
  const list = [...changed].sort();
  // o apply registra caminhos relativos ao checkout principal; ele não absolve o caminho (outro escritor pode ter mexido depois)
  const appliedNotes = list.flatMap((path) => applies.filter((ap) => ap.files.some((f) => normalize(resolve(ap.root, f)) === path)).map((ap) => ({ path, taskId: ap.taskId })));
  return { changed: list, appliedNotes, hiddenUnchecked: [...hidden].sort(), unverified: [...unverified].sort(), incomplete: before.errors.length > 0 || after.errors.length > 0 };
}
