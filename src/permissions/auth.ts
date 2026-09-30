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

/**
 * Returns the origin of a loopback HTTP(S) URL, or null when the URL is not
 * safe to authorize. The raw authority is checked before URL normalization so
 * decimal/hex IPv4 aliases and mapped IPv6 addresses cannot pass as loopback.
 * Paths and query strings are deliberately omitted from the returned value.
 */
export function loopbackProxyOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || value.trim() !== value || /[\u0000-\u0020\\]/.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;

  const schemeEnd = value.indexOf("//");
  if (schemeEnd < 0) return null;
  const authorityStart = schemeEnd + 2;
  const rest = value.slice(authorityStart);
  const endOffset = rest.search(/[/?#]/);
  const authority = rest.slice(0, endOffset < 0 ? rest.length : endOffset);
  if (!authority || authority.includes("@")) return null;

  let rawHost: string;
  let rawPort: string;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return null;
    rawHost = authority.slice(0, close + 1);
    rawPort = authority.slice(close + 1);
    if (rawPort !== "" && !/^:[0-9]+$/.test(rawPort)) return null;
  } else {
    const colon = authority.indexOf(":");
    rawHost = colon < 0 ? authority : authority.slice(0, colon);
    rawPort = colon < 0 ? "" : authority.slice(colon);
    if (rawPort !== "" && !/^:[0-9]+$/.test(rawPort)) return null;
  }
  const host = rawHost.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return null;
  const normalizedHost = parsed.hostname.toLowerCase();
  if (normalizedHost !== host) return null;
  // URL rejects out-of-range ports; keep this explicit for a raw trailing port.
  if (rawPort && parsed.port === "" && !/:0*(?:80|443)$/.test(rawPort)) return null;
  return parsed.origin;
}

const LOOPBACK_PROXY_HINT = "; se for um proxy local que usa a sua assinatura, habilite billing.allowLoopbackProxy";

/** Inspeciona settings do Claude Code procurando apenas nomes de chaves que mudariam a cobrança. */
export function claudeSettingsConflicts(paths: AuthPaths, env: NodeJS.ProcessEnv, allowLoopbackProxy = false): { conflicts: string[]; warnings: string[] } {
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
        if (!BILLING_ENV.includes(k)) continue;
        if (k === "ANTHROPIC_BASE_URL") {
          const origin = allowLoopbackProxy ? loopbackProxyOrigin((envBlock as Record<string, unknown>)[k]) : null;
          if (origin) {
            warnings.push(`${f}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
            continue;
          }
          conflicts.push(`${f}: bloco env define ${k}${allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT}`);
          continue;
        }
        conflicts.push(`${f}: bloco env define ${k}`);
      }
    }
  }
  return { conflicts, warnings };
}

/** Leitura mínima de TOML: só cabeçalhos de tabela e valores de chaves não secretas da lista abaixo. */
const CODEX_READABLE_KEYS = new Set(["model_provider", "preferred_auth_method", "forced_login_method", "network_access"]);

function tomlWithoutComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = quote === ch ? null : quote ?? ch;
      continue;
    }
    if (ch === "#" && quote === null) return raw.slice(0, i).trim();
  }
  return raw.trim();
}

function tomlString(value: string): string | undefined {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && !v.slice(1, -1).includes("'")) return v.slice(1, -1);
  return undefined;
}

function tomlHeader(line: string): { table: string; array: boolean } | null {
  const array = /^\[\[([^\]]+)\]\]$/.exec(line);
  if (array) return { table: array[1]!.trim(), array: true };
  const single = /^\[([^\]]+)\]$/.exec(line);
  return single ? { table: single[1]!.trim(), array: false } : null;
}

type CodexProviderInspection = {
  baseUrl: string | undefined;
  requiresOpenaiAuth: boolean | undefined;
  credentialKeys: Set<string>;
  malformed: boolean;
  seenKeys: Set<string>;
};

function providerTable(table: string): { name: string; tail: string } | null {
  const m = /^model_providers\.([A-Za-z0-9_-]+)(?:\.(.*))?$/.exec(table);
  if (!m || (m[2] !== undefined && !/^[A-Za-z0-9_.-]+$/.test(m[2]))) return null;
  return { name: m[1]!, tail: m[2] ?? "" };
}

function providerIsLoopbackAuthorized(info: CodexProviderInspection, allowLoopbackProxy: boolean): string | null {
  if (!allowLoopbackProxy || info.malformed || info.requiresOpenaiAuth !== true || info.credentialKeys.size > 0) return null;
  return loopbackProxyOrigin(info.baseUrl);
}

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

export function codexConfigConflicts(paths: AuthPaths, env: NodeJS.ProcessEnv, allowLoopbackProxy = false): { conflicts: string[]; warnings: string[] } {
  const codexHome = env.CODEX_HOME ?? join(paths.home, ".codex");
  const files = [join(codexHome, "config.toml"), join(paths.projectRoot, ".codex", "config.toml")];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    let table = "";
    let rootModelProvider: string | null = null;
    let rootModelProviderInvalid = false;
    const providers = new Map<string, CodexProviderInspection>();
    const profileProviders = new Set<string>();
    const invalidProviderTables = new Set<string>();
    for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
      const line = tomlWithoutComment(raw);
      if (!line) continue;
      const header = tomlHeader(line);
      if (header) {
        table = header.table;
        const provider = providerTable(table);
        if (provider) {
          const info = providers.get(provider.name) ?? { baseUrl: undefined, requiresOpenaiAuth: undefined, credentialKeys: new Set<string>(), malformed: false, seenKeys: new Set<string>() };
          if (header.array || (provider.tail !== "" && provider.tail !== "http_headers" && !provider.tail.startsWith("http_headers."))) info.malformed = true;
          if (provider.tail === "http_headers" || provider.tail.startsWith("http_headers.")) info.credentialKeys.add("http_headers");
          providers.set(provider.name, info);
        } else if (/^model_providers\./.test(table)) {
          invalidProviderTables.add(table);
        }
        continue;
      }
      const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
      const provider = providerTable(table);
      if (provider) {
        const info = providers.get(provider.name)!;
        const key = kv?.[1] ?? "";
        if (!kv) {
          info.malformed = true;
          continue;
        }
        const keyParts = key.split(".");
        const credentialKey = keyParts.find((part) => part === "env_key" || part === "experimental_bearer_token" || part === "http_headers");
        if (credentialKey) {
          info.credentialKeys.add(credentialKey);
          continue;
        }
        if (provider.tail !== "") {
          if (provider.tail !== "http_headers" && !provider.tail.startsWith("http_headers.")) info.malformed = true;
          continue;
        }
        if (info.seenKeys.has(key)) {
          info.malformed = true;
          continue;
        }
        info.seenKeys.add(key);
        if (key === "base_url") info.baseUrl = tomlString(kv[2]!);
        else if (key === "requires_openai_auth") {
          const value = kv[2]!.trim();
          if (value === "true") info.requiresOpenaiAuth = true;
          else if (value === "false") info.requiresOpenaiAuth = false;
          else info.malformed = true;
        }
        continue;
      }
      if (!kv) {
        if (/^model_providers\./.test(table)) invalidProviderTables.add(table);
        continue;
      }
      const key = kv[1]!;
      if (key === "model_provider" && table === "") {
        const value = tomlString(kv[2]!);
        if (value === undefined) rootModelProviderInvalid = true;
        else rootModelProvider = value;
      } else if (key === "model_provider" && /^profiles\./.test(table)) {
        const value = tomlString(kv[2]!);
        if (value !== undefined && value !== "openai") profileProviders.add(table);
      } else if (!CODEX_READABLE_KEYS.has(key)) continue;
      else if (key === "preferred_auth_method" && tomlString(kv[2]!) === "apikey") {
        conflicts.push(`${f}: preferred_auth_method=apikey`);
      } else if (key === "forced_login_method" && tomlString(kv[2]!) === "api") {
        conflicts.push(`${f}: forced_login_method=api`);
      } else if (key === "network_access" && table === "sandbox_workspace_write" && kv[2]!.trim() === "true") {
        warnings.push(`${f}: sandbox_workspace_write.network_access=true (a ponte força false no executor)`);
      }
    }

    if (rootModelProviderInvalid) conflicts.push(`${f}: model_provider não é uma string TOML reconhecível`);
    if (rootModelProvider && rootModelProvider !== "openai") {
      const info = providers.get(rootModelProvider);
      const origin = info ? providerIsLoopbackAuthorized(info, allowLoopbackProxy) : null;
      if (origin) {
        warnings.push(`${f}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
      } else {
        const suffix = allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT;
        conflicts.push(`${f}: model_provider customizado (provedor diferente do padrão da assinatura)${suffix}`);
      }
    }
    for (const _ of invalidProviderTables) {
      conflicts.push(`${f}: tabela de provedor customizado não é suportada com segurança`);
    }
    for (const [name] of providers) {
      if (name !== rootModelProvider) warnings.push(`${f}: define provedor customizado (verificar se não está ativo)`);
    }
    for (const profile of profileProviders) warnings.push(`${f}: perfil [${profile}] usa provedor customizado`);
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
  const settings = provider === "claude" ? claudeSettingsConflicts(paths, baseEnv, cfg.billing.allowLoopbackProxy) : codexConfigConflicts(paths, baseEnv, cfg.billing.allowLoopbackProxy);
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
