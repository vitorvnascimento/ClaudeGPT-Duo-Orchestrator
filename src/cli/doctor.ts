// Diagnóstico sem inferência: apenas --version, --help, os comandos oficiais de status e a geração local do schema do app-server.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_FLAGS, CODEX_EXEC_FLAGS, probe } from "../adapters/capabilities.js";
import { runQuick } from "../adapters/process.js";
import { resolveExecutable } from "../adapters/resolve.js";
import { ConfigError, configPath, DEFAULT_CONFIG, loadConfig, type DuoConfig, type Provider } from "../config.js";
import { git, repoRoot } from "../git.js";
import { cachedCatalog, checkCodexCatalogContract, describeSource } from "../adapters/catalog.js";
import { Store } from "../state/store.js";
import { authBlockReason, BILLING_ENV, checkAuth, childEnv, defaultAuthPaths, type AuthPaths } from "../permissions/auth.js";

export type DoctorReport = Record<string, unknown> & { ready: Record<Provider, boolean> };

function hookEvents(file: string): string[] {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, unknown> };
    return Object.keys(s.hooks ?? {});
  } catch {
    return [];
  }
}

function mcpServers(file: string): string[] {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
    return Object.keys(s.mcpServers ?? {});
  } catch {
    return [];
  }
}

function orchestratorEvidence(projectRoot: string | null, env: NodeJS.ProcessEnv, home: string): string[] {
  const found: string[] = [];
  for (const bin of ["ruflo", "claude-flow", "omx", "oh-my-codex", "omniroute", "capability-router"]) {
    const r = resolveExecutable(bin, null, env);
    if (r.ok) found.push(`executável no PATH: ${r.command}`);
  }
  if (projectRoot) {
    for (const d of [".claude-flow", ".swarm", ".ruflo", ".omx", ".hive-mind"]) {
      if (existsSync(join(projectRoot, d))) found.push(`diretório de coordenador no projeto: ${d}/`);
    }
  }
  for (const d of ["ruflo", "capability-router", "oh-my-codex", "omniroute"]) {
    if (existsSync(join(home, ".claude", "skills", d))) found.push(`skill do Claude instalada: ~/.claude/skills/${d} (instalada não significa ativa)`);
    if (existsSync(join(home, ".codex", "skills", d))) found.push(`skill do Codex instalada: ~/.codex/skills/${d}`);
  }
  return found;
}

function extensionBinaries(home: string): string[] {
  const dir = join(home, ".vscode", "extensions");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ext of readdirSync(dir)) {
    if (/^openai\.chatgpt-/.test(ext) || /^anthropic\.claude-code-/.test(ext)) out.push(ext);
  }
  return out;
}

export function doctor(cwd: string, env: NodeJS.ProcessEnv = process.env, authPathsOverride?: AuthPaths): DoctorReport {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const root = repoRoot(cwd);
  const projectRoot = root ?? cwd;
  let cfg: DuoConfig | null = null;
  let configError: string | null = null;
  try {
    cfg = loadConfig(projectRoot);
  } catch (e) {
    configError = (e as ConfigError).message;
  }
  const effectiveCfg = cfg ?? structuredClone(DEFAULT_CONFIG);
  const authPaths = authPathsOverride ?? defaultAuthPaths(projectRoot, env);
  const gitVersion = runQuick("git", ["--version"]);
  const ignored = root ? git(root, ["check-ignore", "-q", ".duo/x"]).ok : false;

  const providers: Record<string, unknown> = {};
  const ready: Record<Provider, boolean> = { claude: false, codex: false };
  const { env: probeEnv } = childEnv(env);
  for (const p of ["claude", "codex"] as Provider[]) {
    const resolved = resolveExecutable(p, effectiveCfg.executors[p].command, env);
    if (!resolved.ok) {
      providers[p] = { installed: false, reason: resolved.reason, blockers: [resolved.reason] };
      continue;
    }
    const caps = p === "claude" ? probe(resolved, ["--help"], CLAUDE_FLAGS, probeEnv) : probe(resolved, ["exec", "--help"], CODEX_EXEC_FLAGS, probeEnv);
    const auth = checkAuth(p, resolved, effectiveCfg, authPaths, env);
    const blockers: string[] = [];
    if (caps.missingRequired.length) blockers.push(`recursos obrigatórios ausentes: ${caps.missingRequired.join(", ")}`);
    const authReason = authBlockReason(auth);
    if (authReason) blockers.push(authReason);
    ready[p] = blockers.length === 0;
    providers[p] = {
      installed: true,
      path: resolved.command,
      source: resolved.source,
      version: caps.version,
      capabilities: caps.flags,
      missingRequired: caps.missingRequired,
      versionDivergences: caps.divergences,
      auth: {
        method: auth.method,
        detail: auth.detail,
        ...(auth.subscriptionType ? { subscriptionType: auth.subscriptionType } : {}),
        conflicts: auth.conflicts,
        warnings: auth.warnings,
        removedFromChildEnv: auth.removedEnv,
        extraUsage: auth.extraUsage,
      },
      // Contrato da fonte estável do catálogo (schema gerado localmente; sem rede nem inferência).
      ...(p === "codex" ? { catalogContract: checkCodexCatalogContract(resolved.command, resolved.prefixArgs, probeEnv) } : {}),
      blockers,
    };
  }

  const claudeUserSettings = join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "settings.json");
  const audit = {
    claudeUserHooks: hookEvents(claudeUserSettings),
    claudeProjectHooks: root ? hookEvents(join(root, ".claude", "settings.json")) : [],
    projectMcpServers: root ? mcpServers(join(root, ".mcp.json")) : [],
    codexProjectConfig: root ? existsSync(join(root, ".codex", "config.toml")) : false,
    agentsMd: root ? existsSync(join(root, "AGENTS.md")) : false,
    claudeMd: root ? existsSync(join(root, "CLAUDE.md")) : false,
    note:
      "Com a configuração padrão, o executor Claude roda com --setting-sources user e --strict-mcp-config: hooks/settings do projeto e .mcp.json não são carregados. Hooks do usuário (~/.claude/settings.json) continuam rodando. CLAUDE.md/AGENTS.md do projeto são lidos pelas CLIs.",
  };

  const warnings: string[] = [];
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1" || env.CODEX_SANDBOX) {
    warnings.push("processo rodando dentro do sandbox do Codex: `duo delegate` precisará de aprovação para executar fora do sandbox (rede e login do executor).");
  }
  if (root && !ignored) warnings.push(".duo/ não está no .gitignore do projeto (duo init propõe a linha)");
  const billingEnvPresent = BILLING_ENV.filter((k) => env[k] !== undefined);
  if (billingEnvPresent.length) warnings.push(`variáveis de API/gateway presentes no ambiente (removidas dos executores): ${billingEnvPresent.join(", ")}`);

  const cat = cachedCatalog(new Store(projectRoot));
  const catalogSummary = cat ? Object.fromEntries(Object.entries(cat.providers).map(([p, pc]) => [p, describeSource(pc)])) : null;
  return {
    generatedAt: new Date().toISOString(),
    catalog: catalogSummary ? { discoveredAt: cat?.discoveredAt, ...catalogSummary } : "sem cache: rode duo models",
    system: { platform: process.platform, arch: process.arch, node: process.version, git: gitVersion.stdout.trim() || "não encontrado" },
    project: { root: root ?? null, isGitRepo: root !== null, config: configError ?? (existsSync(configPath(projectRoot)) ? "ok" : "padrão (sem .duo/config.json)"), duoIgnored: ignored },
    providers,
    directions: {
      "claude→codex (Claude cérebro, Codex executor)": ready.codex ? "pronto" : "bloqueado (ver providers.codex.blockers)",
      "codex→claude (Codex cérebro, Claude executor)": ready.claude ? "pronto" : "bloqueado (ver providers.claude.blockers)",
    },
    audit,
    otherOrchestrators: orchestratorEvidence(root, env, home),
    vscodeExtensions: {
      found: extensionBinaries(home),
      note: "Binários embutidos em extensões não são usados como contrato de integração; a ponte exige as CLIs oficiais no PATH ou em executors.*.command.",
    },
    warnings,
    ready,
  };
}

export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = [];
  const sys = r.system as Record<string, string>;
  lines.push(`duo doctor — ${sys.platform}/${sys.arch} node ${sys.node} | ${sys.git}`);
  const proj = r.project as Record<string, unknown>;
  lines.push(`projeto: ${String(proj.root ?? "(fora de repositório Git)")} | config: ${String(proj.config)}`);
  for (const [p, info] of Object.entries(r.providers as Record<string, Record<string, unknown>>)) {
    lines.push(`\n[${p}]`);
    if (!info.installed) {
      lines.push(`  não disponível: ${String(info.reason)}`);
      continue;
    }
    const auth = info.auth as Record<string, unknown>;
    lines.push(`  ${String(info.path)} (${String(info.source)}) versão ${String(info.version ?? "?")}`);
    lines.push(`  auth: ${String(auth.method)} — ${String(auth.detail)}${auth.subscriptionType ? ` — plano ${String(auth.subscriptionType)}` : ""}`);
    lines.push(`  uso extra/créditos: ${auth.extraUsage === "unverifiable-acknowledged" ? "não verificável (ciência registrada)" : "não verificável (ciência pendente)"}`);
    for (const c of auth.conflicts as string[]) lines.push(`  conflito: ${c}`);
    for (const w of auth.warnings as string[]) lines.push(`  aviso: ${w}`);
    for (const d of info.versionDivergences as string[]) lines.push(`  divergência versão/recursos: ${d}`);
    const contract = info.catalogContract as { ok: boolean; problems: string[] } | undefined;
    if (contract) {
      lines.push(
        contract.ok
          ? "  contrato do catálogo (app-server model/list, superfície estável): ok"
          : `  aviso: contrato do catálogo mudou (${contract.problems.join("; ")}); a descoberta usará o fallback (debug models / cache)`,
      );
    }
    const blockers = info.blockers as string[];
    lines.push(blockers.length ? `  BLOQUEADO: ${blockers.join(" | ")}` : "  pronto como executor");
  }
  lines.push("");
  const cat = r.catalog as Record<string, string> | string;
  if (typeof cat === "string") lines.push(`catálogo de modelos: ${cat}`);
  else {
    lines.push(`catálogo de modelos (${cat.discoveredAt}):`);
    lines.push(`  claude: ${cat.claude}`);
    lines.push(`  codex: ${cat.codex}`);
  }
  for (const [d, s] of Object.entries(r.directions as Record<string, string>)) lines.push(`${d}: ${s}`);
  const others = r.otherOrchestrators as string[];
  if (others.length) {
    lines.push("\nOutros coordenadores/roteadores (evidência local):");
    for (const o of others) lines.push(`  - ${o}`);
    lines.push("  Mantenha uma única autoridade de orquestração: não use o duo em conjunto com outro coordenador autônomo na mesma sessão.");
  }
  for (const w of r.warnings as string[]) lines.push(`aviso: ${w}`);
  return lines.join("\n");
}
