// Detecção de recursos a partir do --help da versão instalada.
// A versão declarada é só informativa: o que vale é o que o --help anuncia.
import { dirname } from "node:path";
import { runQuick, type LaunchTrace } from "./process.js";
import type { Resolved } from "./resolve.js";
import { childEnv } from "../permissions/auth.js";
import { launcherFor, withMetadataProfile } from "../state/gemini-state.js";

export type Capabilities = {
  version: string | null;
  /** Saída completa e aparada de --version (identidade exata para listas de versões verificadas). */
  rawVersion?: string | null;
  flags: Record<string, boolean>;
  missingRequired: string[];
  divergences: string[];
};

type FlagSpec = { flag: string; required: boolean; since?: string };

export const CLAUDE_FLAGS: Record<string, FlagSpec> = {
  print: { flag: "--print", required: true },
  outputFormat: { flag: "--output-format", required: true },
  verbose: { flag: "--verbose", required: true },
  jsonSchema: { flag: "--json-schema", required: true },
  tools: { flag: "--tools", required: true },
  disallowedTools: { flag: "--disallowedTools", required: true },
  allowedTools: { flag: "--allowedTools", required: true },
  permissionMode: { flag: "--permission-mode", required: true },
  model: { flag: "--model", required: false },
  effort: { flag: "--effort", required: false },
  resume: { flag: "--resume", required: false },
  settingSources: { flag: "--setting-sources", required: false },
  strictMcpConfig: { flag: "--strict-mcp-config", required: false },
  disableSlashCommands: { flag: "--disable-slash-commands", required: false },
  appendSystemPrompt: { flag: "--append-system-prompt", required: false },
  permissionPrompts: { flag: "--permission-prompts", required: false, since: "2.1.259" },
  bare: { flag: "--bare", required: false },
};

export const CODEX_EXEC_FLAGS: Record<string, FlagSpec> = {
  json: { flag: "--json", required: true },
  sandbox: { flag: "--sandbox", required: true },
  outputSchema: { flag: "--output-schema", required: true },
  outputLastMessage: { flag: "--output-last-message", required: false },
  cd: { flag: "--cd", required: true },
  model: { flag: "--model", required: false },
  config: { flag: "--config", required: false },
  enable: { flag: "--enable", required: false },
  disable: { flag: "--disable", required: false },
  ephemeral: { flag: "--ephemeral", required: false },
  ignoreUserConfig: { flag: "--ignore-user-config", required: false },
  skipGitRepoCheck: { flag: "--skip-git-repo-check", required: false },
};

/** agy (Antigravity CLI): o prompt vai por stdin em stream-json; sem isso o adaptador recusa a versão. */
export const AGY_FLAGS: Record<string, FlagSpec> = {
  print: { flag: "--print", required: true },
  inputFormat: { flag: "--input-format", required: true },
  outputFormat: { flag: "--output-format", required: true },
  model: { flag: "--model", required: true },
  settings: { flag: "--settings", required: true },
  conversation: { flag: "--conversation", required: false },
  jsonSchema: { flag: "--json-schema", required: false },
  disableSlashCommands: { flag: "--disable-slash-commands", required: false },
};

export function parseVersion(text: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(text);
  return m ? (m[1] as string) : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function capabilitiesFromHelp(help: string, version: string | null, specs: Record<string, FlagSpec>, rawVersion: string | null = version): Capabilities {
  const flags: Record<string, boolean> = {};
  const missingRequired: string[] = [];
  const divergences: string[] = [];
  for (const [key, spec] of Object.entries(specs)) {
    const re = new RegExp(`(^|[\\s,])${spec.flag.replace(/[-]/g, "\\-")}(?=[\\s,=<\\[]|$)`, "m");
    const present = re.test(help);
    flags[key] = present;
    if (!present && spec.required) missingRequired.push(spec.flag);
    if (spec.since && version) {
      const expected = compareVersions(version, spec.since) >= 0;
      if (expected && !present) divergences.push(`${spec.flag}: esperado desde ${spec.since}, ausente no --help da ${version}`);
      if (!expected && present) divergences.push(`${spec.flag}: presente no --help da ${version}, documentado a partir de ${spec.since}`);
    }
  }
  return { version, rawVersion, flags, missingRequired, divergences };
}

/** trace: só a sonda do agy (rastreio da bateria do Windows); rótulo-base e pastas privadas deste perfil de sondagem. */
export function probe(resolved: Resolved & { ok: true }, helpArgs: string[], specs: Record<string, FlagSpec>, env: NodeJS.ProcessEnv, cwd?: string, trace?: LaunchTrace): Capabilities & { error?: string } {
  const tr = (what: string) => (trace ? { trace: { ...trace, label: `${trace.label} ${what}` } } : {});
  const v = runQuick(resolved.command, [...resolved.prefixArgs, "--version"], { env, cwd, ...tr("--version") });
  const version = parseVersion(v.stdout + v.stderr);
  // Mesma regra da bateria: só a saída padrão de um --version bem-sucedido identifica a versão.
  const rawVersion = v.ok ? v.stdout.trim() || null : null;
  const h = runQuick(resolved.command, [...resolved.prefixArgs, ...helpArgs], { env, cwd, ...tr(helpArgs.join(" ")) });
  if (!h.ok && !h.stdout) {
    return { ...capabilitiesFromHelp("", version, specs, rawVersion), error: h.error ?? (h.stderr.slice(0, 300) || "falha ao ler --help") };
  }
  return capabilitiesFromHelp(h.stdout + "\n" + h.stderr, version, specs, rawVersion);
}

/** --version e --help do agy. No Windows rodam com perfil e pasta de trabalho privados e descartáveis (o agy acha
 * config pelo perfil e nas pastas acima da pasta de trabalho); nunca lança: falha vira `error`. */
/** profileError: recusa local do perfil de sondagem (mensagem do próprio duo, segura para mostrar); `error` pode
 * trazer stderr do agy e nunca vai cru para relatório. */
export function probeAgy(resolved: Resolved & { ok: true }, baseEnv: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, projectRoot: string = process.cwd()): Capabilities & { error?: string; profileError?: string } {
  // Mesmo lançador da delegação (script do projeto absoluto) nos dois sistemas.
  const launch = { ...resolved, ...launcherFor(resolved, projectRoot) };
  if (platform !== "win32") return probe(launch, ["--help"], AGY_FLAGS, childEnv(baseEnv).env);
  try { return withMetadataProfile(baseEnv, (e, cwd) => probe(launch, ["--help"], AGY_FLAGS, e, cwd, { label: "caps agy", allowedRoots: [dirname(cwd)] }), "win32"); }
  catch (e) { const msg = (e as Error).message; return { ...capabilitiesFromHelp("", null, AGY_FLAGS, null), error: msg, profileError: msg }; }
}
