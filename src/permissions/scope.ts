// Escopo autorizado: caminhos relativos ao projeto, sem traversal, sem symlinks e fora da lista de negação.
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";

export type ScopeEntry = { rel: string; abs: string; isDir: boolean; exists: boolean };
export type ScopeResult = { ok: true; entries: ScopeEntry[] } | { ok: false; errors: string[] };

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export function isDenied(rel: string, deny: string[]): string | null {
  const parts = rel.split("/");
  for (const pattern of deny) {
    const re = globToRegExp(pattern);
    if (re.test(rel)) return pattern;
    const base = pattern.endsWith("/**") ? globToRegExp(pattern.slice(0, -3)) : null;
    if (base) {
      for (let i = 1; i <= parts.length; i++) {
        if (base.test(parts.slice(0, i).join("/"))) return pattern;
      }
    }
  }
  return null;
}

/** Normaliza para caminho relativo POSIX, ou null se escapar do projeto. */
export function normalizeRel(input: string): string | null {
  if (!input || input.includes("\0")) return null;
  if (isAbsolute(input) || /^[A-Za-z]:/.test(input) || input.startsWith("\\\\") || input.startsWith("~")) return null;
  const n = posix.normalize(input.replace(/\\/g, "/")).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (n === ".." || n.startsWith("../")) return null;
  return n === "" ? "." : n;
}

function isInside(root: string, target: string): boolean {
  const r = relative(root, target);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Verifica cada componente existente: nenhum pode ser symlink e o destino real precisa estar no projeto. */
function symlinkProblem(projectReal: string, rel: string): string | null {
  if (rel === ".") return null;
  let current = projectReal;
  for (const part of rel.split("/")) {
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return null; // componentes seguintes ainda não existem (arquivo novo)
    }
    if (st.isSymbolicLink()) {
      let target = "?";
      try {
        target = realpathSync(current);
      } catch {
        /* link quebrado */
      }
      return isInside(projectReal, target) ? `symlink em ${rel} (não permitido no escopo)` : `symlink em ${rel} aponta para fora do projeto`;
    }
  }
  return null;
}

export function validateScope(projectRoot: string, allowed: string[], deny: string[], opts: { allowWholeProject: boolean }): ScopeResult {
  const errors: string[] = [];
  const entries: ScopeEntry[] = [];
  let projectReal: string;
  try {
    projectReal = realpathSync(projectRoot);
  } catch {
    return { ok: false, errors: [`projeto inexistente: ${projectRoot}`] };
  }
  const seen = new Set<string>();
  for (const raw of allowed) {
    const rel = normalizeRel(raw);
    if (rel === null) {
      errors.push(`caminho fora do projeto ou inválido: ${JSON.stringify(raw)}`);
      continue;
    }
    if (rel === "." && !opts.allowWholeProject) {
      errors.push(`"." (projeto inteiro) só é aceito em tarefas de leitura; delimite os arquivos`);
      continue;
    }
    const denied = rel === "." ? null : isDenied(rel, deny);
    if (denied) {
      errors.push(`caminho protegido (${denied}): ${rel}`);
      continue;
    }
    const link = symlinkProblem(projectReal, rel);
    if (link) {
      errors.push(link);
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = rel === "." ? projectReal : join(projectReal, ...rel.split("/"));
    let isDir = false;
    let exists = false;
    try {
      const st = lstatSync(abs);
      exists = true;
      isDir = st.isDirectory();
    } catch {
      /* arquivo novo */
    }
    entries.push({ rel, abs, isDir, exists });
  }
  return errors.length ? { ok: false, errors } : { ok: true, entries };
}

export function inScope(rel: string, entries: ScopeEntry[]): boolean {
  return entries.some((e) => e.rel === "." || rel === e.rel || rel.startsWith(`${e.rel}/`));
}

/** Converte caminho absoluto em relativo POSIX ao projeto. */
export function toRel(projectReal: string, abs: string): string {
  return relative(projectReal, abs).split(sep).join("/");
}
