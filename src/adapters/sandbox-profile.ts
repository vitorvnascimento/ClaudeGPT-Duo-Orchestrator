// Trava do sistema operacional do executor Gemini (macOS sandbox-exec). Política do spec §5 (emenda A):
// escrita só nos alvos autorizados, no HOME privado, no TMPDIR da tentativa e em /dev/{null,tty,fd}.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GeminiTarget } from "./gemini-gate.js";
import { canonicalPath } from "./gemini-gate.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PROTECTED = [".agents", ".git", ".duo"];
// shortcut: caminhos com caracteres de controle são recusados em vez de escapados; nenhum projeto real os usa.
const CONTROL = /[\u0000-\u001f\u007f]/;

export function sbplQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const reEscape = (s: string) => s.replace(/[.^$|?*+()[\]{}\\/]/g, "\\$&");
const ci = (s: string) => s.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/** Glob do scope.deny → regex SBPL ancorada no root (sem flag i: letras viram classes [aA]). */
export function globToSbplRegex(root: string, glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += ci(reEscape(c));
  }
  return `^${reEscape(root)}/${re}$`;
}

export type ProfileInput = { worktreeRoot: string; targets: GeminiTarget[]; denyGlobs: string[]; privateHome: string; tmpDir: string };

export function buildProfile(p: ProfileInput): { ok: true; profile: string } | { ok: false; reason: string } {
  const all = [p.worktreeRoot, p.privateHome, p.tmpDir, ...p.targets.map((t) => t.abs), ...p.denyGlobs];
  const bad = all.find((s) => CONTROL.test(s));
  if (bad !== undefined) return { ok: false, reason: `caminho com caractere de controle não é aceito no perfil: ${JSON.stringify(bad)}` };
  const root = canonicalPath(p.worktreeRoot);
  const allows = [
    ...p.targets.map((t) => `(${t.isDir ? "subpath" : "literal"} ${sbplQuote(canonicalPath(t.abs))})`),
    `(subpath ${sbplQuote(canonicalPath(p.privateHome))})`,
    `(subpath ${sbplQuote(canonicalPath(p.tmpDir))})`,
    '(literal "/dev/null")', '(literal "/dev/tty")', '(regex #"^/dev/fd/")',
  ];
  const denies: string[] = [];
  if (p.targets.some((t) => t.isDir)) {
    for (const d of PROTECTED) denies.push(`(subpath ${sbplQuote(join(root, d))})`);
    for (const g of p.denyGlobs) {
      denies.push(`(regex ${sbplQuote(globToSbplRegex(root, g))})`);
      if (g.endsWith("/**")) denies.push(`(regex ${sbplQuote(globToSbplRegex(root, g.slice(0, -3)))})`);
    }
  }
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${allows.join(" ")})`,
    ...(denies.length ? [`(deny file-write* ${denies.join(" ")})`] : []),
    // Hard link num caminho liberado gravaria no arquivo de fora; Apple Events e LaunchServices abririam
    // processos fora do sandbox. Nada disso é usado pelo agy (verificado com a sonda real).
    "(deny file-link)",
    "(deny appleevent-send)",
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name-regex #"^com\\.apple\\.ae\\."))',
    "",
  ].join("\n");
  return { ok: true, profile };
}

/** Sonda local e determinística (sem agy, sem rede): grava o alvo, falha no vizinho e em ../. */
export function probeSandbox(opts: { sandboxExec?: string } = {}): { ok: true } | { ok: false; reason: string } {
  const exe = opts.sandboxExec ?? SANDBOX_EXEC;
  if (process.platform !== "darwin") return { ok: false, reason: "sandbox-exec só existe no macOS" };
  if (!existsSync(exe)) return { ok: false, reason: `${exe} não encontrado` };
  const base = canonicalPath(mkdtempSync(join(tmpdir(), "duo-sbx-probe-")));
  try {
    const wt = join(base, "wt");
    mkdirSync(wt);
    const r = buildProfile({ worktreeRoot: wt, targets: [{ rel: "ok.txt", abs: join(wt, "ok.txt"), isDir: false, missingAncestors: [] }], denyGlobs: [], privateHome: join(base, "home"), tmpDir: join(base, "home", "tmp") });
    if (!r.ok) return r;
    const profilePath = join(base, "probe.sb");
    writeFileSync(profilePath, r.profile);
    const run = spawnSync(exe, ["-f", profilePath, "/bin/sh", "-c", "echo 1 > ok.txt; echo 2 > other.txt; echo 3 > ../outside.txt; exit 0"], { cwd: wt, encoding: "utf8", timeout: 10_000 });
    if (run.error) return { ok: false, reason: `sandbox-exec falhou: ${run.error.message}` };
    if (!existsSync(join(wt, "ok.txt"))) return { ok: false, reason: "a sonda não conseguiu gravar o alvo autorizado" };
    if (existsSync(join(wt, "other.txt")) || existsSync(join(base, "outside.txt"))) return { ok: false, reason: "a sonda gravou fora do alvo: o sandbox não está contendo escrita" };
    return { ok: true };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
