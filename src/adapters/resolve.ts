import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, sep } from "node:path";

export type Resolved =
  | { ok: true; command: string; prefixArgs: string[]; source: "path" | "config" }
  | { ok: false; reason: string };

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shim .cmd gerado pelo npm (cmd-shim): o alvo é `"%dp0%\node_modules\...\bin\x.js|x.exe"`. Executa o alvo direto,
 * sem shell. Só aceita alvo dentro de <pasta do shim>\node_modules, existente, .js/.cjs/.mjs (via este node) ou .exe.
 */
function npmShimTarget(shim: string, dir: string): Resolved | null {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const rels = [...text.matchAll(/"%dp0%\\(node_modules\\[^"%]+)"/gi)].map((m) => m[1] as string);
  if (rels.length !== 1) return null;
  const parts = (rels[0] as string).split("\\");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  const target = join(dir, ...parts);
  if (!target.startsWith(join(dir, "node_modules") + sep) || !isExecutableFile(target)) return null;
  const ext = extname(target).toLowerCase();
  if (ext === ".exe") return { ok: true, command: target, prefixArgs: [], source: "path" };
  if ([".js", ".cjs", ".mjs"].includes(ext)) return { ok: true, command: process.execPath, prefixArgs: [target], source: "path" };
  return null;
}

/**
 * Resolve a CLI oficial sem shell. No Windows, shims .cmd/.bat exigiriam `shell: true`
 * (e interpolação de argumentos); o shim do npm é lido e o alvo executado direto. Outros shims pedem
 * o caminho do .exe ou [node, script.js].
 */
export function resolveExecutable(name: string, configured?: string[] | null, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Resolved {
  if (configured && configured.length > 0) {
    const [cmd, ...rest] = configured as [string, ...string[]];
    if (!isAbsolute(cmd) && cmd !== "node") {
      return { ok: false, reason: `executors.*.command deve usar caminho absoluto (recebido "${cmd}")` };
    }
    const command = cmd === "node" ? process.execPath : cmd;
    if (!isExecutableFile(command)) return { ok: false, reason: `comando configurado não encontrado ou não executável: ${command}` };
    return { ok: true, command, prefixArgs: rest, source: "config" };
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  if (platform === "win32") {
    const exts = [".exe", ".com"];
    let shim: string | undefined;
    let shimDir = "";
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = join(dir, name + ext);
        if (isExecutableFile(p)) return { ok: true, command: p, prefixArgs: [], source: "path" };
      }
      for (const ext of [".cmd", ".bat"]) {
        const p = join(dir, name + ext);
        if (!shim && isExecutableFile(p)) {
          shim = p;
          shimDir = dir;
        }
      }
    }
    if (shim) {
      const target = extname(shim).toLowerCase() === ".cmd" ? npmShimTarget(shim, shimDir) : null;
      if (target) return target;
      return {
        ok: false,
        reason: `encontrado apenas o shim ${shim} (${extname(shim)}). Ele exigiria shell; configure executors.${name}.command com o .exe oficial ou ["node", "<script.js>"].`,
      };
    }
    return { ok: false, reason: `${name} não encontrado no PATH` };
  }
  for (const dir of dirs) {
    const p = join(dir, name);
    if (isExecutableFile(p)) return { ok: true, command: p, prefixArgs: [], source: "path" };
  }
  return { ok: false, reason: `${name} não encontrado no PATH` };
}
