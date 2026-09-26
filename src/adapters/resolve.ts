import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

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
 * Resolve a CLI oficial sem shell. No Windows, shims .cmd/.bat exigiriam `shell: true`
 * (e interpolação de argumentos); nesse caso pedimos o caminho do .exe ou [node, script.js].
 */
export function resolveExecutable(name: string, configured?: string[] | null, env: NodeJS.ProcessEnv = process.env): Resolved {
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
  if (process.platform === "win32") {
    const exts = [".exe", ".com"];
    let shim: string | undefined;
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = join(dir, name + ext);
        if (isExecutableFile(p)) return { ok: true, command: p, prefixArgs: [], source: "path" };
      }
      for (const ext of [".cmd", ".bat"]) {
        const p = join(dir, name + ext);
        if (!shim && isExecutableFile(p)) shim = p;
      }
    }
    if (shim) {
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
