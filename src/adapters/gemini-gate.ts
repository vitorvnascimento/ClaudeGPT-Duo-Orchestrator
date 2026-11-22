// Gate do executor Gemini: hook PreToolUse do agy (`.agents/hooks.json` na worktree descartável).
// Evidência e receita: docs/gemini-agy-facts.md e tests/fixtures/agy/probe/. O agy bloqueia a chamada quando o hook
// nega, quebra, devolve lixo ou estoura o tempo (verificado no 1.5.3), então o gate só precisa errar para "deny".
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { packageRoot } from "../paths.js";
import { isDenied, normalizeRel } from "../permissions/scope.js";

export type GeminiTarget = { rel: string; abs: string; isDir: boolean; missingAncestors: string[] };
export type GateAllowlist = { worktreeRoot: string; write: { rel: string; isDir: boolean }[]; deny: string[]; readOnly: boolean };
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

/** Caminho real: realpath do ancestral existente mais próximo + sufixo literal (alvos novos ainda não existem). */
export function canonicalPath(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

function pathArgs(args: unknown, worktreeRoot: string): string[] {
  if (!args || typeof args !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (!PATH_KEY.test(k)) continue;
    for (const s of Array.isArray(v) ? v : [v]) if (typeof s === "string" && s) out.push(isAbsolute(s) ? s : join(worktreeRoot, s));
  }
  return out;
}

function relInside(root: string, abs: string): string | null {
  const r = relative(root, abs);
  if (r === "") return ".";
  // Fora só com um componente ".." de verdade: "..cache" é uma pasta válida dentro da worktree.
  if (isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`)) return null;
  return r.split(sep).join("/");
}

/** Identidade do arquivo/pasta no sistema de arquivos; null se não existe. */
export function decideToolCall(input: unknown, allow: GateAllowlist, canon: (p: string) => string = canonicalPath): GateDecision {
  const deny = (reason: string): GateDecision => ({ decision: "deny", reason: `duo-gate: ${reason}` });
  try {
    const call = (input as { toolCall?: { name?: unknown; args?: unknown } } | null)?.toolCall;
    const name = call?.name;
    if (typeof name !== "string") return deny("entrada sem toolCall.name");
    if (DONE_TOOLS.has(name)) return { decision: "allow", reason: "duo-gate: entrega do resultado" };
    const paths = pathArgs(call?.args, allow.worktreeRoot).map((p) => canon(p));
    if (READ_TOOLS.has(name)) {
      if (!paths.length) return deny(`${name} sem caminho`);
      for (const p of paths) {
        const rel = relInside(allow.worktreeRoot, p);
        if (rel === null) return deny(`leitura fora da worktree: ${p}`);
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
      const rel = relInside(allow.worktreeRoot, p);
      if (rel === null || rel === ".") return deny(`escrita fora da worktree: ${p}`);
      if (isProtectedRel(rel)) return deny(`caminho protegido: ${rel}`);
      const denied = isDenied(rel, allow.deny);
      if (denied) return deny(`caminho negado (${denied}): ${rel}`);
      if (!allow.write.some((t) => rel === t.rel || (t.isDir && rel.startsWith(`${t.rel}/`)))) return deny(`fora dos alvos autorizados: ${rel}`);
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
  const root = realpathSync(worktreeRoot);
  const targets: GeminiTarget[] = [];
  for (const w of writable) {
    const rel = normalizeRel(w.rel);
    if (rel === null || rel === "" || rel === ".") return { ok: false, reason: `alvo inválido: ${w.rel}` };
    if (links.some((l) => rel === l || rel.startsWith(`${l}/`))) return { ok: false, reason: `alvo dentro de pasta ligada ao projeto (${rel})` };
    if (isProtectedRel(rel)) return { ok: false, reason: `alvo em pasta protegida (.agents, .git, .duo): ${rel}` };
    const abs = canonicalPath(join(root, rel));
    if (relInside(root, abs) !== rel) return { ok: false, reason: `alvo fora da worktree após realpath: ${rel}` };
    const missingAncestors: string[] = [];
    for (let d = dirname(join(root, rel)); d !== root && !existsSync(d); d = dirname(d)) missingAncestors.unshift(d);
    for (const d of missingAncestors) if (existsSync(d) && lstatSync(d).isSymbolicLink()) return { ok: false, reason: `ancestral é link: ${d}` };
    targets.push({ rel, abs, isDir: w.isDir, missingAncestors });
  }
  return { ok: true, targets };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function gateHookScriptPath(): string {
  return join(packageRoot(), "dist", "src", "adapters", "gemini-gate-hook.js");
}

/** Troca o `.agents/` da worktree pelo do duo e grava a allowlist/log no HOME privado (fora da worktree e do .duo). */
export function writeGateFiles(
  worktreeRoot: string,
  privateHome: string,
  allow: GateAllowlist,
  opts: { nodePath: string; hookScript?: string; timeoutSec?: number },
): { hooksPath: string; allowlistPath: string; logPath: string } {
  const gateDir = join(privateHome, "duo-gate");
  mkdirSync(gateDir, { recursive: true, mode: 0o700 });
  const allowlistPath = join(gateDir, "allowlist.json");
  // Log próprio de cada preparação: retomada ou retentativa nunca confirmam o modelo com evidência de outra tentativa.
  const logPath = join(gateDir, `gate-log-${Date.now()}-${randomBytes(4).toString("hex")}.jsonl`);
  writeFileSync(logPath, "", { mode: 0o600 });
  const agents = join(worktreeRoot, ".agents");
  rmSync(agents, { recursive: true, force: true });
  mkdirSync(agents, { recursive: true });
  const command = `DUO_GATE_ALLOWLIST=${shq(allowlistPath)} DUO_GATE_LOG=${shq(logPath)} ${shq(opts.nodePath)} ${shq(opts.hookScript ?? gateHookScriptPath())}`;
  const hooks = { "duo-gate": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: opts.timeoutSec ?? 10 }] }] } };
  const hooksPath = join(agents, "hooks.json");
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  writeFileSync(allowlistPath, `${JSON.stringify(allow)}\n`, { mode: 0o600 });
  return { hooksPath, allowlistPath, logPath };
}
