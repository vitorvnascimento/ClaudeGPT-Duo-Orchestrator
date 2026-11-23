// Gate do executor Gemini: hook PreToolUse do agy (`.agents/hooks.json` na worktree descartável).
// Evidência e receita: docs/gemini-agy-facts.md e tests/fixtures/agy/probe/. O agy bloqueia a chamada quando o hook
// nega, quebra, devolve lixo ou estoura o tempo (verificado no 1.5.3), então o gate só precisa errar para "deny".
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep, win32 } from "node:path";
import { packageRoot } from "../paths.js";
import { isDenied, normalizeRel } from "../permissions/scope.js";

export type GeminiTarget = { rel: string; abs: string; isDir: boolean; missingAncestors: string[] };
export type GateAllowlist = { worktreeRoot: string; write: { rel: string; isDir: boolean }[]; deny: string[]; readOnly: boolean };
/** O que writeGateFiles grava e o hook lê: a allowlist do chamador mais o nonce da preparação e o prazo do hook. */
export type PersistedGateAllowlist = GateAllowlist & { nonce: string; hookTimeoutSec: number };
export type GateDecision = { decision: "allow" | "deny"; reason: string };

/** Ferramentas de leitura liberadas dentro da worktree. Nomes fora destas listas são negados. */
const READ_TOOLS = new Set(["read_file", "view_file", "view_file_outline", "list_dir", "grep_search", "find_by_name"]);
/** Encerramento do turno com a saída estruturada (--json-schema); não lê nem grava nada. */
const DONE_TOOLS = new Set(["finish"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]);
/** Pastas que o executor nunca grava, mesmo dentro de um alvo de diretório (em qualquer nível e caixa: o APFS ignora caixa). */
const PROTECTED = [".agents", ".git", ".duo"];
export function isProtectedRel(rel: string): boolean {
  return rel.toLowerCase().split("/").some((seg) => PROTECTED.includes(seg));
}
/**
 * Busca de conteúdo: só sobre um arquivo. Numa pasta ela alcançaria arquivos negados por grafias que o gate não
 * consegue provar equivalentes (caixa, forma Unicode, submódulos, pastas trocadas); a leitura de pastas fica com
 * list_dir/find_by_name (só nomes) e read_file arquivo a arquivo.
 */
const FILE_ONLY = new Set(["grep_search"]);
const PATH_KEY = /path|file|dir|directory/i;

/**
 * Caminho real, resolvido componente a componente como o sistema operacional resolve: cada link (inclusive quebrado)
 * é seguido antes do próximo componente, ".." vale depois do link (nunca colapso léxico antes), e cada parte existente
 * vem com o nome gravado no disco (realpath nativo: caixa e forma Unicode reais). Depois do primeiro componente
 * inexistente (ENOENT) o resto é literal; um ".." depois dele é recusado (voltaria a uma pasta existente sem conferir
 * os links do caminho), e qualquer outro erro de leitura se propaga. O gate trata exceção como negação.
 */
export function canonicalPath(p: string, depth = 0): string {
  if (depth > 40) throw new Error(`links demais ao resolver ${p}`);
  const abs = isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`;
  // Começa na raiz real do caminho (unidade ou compartilhamento UNC no Windows) e anda só pelo resto.
  const { root } = parse(abs);
  // No POSIX a barra invertida é caractere de nome válido: só o Windows separa por ela.
  const parts = abs.slice(root.length).split(sep === "\\" ? /[\\/]/ : "/").filter((x) => x !== "" && x !== ".");
  let cur: string = root;
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i] as string;
    if (c === "..") { cur = dirname(cur); continue; }
    const next = join(cur, c);
    let st;
    try { st = lstatSync(next); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const rest = parts.slice(i + 1);
      if (rest.includes("..")) throw new Error(`caminho com ".." depois de componente inexistente: ${p}`);
      return join(next, ...rest);
    }
    if (st.isSymbolicLink()) {
      // O alvo do link continua com o resto do caminho: a regra do ".." depois de inexistente vale através do link.
      const target = readlinkSync(next);
      const base = isAbsolute(target) ? target : `${cur}${sep}${target}`;
      return canonicalPath([base, ...parts.slice(i + 1)].join(sep), depth + 1);
    }
    cur = realpathSync.native(next);
  }
  return cur;
}

export function rawPathArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (!PATH_KEY.test(k)) continue;
    for (const s of Array.isArray(v) ? v : [v]) if (typeof s === "string" && s) out.push(s);
  }
  return out;
}

function pathArgs(args: unknown, worktreeRoot: string, win: boolean): string[] {
  // sem join: "link/.." só se resolve depois do link
  return rawPathArgs(args).map((s) => (win ? (win32.isAbsolute(s) ? s : `${worktreeRoot}\\${s}`) : isAbsolute(s) ? s : `${worktreeRoot}${sep}${s}`));
}

/** Impressão digital de um caminho cru na tentativa: liga a negação no log do gate ao caminho testado sem gravá-lo. */
export function pathDigest(nonce: string, raw: string): string {
  return createHash("sha256").update(`${nonce}\0${raw}`).digest("hex").slice(0, 16);
}

const WIN_DEVICE = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/i;

/**
 * Truques de caminho do Windows, recusados antes de resolver (o Win32 normaliza alguns e não outros, então o gate e a
 * ferramenta poderiam chegar a arquivos diferentes): fluxo NTFS (`:`), ponto ou espaço no fim de um nome, `..`,
 * nomes de dispositivo, prefixos `\\?\`, `\\.\`, `\??\` e UNC, outra unidade, `C:x` relativo à unidade e
 * caracteres inválidos. Um componente com forma de nome curto 8.3 (`~` + dígito) volta como "short-name": vale só se
 * já existir no disco (aí o realpath nativo o troca pelo nome longo).
 */
export function win32PathProblem(raw: string, worktreeRoot: string): string | null {
  if (/^[\\/]{2}/.test(raw) || raw.startsWith("\\??\\")) return "prefixo de dispositivo ou UNC";
  let rest = raw;
  const drive = /^([A-Za-z]):/.exec(raw);
  if (drive) {
    if (!/^[A-Za-z]:[\\/]/.test(raw)) return "caminho relativo à unidade";
    const rootDrive = /^([A-Za-z]):/.exec(worktreeRoot)?.[1];
    if (!rootDrive || rootDrive.toLowerCase() !== (drive[1] as string).toLowerCase()) return "outra unidade";
    rest = raw.slice(2);
  }
  if (rest.includes(":")) return "fluxo NTFS (:)";
  if (/[<>"|?*\x00-\x1f]/.test(rest)) return "caractere inválido no Windows";
  let shortName = false;
  for (const c of rest.split(/[\\/]+/).filter((x) => x !== "")) {
    if (c === ".") continue;
    if (c === "..") return "componente ..";
    if (/[. ]$/.test(c)) return "ponto ou espaço no fim do nome";
    if (WIN_DEVICE.test((c.split(".")[0] as string).trimEnd())) return "nome de dispositivo";
    if (/~\d/.test(c)) shortName = true;
  }
  return shortName ? "short-name" : null;
}

/** Caminho relativo (com "/") quando abs começa por root componente a componente com a grafia exata (a letra da
 * unidade não diferencia caixa); senão null. Substitui path.relative no Windows, que ignora a caixa. */
export function insideExact(root: string, abs: string): string | null {
  const split = (p: string) => p.split(/[\\/]+/).filter((x) => x !== "");
  const r = split(root);
  const a = split(abs);
  if (a.length < r.length) return null;
  for (let i = 0; i < r.length; i++) {
    const x = r[i] as string;
    const y = a[i] as string;
    const same = i === 0 && /^[A-Za-z]:$/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
    if (!same) return null;
  }
  const rest = a.slice(r.length);
  return rest.length ? rest.join("/") : ".";
}

/** Prefixos (até cada componente com forma de nome curto) que precisam existir para o nome curto valer. */
function shortNamePrefixes(abs: string): string[] {
  const parts = abs.split(/[\\/]+/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) if (/~\d/.test(parts[i] as string)) out.push(parts.slice(0, i + 1).join("\\"));
  return out;
}

/** Contagem de links; 0 só para caminho inexistente. Qualquer outra falha propaga e o gate nega (sem prova de 1 link). */
const defaultNlink = (abs: string): number => {
  try { return statSync(abs).nlink; }
  catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code === "ENOENT" || code === "ENOTDIR") return 0; throw e; }
};

export type GateOptions = { platform?: NodeJS.Platform; nlink?: (abs: string) => number; exists?: (abs: string) => boolean };

function relInside(root: string, abs: string): string | null {
  const r = relative(root, abs);
  if (r === "") return ".";
  // Fora só com um componente ".." de verdade: "..cache" é uma pasta válida dentro da worktree.
  if (isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`)) return null;
  return r.split(sep).join("/");
}

/** Identidade do arquivo/pasta no sistema de arquivos; null se não existe. */
export function decideToolCall(input: unknown, allow: GateAllowlist, canon: (p: string) => string = canonicalPath, opts: GateOptions = {}): GateDecision {
  const win = (opts.platform ?? process.platform) === "win32";
  const nlink = opts.nlink ?? defaultNlink;
  const exists = opts.exists ?? existsSync;
  const deny = (reason: string): GateDecision => ({ decision: "deny", reason: `duo-gate: ${reason}` });
  try {
    const call = (input as { toolCall?: { name?: unknown; args?: unknown } } | null)?.toolCall;
    const name = call?.name;
    if (typeof name !== "string") return deny("entrada sem toolCall.name");
    if (DONE_TOOLS.has(name)) return { decision: "allow", reason: "duo-gate: entrega do resultado" };
    if (win) {
      for (const raw of rawPathArgs(call?.args)) {
        const problem = win32PathProblem(raw, allow.worktreeRoot);
        if (problem === "short-name") {
          const abs = win32.isAbsolute(raw) ? raw : `${allow.worktreeRoot}\\${raw}`;
          if (!shortNamePrefixes(abs).every((p) => exists(p))) return deny(`nome curto 8.3 inexistente: ${raw}`);
        } else if (problem) return deny(`${problem}: ${raw}`);
      }
    }
    const paths = pathArgs(call?.args, allow.worktreeRoot, win).map((p) => canon(p));
    const inside = (p: string) => (win ? insideExact(allow.worktreeRoot, p) : relInside(allow.worktreeRoot, p));
    // Hard link: no Windows, sem trava do sistema, outro nome do mesmo arquivo pode estar fora do alvo ou negado.
    const linked = (p: string) => win && nlink(p) > 1;
    // Raiz fixada na preparação (canônica, gravada na allowlist): trocar a pasta por um link no meio da execução
    // não move a fronteira de leitura.
    const root = allow.worktreeRoot;
    if (READ_TOOLS.has(name)) {
      if (!paths.length) return deny(`${name} sem caminho`);
      for (const p of paths) {
        const rel = inside(p);
        if (rel === null) return deny(`leitura fora da worktree: ${p}`);
        if (linked(p)) return deny(`arquivo com mais de um link (hard link): ${rel}`);
        const denied = rel !== "." && isDenied(rel, allow.deny);
        if (denied) return deny(`leitura negada (${denied}): ${rel}`);
        if (FILE_ONLY.has(name)) {
          let isFile = false;
          try { isFile = statSync(p).isFile(); } catch { isFile = false; }
          if (!isFile) return deny(`${name} só em arquivo, não em pasta (${rel}); use find_by_name e read_file`);
        }
      }
      // list_dir/find_by_name mostram nomes (não conteúdo) de arquivos negados dentro da pasta; limitação documentada.
      return { decision: "allow", reason: "duo-gate: leitura na worktree" };
    }
    if (!WRITE_TOOLS.has(name)) return deny(`ferramenta não permitida: ${name}`);
    if (allow.readOnly) return deny("tarefa só leitura");
    if (!paths.length) return deny(`${name} sem caminho`);
    for (const p of paths) {
      const rel = inside(p);
      if (rel === null || rel === ".") return deny(`escrita fora da worktree: ${p}`);
      if (linked(p)) return deny(`arquivo com mais de um link (hard link): ${rel}`);
      if (isProtectedRel(rel)) return deny(`caminho protegido: ${rel}`);
      const denied = isDenied(rel, allow.deny);
      if (denied) return deny(`caminho negado (${denied}): ${rel}`);
      const exact = allow.write.some((t) => rel === t.rel);
      const grants = allow.write.filter((t) => t.isDir && rel.startsWith(`${t.rel}/`));
      if (!exact && !grants.length) return deny(`fora dos alvos autorizados: ${rel}`);
      // Abaixo de uma pasta liberada só nomes ASCII (mesma regra do perfil do SO, que olha só o trecho abaixo da pasta);
      // a própria pasta pode ter acento, e alvos de arquivo listados também.
      if (!exact && !grants.some((t) => !/[^\x20-\x7e]/.test(rel.slice(t.rel.length + 1)))) {
        return deny(`nome fora do ASCII numa pasta liberada (liste o arquivo como alvo): ${rel}`);
      }
    }
    return { decision: "allow", reason: "duo-gate: alvo autorizado" };
  } catch (e) {
    return deny(`erro: ${(e as Error).message}`);
  }
}

/** Resolve os alvos de escrita na worktree; recusa alvo que escapa dela (inclusive por links como node_modules). */
export function resolveGeminiTargets(
  worktreeRoot: string,
  writable: { rel: string; isDir: boolean }[],
  links: string[],
): { ok: true; targets: GeminiTarget[] } | { ok: false; reason: string } {
  let root: string;
  // A raiz tem de existir como diretório (só os alvos abaixo dela podem ser novos).
  try { root = realpathSync.native(worktreeRoot); if (!statSync(root).isDirectory()) throw Object.assign(new Error("não é diretório"), { code: "ENOTDIR" }); }
  catch (e) { return { ok: false, reason: `worktree ausente ou ilegível (${(e as NodeJS.ErrnoException).code ?? "erro"})` }; }
  const targets: GeminiTarget[] = [];
  for (const w of writable) {
    const rel = normalizeRel(w.rel);
    if (rel === null || rel === "" || rel === ".") return { ok: false, reason: `alvo inválido: ${w.rel}` };
    if (links.some((l) => rel === l || rel.startsWith(`${l}/`))) return { ok: false, reason: `alvo dentro de pasta ligada ao projeto (${rel})` };
    if (isProtectedRel(rel)) return { ok: false, reason: `alvo em pasta protegida (.agents, .git, .duo): ${rel}` };
    // Nenhum componente existente do alvo pode ser link (redirecionamento, mesmo para dentro da worktree).
    let walk = root;
    for (const seg of rel.split("/")) {
      walk = join(walk, seg);
      let link = false;
      try { link = lstatSync(walk).isSymbolicLink(); } catch { break; }
      if (link) return { ok: false, reason: `alvo passa por link: ${rel}` };
    }
    let abs: string;
    try { abs = canonicalPath(join(root, rel)); }
    catch (e) { return { ok: false, reason: `alvo inválido (${(e as NodeJS.ErrnoException).code ?? "erro"}): ${rel}` }; }
    const realRel = relInside(root, abs);
    if (realRel === null) return { ok: false, reason: `alvo fora da worktree após realpath: ${rel}` };
    // Grafia diferente da do disco (APFS ignora caixa e forma Unicode): recusa com a grafia real, para que escopo,
    // base e verificação do patch usem o mesmo nome que o git registra.
    if (realRel !== rel) return { ok: false, reason: `alvo com grafia diferente da do disco: use "${realRel}" em vez de "${rel}"` };
    const missingAncestors: string[] = [];
    for (let d = dirname(join(root, rel)); d !== root && !existsSync(d); d = dirname(d)) missingAncestors.unshift(d);
    // Link quebrado como ancestral "inexistente": existsSync diz que não existe, lstat mostra o link.
    for (const d of missingAncestors) {
      let link = false;
      try { link = lstatSync(d).isSymbolicLink(); } catch { link = false; }
      if (link) return { ok: false, reason: `ancestral é link: ${d}` };
    }
    targets.push({ rel, abs, isDir: w.isDir, missingAncestors });
  }
  return { ok: true, targets };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Linha do hook no Windows, rodada pelo cmd.exe. Começa sem aspas (um primeiro token entre aspas seguido de mais
 * aspas é desmontado pelo `cmd /c`, e o jeito como o agy repassa a linha não é conhecido): `set "PATH=<pasta do node
 * do duo>" && node "<script>" ...`. Assim o `node` só pode vir da pasta do runtime que roda o duo — nem do PATH do
 * dono (que pode ter entradas relativas) nem da worktree (o ambiente do agy também leva
 * `NoDefaultCurrentDirectoryInExePath=1`). Caracteres que o cmd ou o PowerShell interpretariam são recusados.
 */
export function win32HookCommand(nodePath: string, args: string[]): string {
  if (!win32.isAbsolute(nodePath) || !/^[A-Za-z]:\\/.test(nodePath)) throw new Error(`node do hook precisa de caminho absoluto: ${JSON.stringify(nodePath)}`);
  // `;` separa entradas do PATH: na pasta do node faria o cmd procurar em mais de uma pasta.
  if (win32.dirname(nodePath).includes(";")) throw new Error("caractere não suportado na pasta do node do hook: \";\"");
  for (const p of [nodePath, ...args]) {
    const bad = /[%^&"!`$'\x00-\x1f]/.exec(p);
    if (bad) throw new Error(`caractere não suportado na linha do hook: ${JSON.stringify(bad[0])}`);
  }
  // NODE_OPTIONS herdado (um --require relativo, por exemplo) rodaria código da worktree antes do gate: zerado.
  return [`set "NODE_OPTIONS="`, "&&", `set "PATH=${win32.dirname(nodePath)}"`, "&&", "node", ...args.map((p) => `"${p}"`)].join(" ");
}

export function gateHookScriptPath(): string {
  return join(packageRoot(), "dist", "src", "adapters", "gemini-gate-hook.js");
}

/** Troca o `.agents/` da worktree pelo do duo e grava a allowlist/log no HOME privado (fora da worktree e do .duo). */
export function writeGateFiles(
  worktreeRoot: string,
  privateHome: string,
  allow: GateAllowlist,
  opts: { nodePath: string; hookScript?: string; timeoutSec?: number; platform?: NodeJS.Platform },
): { hooksPath: string; allowlistPath: string; logPath: string } {
  const win = (opts.platform ?? process.platform) === "win32";
  const timeoutSec = opts.timeoutSec ?? 10;
  const gateDir = join(privateHome, "duo-gate");
  mkdirSync(gateDir, { recursive: true, mode: 0o700 });
  const allowlistPath = join(gateDir, "allowlist.json");
  // Log próprio de cada preparação: retomada ou retentativa nunca confirmam o modelo com evidência de outra tentativa.
  const logPath = join(gateDir, `gate-log-${Date.now()}-${randomBytes(4).toString("hex")}.jsonl`);
  writeFileSync(logPath, "", { mode: 0o600 });
  const script = opts.hookScript ?? gateHookScriptPath();
  // macOS: variáveis de ambiente no shell POSIX (como sempre). Windows: arquivos por argumento, sem prefixo de ambiente.
  // Montada antes de mexer no .agents/: um caminho recusado não deixa a worktree sem hook.
  const command = win
    ? win32HookCommand(opts.nodePath, [script, allowlistPath, logPath, String(timeoutSec)])
    : `NODE_OPTIONS= DUO_GATE_ALLOWLIST=${shq(allowlistPath)} DUO_GATE_LOG=${shq(logPath)} DUO_GATE_TIMEOUT=${timeoutSec} ${shq(opts.nodePath)} ${shq(script)}`;
  const agents = join(worktreeRoot, ".agents");
  rmSync(agents, { recursive: true, force: true });
  mkdirSync(agents, { recursive: true });
  const hooks = { "duo-gate": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: timeoutSec }] }] } };
  const hooksPath = join(agents, "hooks.json");
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  // Raiz canônica fixada aqui: o gate compara cada caminho resolvido contra este valor, sem recalcular a raiz.
  const persisted: PersistedGateAllowlist = { ...allow, worktreeRoot: realpathSync.native(worktreeRoot), nonce: randomBytes(16).toString("hex"), hookTimeoutSec: timeoutSec };
  writeFileSync(allowlistPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  return { hooksPath, allowlistPath, logPath };
}
