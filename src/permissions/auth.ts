// Perfil subscription-only: a ponte nunca lê credenciais. Ela
// (1) remove do ambiente do filho variáveis que trocariam a assinatura por API/gateway/cloud,
// (2) detecta configurações persistentes que fariam o mesmo (sem ler valores secretos),
// (3) confirma o método efetivo pelo comando de status oficial, executado com o mesmo ambiente do filho.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DuoConfig, Provider } from "../config.js";
import { runQuick } from "../adapters/process.js";
import type { Resolved } from "../adapters/resolve.js";

/** Variáveis que selecionam API paga, gateway ou nuvem em vez da assinatura. Nunca repassadas aos executores. */
export const BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "AZURE_OPENAI_API_KEY",
];

/** Variáveis internas da sessão do cérebro (inclui tokens de mensageria); não pertencem ao executor. */
const BRAIN_SESSION_ENV = [
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_AGENT_SDK_VERSION$/,
  /^CLAUDE_CODE_(SESSION_ID|ENTRYPOINT|MESSAGING_[A-Z_]+|CHILD_SESSION|SESSION_ATTENDED|EXECPATH)$/,
  /^CODEX_(THREAD_ID|SESSION_ID)$/,
];

export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; removed: string[] } {
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (BILLING_ENV.includes(k) || BRAIN_SESSION_ENV.some((re) => re.test(k))) {
      removed.push(k);
      continue;
    }
    env[k] = v;
  }
  return { env: { ...env, ...extra }, removed: removed.sort() };
}

export type AuthMethod = "subscription" | "api_key" | "cloud" | "none" | "unknown";

export type AuthCheck = {
  provider: Provider;
  ok: boolean;
  method: AuthMethod;
  /** Descrição não sensível (sem e-mail, org ou trechos de chave). */
  detail: string;
  subscriptionType?: string;
  conflicts: string[];
  warnings: string[];
  removedEnv: string[];
  extraUsage: "unverifiable-acknowledged" | "unverifiable-not-acknowledged";
};

export type AuthPaths = {
  home: string;
  projectRoot: string;
  claudeManagedSettings: string[];
};

export function defaultAuthPaths(projectRoot: string, env: NodeJS.ProcessEnv = process.env): AuthPaths {
  const managed =
    process.platform === "darwin"
      ? ["/Library/Application Support/ClaudeCode/managed-settings.json"]
      : process.platform === "win32"
        ? [join(env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json")]
        : ["/etc/claude-code/managed-settings.json"];
  return { home: env.HOME ?? env.USERPROFILE ?? homedir(), projectRoot, claudeManagedSettings: managed };
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Inspeciona settings do Claude Code procurando apenas nomes de chaves que mudariam a cobrança. */
export function claudeSettingsConflicts(paths: AuthPaths, env: NodeJS.ProcessEnv): { conflicts: string[]; warnings: string[] } {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(paths.home, ".claude");
  const files = [
    join(configDir, "settings.json"),
    join(configDir, "settings.local.json"),
    join(paths.projectRoot, ".claude", "settings.json"),
    join(paths.projectRoot, ".claude", "settings.local.json"),
    ...paths.claudeManagedSettings,
  ];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const s = readJson(f);
    if (!s) {
      warnings.push(`${f}: não foi possível interpretar (JSON inválido); não verificado`);
      continue;
    }
    if ("apiKeyHelper" in s) conflicts.push(`${f}: define apiKeyHelper (credencial de API teria precedência sobre a assinatura)`);
    if (s.forceLoginMethod === "console") conflicts.push(`${f}: forceLoginMethod=console (login de API)`);
    const envBlock = s.env;
    if (typeof envBlock === "object" && envBlock !== null) {
      for (const k of Object.keys(envBlock)) {
        if (BILLING_ENV.includes(k)) conflicts.push(`${f}: bloco env define ${k}`);
      }
    }
  }
  return { conflicts, warnings };
}

/** Leitura mínima de TOML: só cabeçalhos de tabela e valores de chaves não secretas da lista abaixo. */
const CODEX_READABLE_KEYS = new Set(["model_provider", "preferred_auth_method", "forced_login_method", "network_access"]);

/** Modelo padrão do Codex (chave `model` de primeiro nível do config.toml; não é segredo). */
export function codexConfiguredModel(paths: AuthPaths, env: NodeJS.ProcessEnv): string | null {
  const f = join(env.CODEX_HOME ?? join(paths.home, ".codex"), "config.toml");
  if (!existsSync(f)) return null;
  for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) break; // só o nível raiz
    const m = /^model\s*=\s*["']([^"']+)["']/.exec(line);
    if (m) return m[1] as string;
  }
  return null;
}

export function codexConfigConflicts(paths: AuthPaths, env: NodeJS.ProcessEnv): { conflicts: string[]; warnings: string[] } {
  const codexHome = env.CODEX_HOME ?? join(paths.home, ".codex");
  const files = [join(codexHome, "config.toml"), join(paths.projectRoot, ".codex", "config.toml")];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    let table = "";
    for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) continue;
      const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
      if (header) {
        table = header[1] as string;
        if (/^model_providers\./.test(table)) warnings.push(`${f}: define provedor customizado [${table}] (verificar se não está ativo)`);
        continue;
      }
      const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1] as string;
      if (!CODEX_READABLE_KEYS.has(key)) continue;
      const value = (kv[2] as string).replace(/^["']|["']$/g, "");
      if (key === "model_provider" && table === "" && value !== "openai") {
        conflicts.push(`${f}: model_provider="${value}" (provedor diferente do padrão da assinatura)`);
      } else if (key === "model_provider" && /^profiles\./.test(table) && value !== "openai") {
        warnings.push(`${f}: perfil [${table}] usa model_provider="${value}"`);
      } else if (key === "preferred_auth_method" && value === "apikey") {
        conflicts.push(`${f}: preferred_auth_method=apikey`);
      } else if (key === "forced_login_method" && value === "api") {
        conflicts.push(`${f}: forced_login_method=api`);
      } else if (key === "network_access" && table === "sandbox_workspace_write" && value === "true") {
        warnings.push(`${f}: sandbox_workspace_write.network_access=true (a ponte força false no executor)`);
      }
    }
  }
  return { conflicts, warnings };
}

export function classifyClaudeStatus(stdout: string): { method: AuthMethod; detail: string; subscriptionType?: string } {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { method: "unknown", detail: "saída de `claude auth status` não é JSON reconhecível" };
  }
  if (s.loggedIn !== true) return { method: "none", detail: "não autenticado (loggedIn=false)" };
  const authMethod = String(s.authMethod ?? "");
  const apiProvider = String(s.apiProvider ?? "");
  const sub = typeof s.subscriptionType === "string" ? s.subscriptionType : undefined;
  if (apiProvider && apiProvider !== "firstParty") return { method: "cloud", detail: `apiProvider=${apiProvider}` };
  if (authMethod === "claude.ai") {
    return { method: "subscription", detail: `authMethod=claude.ai apiProvider=${apiProvider || "?"}`, ...(sub ? { subscriptionType: sub } : {}) };
  }
  if (/api.?key|console/i.test(authMethod)) return { method: "api_key", detail: `authMethod=${authMethod}` };
  return { method: "unknown", detail: `authMethod=${authMethod || "ausente"} não reconhecido como assinatura` };
}

export function classifyCodexStatus(output: string): { method: AuthMethod; detail: string } {
  if (/logged in using chatgpt/i.test(output)) return { method: "subscription", detail: "Logged in using ChatGPT" };
  if (/api key/i.test(output) && /logged in/i.test(output)) return { method: "api_key", detail: "Logged in using an API key" };
  if (/not logged in/i.test(output)) return { method: "none", detail: "Not logged in" };
  return { method: "unknown", detail: "saída de `codex login status` não reconhecida" };
}

export function checkAuth(
  provider: Provider,
  resolved: Resolved,
  cfg: DuoConfig,
  paths: AuthPaths,
  baseEnv: NodeJS.ProcessEnv = process.env,
): AuthCheck {
  const { env, removed } = childEnv(baseEnv);
  const extraUsage = cfg.billing.acknowledgeUnverifiableExtraUsage[provider] ? "unverifiable-acknowledged" : "unverifiable-not-acknowledged";
  const settings = provider === "claude" ? claudeSettingsConflicts(paths, baseEnv) : codexConfigConflicts(paths, baseEnv);
  const base = {
    provider,
    conflicts: settings.conflicts,
    warnings: settings.warnings,
    removedEnv: removed.filter((k) => BILLING_ENV.includes(k)),
    extraUsage,
  } as const;
  if (!resolved.ok) return { ...base, ok: false, method: "unknown", detail: resolved.reason };

  const args = provider === "claude" ? ["auth", "status"] : ["login", "status"];
  const r = runQuick(resolved.command, [...resolved.prefixArgs, ...args], { env, cwd: paths.projectRoot });
  const classified = provider === "claude" ? classifyClaudeStatus(r.stdout.trim()) : classifyCodexStatus(`${r.stdout}\n${r.stderr}`);
  const ok = classified.method === "subscription" && settings.conflicts.length === 0;
  return { ...base, ...classified, ok };
}

/** Motivo de bloqueio legível, ou null se a execução pode seguir. */
export function authBlockReason(a: AuthCheck): string | null {
  if (a.method !== "subscription") {
    const hint =
      a.method === "none"
        ? `faça login pelo fluxo oficial (${a.provider === "claude" ? "`claude` e depois /login" : "`codex login`"})`
        : "confirme pelo status oficial que o login ativo é a assinatura";
    return `método de autenticação do ${a.provider} = ${a.method} (${a.detail}); ${hint}. Nenhum fallback de cobrança é usado.`;
  }
  if (a.conflicts.length) return `configuração que pode selecionar API/gateway: ${a.conflicts.join("; ")}`;
  if (a.extraUsage === "unverifiable-not-acknowledged") {
    return `não há interface oficial para verificar se créditos/uso extra estão ativos na conta ${a.provider}. Confirme a ciência em .duo/config.json (billing.acknowledgeUnverifiableExtraUsage.${a.provider}=true) antes de delegar.`;
  }
  return null;
}
