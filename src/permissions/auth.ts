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
  /** Codex system/legacy managed paths; optional so offline fixtures do not read the host. */
  codexSystemConfig?: string;
  codexManagedConfig?: string;
  codexRequirements?: string;
};

export function defaultAuthPaths(projectRoot: string, env: NodeJS.ProcessEnv = process.env): AuthPaths {
  const managed =
    process.platform === "darwin"
      ? ["/Library/Application Support/ClaudeCode/managed-settings.json"]
      : process.platform === "win32"
      ? [join(env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json")]
        : ["/etc/claude-code/managed-settings.json"];
  const codexSystemRoot = process.platform === "win32"
    ? join(env.ProgramData ?? "C:\\ProgramData", "OpenAI", "Codex")
    : "/etc/codex";
  return {
    home: env.HOME ?? env.USERPROFILE ?? homedir(),
    projectRoot,
    claudeManagedSettings: managed,
    codexSystemConfig: join(codexSystemRoot, "config.toml"),
    codexManagedConfig: join(codexSystemRoot, "managed_config.toml"),
    codexRequirements: join(codexSystemRoot, "requirements.toml"),
  };
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

type ClaudeSettingsLayer = {
  file: string;
  settings: Record<string, unknown>;
};

type ClaudeSettingsFiles = {
  user: string[];
  project: string[];
  local: string[];
  managed: string[];
};

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function claudeSettingsLayers(paths: AuthPaths, env: NodeJS.ProcessEnv): ClaudeSettingsFiles {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(paths.home, ".claude");
  // `user`, `project`, and `local` are the CLI's selectable sources. Managed
  // policy remains visible even when a lower layer is excluded or masked.
  return {
    user: [join(configDir, "settings.json")],
    project: [join(paths.projectRoot, ".claude", "settings.json")],
    local: [join(paths.projectRoot, ".claude", "settings.local.json")],
    managed: paths.claudeManagedSettings,
  };
}

function claudeSettingSources(settingSources: string): { selected: Set<"user" | "project" | "local">; unknown: string[] } {
  const tokens = settingSources.split(",").map((source) => source.trim()).filter(Boolean);
  if (tokens.length === 0) return { selected: new Set(["user", "project", "local"]), unknown: [] };
  const selected = new Set<"user" | "project" | "local">();
  const unknown: string[] = [];
  for (const token of tokens) {
    if (token === "user" || token === "project" || token === "local") selected.add(token);
    else if (token !== "policy" && token !== "managed" && !unknown.includes(token)) unknown.push(token);
  }
  return { selected, unknown };
}

function readClaudeLayers(files: string[], warnings: string[]): ClaudeSettingsLayer[] {
  const layers: ClaudeSettingsLayer[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const settings = readJson(file);
    if (!settings) {
      warnings.push(`${file}: não foi possível interpretar (JSON inválido); não verificado`);
      continue;
    }
    layers.push({ file, settings });
  }
  return layers;
}

function inspectClaudeLayer(layer: ClaudeSettingsLayer, allowLoopbackProxy: boolean, conflicts: string[], warnings: string[]): void {
  const { file, settings } = layer;
  if (hasOwn(settings, "apiKeyHelper")) conflicts.push(`${file}: define apiKeyHelper (credencial de API teria precedência sobre a assinatura)`);
  if (settings.forceLoginMethod === "console") conflicts.push(`${file}: forceLoginMethod=console (login de API)`);
  const envBlock = settings.env;
  if (typeof envBlock !== "object" || envBlock === null || Array.isArray(envBlock)) return;
  for (const key of Object.keys(envBlock)) {
    if (!BILLING_ENV.includes(key)) continue;
    if (key === "ANTHROPIC_BASE_URL") {
      const origin = allowLoopbackProxy ? loopbackProxyOrigin((envBlock as Record<string, unknown>)[key]) : null;
      if (origin) {
        warnings.push(`${file}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
        continue;
      }
      conflicts.push(`${file}: bloco env define ${key}${allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT}`);
      continue;
    }
    conflicts.push(`${file}: bloco env define ${key}`);
  }
}

/** Inspeciona as settings efetivas do Claude Code sem ler valores secretos. */
export function claudeSettingsConflicts(
  paths: AuthPaths,
  env: NodeJS.ProcessEnv,
  allowLoopbackProxy = false,
  settingSources = "user",
): { conflicts: string[]; warnings: string[] } {
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const files = claudeSettingsLayers(paths, env);
  const sources = claudeSettingSources(settingSources);
  if (sources.unknown.length) {
    warnings.push(`settingSources contém fonte não reconhecida: ${sources.unknown.join(", ")}; fontes regulares inspecionadas de forma conservadora`);
    conflicts.push(`settingSources contém fonte não reconhecida: ${sources.unknown.join(", ")}; não é possível provar a configuração efetiva`);
    for (const source of ["user", "project", "local"] as const) sources.selected.add(source);
  }
  for (const source of ["project", "local"] as const) {
    if (sources.selected.has(source)) continue;
    for (const file of files[source]) {
      if (existsSync(file)) warnings.push(`${file}: fonte ${source} ignorada pelo executor (settingSources=${settingSources || "padrão"})`);
    }
  }
  const regular = (["user", "project", "local"] as const)
    .filter((source) => sources.selected.has(source))
    .flatMap((source) => readClaudeLayers(files[source], warnings));

  let apiKeyHelperSource: string | null = null;
  let forceLoginMethod: unknown;
  let forceLoginMethodSource: string | null = null;
  const effectiveEnv = new Map<string, { source: string; value?: unknown }>();
  for (const layer of regular) {
    const { settings } = layer;
    if (hasOwn(settings, "apiKeyHelper")) apiKeyHelperSource = layer.file;
    if (hasOwn(settings, "forceLoginMethod")) {
      forceLoginMethod = settings.forceLoginMethod;
      forceLoginMethodSource = layer.file;
    }
    const envBlock = settings.env;
    if (typeof envBlock !== "object" || envBlock === null || Array.isArray(envBlock)) continue;
    for (const key of Object.keys(envBlock)) {
      if (!BILLING_ENV.includes(key)) continue;
      // Credential-bearing environment values are represented by presence and
      // source only. The loopback URL is the sole value needed for validation.
      if (key === "ANTHROPIC_BASE_URL") effectiveEnv.set(key, { source: layer.file, value: (envBlock as Record<string, unknown>)[key] });
      else effectiveEnv.set(key, { source: layer.file });
    }
  }

  if (apiKeyHelperSource) conflicts.push(`${apiKeyHelperSource}: define apiKeyHelper (credencial de API teria precedência sobre a assinatura)`);
  if (forceLoginMethod === "console" && forceLoginMethodSource) conflicts.push(`${forceLoginMethodSource}: forceLoginMethod=console (login de API)`);
  for (const [key, value] of effectiveEnv) {
    if (!BILLING_ENV.includes(key)) continue;
    if (key === "ANTHROPIC_BASE_URL") {
      const origin = allowLoopbackProxy ? loopbackProxyOrigin(value.value) : null;
      if (origin) {
        warnings.push(`${value.source}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
        continue;
      }
      conflicts.push(`${value.source}: bloco env define ${key}${allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT}`);
      continue;
    }
    conflicts.push(`${value.source}: bloco env define ${key}`);
  }

  // Managed settings are intentionally checked independently and conservatively.
  // A lower-priority file must not hide a managed billing policy from the report.
  for (const layer of readClaudeLayers(files.managed, warnings)) inspectClaudeLayer(layer, allowLoopbackProxy, conflicts, warnings);
  return { conflicts, warnings };
}

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

type CodexConfigSnapshot = {
  file: string;
  rootModelProvider: string | undefined;
  rootModelProviderInvalid: boolean;
  rootOpenaiBaseUrl: string | undefined;
  rootOpenaiBaseUrlInvalid: boolean;
  rootChatgptBaseUrl: string | undefined;
  rootChatgptBaseUrlInvalid: boolean;
  providers: Map<string, CodexProviderInspection>;
  profileProviders: Map<string, string | undefined>;
  invalidProviderTables: Set<string>;
  unsupportedRoutingEntries: Set<string>;
  preferredAuthMethod: string | undefined;
  forcedLoginMethod: string | undefined;
  sandboxWorkspaceNetworkAccess: boolean | undefined;
};

// These are the built-in first-party endpoints documented by Codex. A local
// proxy must be represented by a named model provider so it can be checked for
// loopback and requires_openai_auth; a root endpoint override is otherwise an
// opaque routing decision.
const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OFFICIAL_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";

function isOfficialBaseUrl(value: string, kind: "openai" | "chatgpt"): boolean {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return normalized === (kind === "openai" ? OFFICIAL_OPENAI_BASE_URL : OFFICIAL_CHATGPT_BASE_URL);
}

function providerTable(table: string): { name: string; tail: string } | null {
  const m = /^model_providers\.([A-Za-z0-9_-]+)(?:\.(.*))?$/.exec(table);
  if (!m || (m[2] !== undefined && !/^[A-Za-z0-9_.-]+$/.test(m[2]))) return null;
  return { name: m[1]!, tail: m[2] ?? "" };
}

const SAFE_PROVIDER_KEYS = new Set(["name", "base_url", "requires_openai_auth", "wire_api", "supports_websockets",
  "request_max_retries", "stream_max_retries", "stream_idle_timeout_ms"]);

function providerIsLoopbackAuthorized(info: CodexProviderInspection | undefined, allowLoopbackProxy: boolean): string | null {
  if (!info || !allowLoopbackProxy || info.malformed || info.requiresOpenaiAuth !== true || info.credentialKeys.size > 0) return null;
  return loopbackProxyOrigin(info.baseUrl);
}

function emptyCodexProvider(): CodexProviderInspection {
  return { baseUrl: undefined, requiresOpenaiAuth: undefined, credentialKeys: new Set<string>(), malformed: false, seenKeys: new Set<string>() };
}

function routingHeaderKind(table: string): "model_providers" | "profiles" | null {
  const compact = table.replace(/\s+/g, "").replace(/\\u[0-9a-fA-F]{4}/g, "_");
  if (/^["']?model_providers["']?(?:[."']|$)/.test(compact)) return "model_providers";
  if (/^["']?profiles["']?(?:[."']|$)/.test(compact)) return "profiles";
  return null;
}

function quotedRoutingEntry(value: string): string | null {
  if (value.includes("\\")) return "chave TOML escapada";
  for (const name of ["model_provider", "preferred_auth_method", "forced_login_method", "network_access", "model_providers", "profiles", "base_url", "requires_openai_auth", "env_key", "experimental_bearer_token", "http_headers"]) {
    if (value === name) return name;
  }
  return /(?:model|provider|profile|auth|network|base|require|env|bearer|header)/i.test(value) ? "chave quoted de roteamento" : null;
}

function unsupportedRootRoutingEntry(line: string): string | null {
  const quoted = /^(['"])(.*?)\1\s*=/.exec(line);
  if (quoted) {
    const entry = quotedRoutingEntry(quoted[2]!);
    if (entry) return entry;
  }
  const key = /^((?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+'))+)\s*=/.exec(line)?.[1];
  const exact = /^((?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+'))\s*=/.exec(line)?.[1];
  const candidate = (key ?? exact)?.replace(/\s+/g, "");
  if (key && /^["']/.test(key)) {
    const entry = quotedRoutingEntry(key);
    if (entry) return entry;
  }
  if (!candidate) return null;
  const head = /^["']?([A-Za-z0-9_-]+)["']?(?:\.|$)/.exec(candidate)?.[1];
  if (!head) return null;
  if (head === "model_providers" || head === "profiles") return head;
  if ((head === "model_provider" || head === "preferred_auth_method" || head === "forced_login_method" || head === "network_access") && (key !== undefined || /^["']/.test(candidate))) return head;
  return null;
}

function parseCodexConfig(file: string): CodexConfigSnapshot {
  const snapshot: CodexConfigSnapshot = {
    file,
    rootModelProvider: undefined,
    rootModelProviderInvalid: false,
    rootOpenaiBaseUrl: undefined,
    rootOpenaiBaseUrlInvalid: false,
    rootChatgptBaseUrl: undefined,
    rootChatgptBaseUrlInvalid: false,
    providers: new Map<string, CodexProviderInspection>(),
    profileProviders: new Map<string, string | undefined>(),
    invalidProviderTables: new Set<string>(),
    unsupportedRoutingEntries: new Set<string>(),
    preferredAuthMethod: undefined,
    forcedLoginMethod: undefined,
    sandboxWorkspaceNetworkAccess: undefined,
  };
  let table = "";
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = tomlWithoutComment(raw);
    if (!line) continue;
    const header = tomlHeader(line);
    if (header) {
      table = header.table;
      if (table.includes("\\")) {
        snapshot.unsupportedRoutingEntries.add("tabela TOML escapada");
        table = "__unsupported_routing__";
        continue;
      }
      const provider = providerTable(table);
      const profile = /^profiles\.[A-Za-z0-9_-]+$/.test(table);
      const unsupportedKind = routingHeaderKind(table);
      if (unsupportedKind && !provider && !profile) {
        snapshot.unsupportedRoutingEntries.add(unsupportedKind);
        table = "__unsupported_routing__";
        continue;
      }
      if (provider) {
        const info = snapshot.providers.get(provider.name) ?? emptyCodexProvider();
        if (header.array) info.malformed = true;
        // Qualquer subtabela do provider (http_headers, env_http_headers, query_params…) pode injetar credenciais.
        if (provider.tail !== "") info.credentialKeys.add(provider.tail.split(".")[0]!);
        snapshot.providers.set(provider.name, info);
      } else if (/^model_providers\./.test(table)) {
        snapshot.invalidProviderTables.add(table);
      }
      continue;
    }
    const tableProvider = providerTable(table);
    const unsupportedRootEntry = unsupportedRootRoutingEntry(line);
    const relevantTable = table === "" || /^profiles\./.test(table) || table === "sandbox_workspace_write" || tableProvider !== null;
    if (relevantTable && unsupportedRootEntry) {
      snapshot.unsupportedRoutingEntries.add(unsupportedRootEntry);
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    const provider = tableProvider;
    if (provider) {
      const info = snapshot.providers.get(provider.name) ?? emptyCodexProvider();
      snapshot.providers.set(provider.name, info);
      const key = kv?.[1] ?? "";
      if (!kv) {
        info.malformed = true;
        continue;
      }
      const keyParts = key.split(".");
      // Lista de permissão: um provider loopback só é aceito com chaves sabidamente inofensivas. Qualquer outra
      // (env_key, experimental_bearer_token, http_headers, env_http_headers, query_params, campos futuros) conta
      // como possível credencial. Guarda-se só o NOME da chave; o valor nunca é lido nem exibido.
      if (provider.tail !== "" || keyParts.length > 1 || !SAFE_PROVIDER_KEYS.has(key)) {
        info.credentialKeys.add(provider.tail !== "" ? provider.tail.split(".")[0]! : keyParts[0]!);
        continue;
      }
      if (info.seenKeys.has(key)) {
        info.malformed = true;
        continue;
      }
      info.seenKeys.add(key);
      if (key === "base_url") {
        const value = tomlString(kv[2]!);
        if (value === undefined) info.malformed = true;
        else info.baseUrl = value;
      }
      else if (key === "requires_openai_auth") {
        const value = kv[2]!.trim();
        if (value === "true") info.requiresOpenaiAuth = true;
        else if (value === "false") info.requiresOpenaiAuth = false;
        else info.malformed = true;
      }
      continue;
    }
    if (!kv) {
      if (/^model_providers\./.test(table)) snapshot.invalidProviderTables.add(table);
      continue;
    }
    const key = kv[1]!;
    if (key === "model_provider" && table === "") {
      const value = tomlString(kv[2]!);
      if (value === undefined) snapshot.rootModelProviderInvalid = true;
      else snapshot.rootModelProvider = value;
    } else if (key === "openai_base_url" && table === "") {
      const value = tomlString(kv[2]!);
      if (value === undefined) snapshot.rootOpenaiBaseUrlInvalid = true;
      else snapshot.rootOpenaiBaseUrl = value;
    } else if (key === "chatgpt_base_url" && table === "") {
      const value = tomlString(kv[2]!);
      if (value === undefined) snapshot.rootChatgptBaseUrlInvalid = true;
      else snapshot.rootChatgptBaseUrl = value;
    } else if (key === "model_provider" && /^profiles\./.test(table)) {
      const value = tomlString(kv[2]!);
      snapshot.profileProviders.set(table, value);
    } else if (key === "preferred_auth_method" && table === "") {
      const value = tomlString(kv[2]!);
      if (value !== undefined) snapshot.preferredAuthMethod = value;
    } else if (key === "forced_login_method" && table === "") {
      const value = tomlString(kv[2]!);
      if (value !== undefined) snapshot.forcedLoginMethod = value;
    } else if (key === "network_access" && table === "sandbox_workspace_write") {
      const value = kv[2]!.trim();
      if (value === "true") snapshot.sandboxWorkspaceNetworkAccess = true;
      else if (value === "false") snapshot.sandboxWorkspaceNetworkAccess = false;
    }
  }
  return snapshot;
}

function mergeCodexProvider(...layers: Array<CodexProviderInspection | undefined>): CodexProviderInspection {
  const result = emptyCodexProvider();
  for (const overlay of layers) {
    if (!overlay) continue;
    if (overlay.baseUrl !== undefined) result.baseUrl = overlay.baseUrl;
    if (overlay.requiresOpenaiAuth !== undefined) result.requiresOpenaiAuth = overlay.requiresOpenaiAuth;
    for (const key of overlay.credentialKeys) result.credentialKeys.add(key);
    result.malformed = result.malformed || overlay.malformed;
    for (const key of overlay.seenKeys) result.seenKeys.add(key);
  }
  return result;
}

function effectiveString(
  system: CodexConfigSnapshot | undefined,
  global: CodexConfigSnapshot | undefined,
  project: CodexConfigSnapshot | undefined,
  key: "rootModelProvider" | "preferredAuthMethod" | "forcedLoginMethod",
): string | undefined {
  const projectValue = project?.[key];
  if (projectValue !== undefined) return projectValue;
  const globalValue = global?.[key];
  return globalValue !== undefined ? globalValue : system?.[key];
}

function effectiveRootUrl(
  system: CodexConfigSnapshot | undefined,
  global: CodexConfigSnapshot | undefined,
  project: CodexConfigSnapshot | undefined,
  key: "rootOpenaiBaseUrl" | "rootChatgptBaseUrl",
): string | undefined {
  return project?.[key] ?? global?.[key] ?? system?.[key];
}

function effectiveBaseRouteRisk(
  system: CodexConfigSnapshot | undefined,
  global: CodexConfigSnapshot | undefined,
  allowLoopbackProxy: boolean,
): boolean {
  if (!system && !global) return false;
  if (system?.rootModelProviderInvalid || global?.rootModelProviderInvalid) return true;
  if (system?.rootOpenaiBaseUrlInvalid || global?.rootOpenaiBaseUrlInvalid) return true;
  if (system?.rootChatgptBaseUrlInvalid || global?.rootChatgptBaseUrlInvalid) return true;
  const openaiBaseUrl = global?.rootOpenaiBaseUrl ?? system?.rootOpenaiBaseUrl;
  if (openaiBaseUrl !== undefined && !isOfficialBaseUrl(openaiBaseUrl, "openai")) return true;
  const chatgptBaseUrl = global?.rootChatgptBaseUrl ?? system?.rootChatgptBaseUrl;
  if (chatgptBaseUrl !== undefined && !isOfficialBaseUrl(chatgptBaseUrl, "chatgpt")) return true;
  const selected = effectiveString(system, global, undefined, "rootModelProvider") ?? "openai";
  const providerInfo = mergeCodexProvider(system?.providers.get(selected), global?.providers.get(selected));
  const hasProviderTable = system?.providers.has(selected) === true || global?.providers.has(selected) === true;
  if (selected === "openai" && !hasProviderTable) return false;
  return providerIsLoopbackAuthorized(providerInfo, allowLoopbackProxy) === null;
}

function readCodexSnapshot(file: string | undefined, conflicts: string[]): CodexConfigSnapshot | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    return parseCodexConfig(file);
  } catch {
    conflicts.push(`${file}: não foi possível interpretar (TOML inválido); não verificado`);
    return undefined;
  }
}

/**
 * openai_base_url troca o endpoint do provider "openai" (o mesmo login ChatGPT/assinatura). Só um proxy loopback,
 * com billing.allowLoopbackProxy, é aceito, com a mesma validação estrita de URL usada para os providers.
 * chatgpt_base_url (login e backends do ChatGPT) continua sem exceção.
 */
function openaiBaseUrlVerdict(file: string, url: string, allowLoopbackProxy: boolean, conflicts: string[], warnings: string[]): void {
  const origin = allowLoopbackProxy ? loopbackProxyOrigin(url) : null;
  if (origin) warnings.push(`${file}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
  else conflicts.push(`${file}: openai_base_url seleciona endpoint não oficial${allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT}`);
}

function validateCodexSnapshotSyntax(snapshot: CodexConfigSnapshot, conflicts: string[]): void {
  if (snapshot.rootModelProviderInvalid) conflicts.push(`${snapshot.file}: model_provider não é uma string TOML reconhecível`);
  if (snapshot.rootOpenaiBaseUrlInvalid) conflicts.push(`${snapshot.file}: openai_base_url não é uma string TOML reconhecível`);
  if (snapshot.rootChatgptBaseUrlInvalid) conflicts.push(`${snapshot.file}: chatgpt_base_url não é uma string TOML reconhecível`);
  for (const _ of snapshot.invalidProviderTables) conflicts.push(`${snapshot.file}: tabela de provedor customizado não é suportada com segurança`);
  for (const entry of snapshot.unsupportedRoutingEntries) conflicts.push(`${snapshot.file}: forma TOML não suportada para ${entry}`);
}

function validateStandaloneManagedCodexSnapshot(
  snapshot: CodexConfigSnapshot,
  allowLoopbackProxy: boolean,
  conflicts: string[],
  warnings: string[],
): void {
  validateCodexSnapshotSyntax(snapshot, conflicts);
  if (snapshot.rootOpenaiBaseUrl !== undefined && !isOfficialBaseUrl(snapshot.rootOpenaiBaseUrl, "openai")) {
    openaiBaseUrlVerdict(snapshot.file, snapshot.rootOpenaiBaseUrl, allowLoopbackProxy, conflicts, warnings);
  }
  if (snapshot.rootChatgptBaseUrl !== undefined && !isOfficialBaseUrl(snapshot.rootChatgptBaseUrl, "chatgpt")) {
    conflicts.push(`${snapshot.file}: chatgpt_base_url seleciona endpoint não oficial`);
  }

  const selectedProvider = snapshot.rootModelProvider ?? "openai";
  const providerInfo = snapshot.providers.get(selectedProvider);
  const builtInOpenai = selectedProvider === "openai" && !providerInfo;
  const origin = builtInOpenai ? "openai" : providerIsLoopbackAuthorized(providerInfo, allowLoopbackProxy);
  if (origin) {
    if (origin !== "openai") warnings.push(`${snapshot.file}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
  } else {
    const suffix = allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT;
    conflicts.push(`${snapshot.file}: model_provider customizado não suportado com segurança${suffix}`);
  }

  for (const [profile, providerName] of snapshot.profileProviders) {
    if (providerName === undefined) {
      conflicts.push(`${snapshot.file}: perfil [${profile}] não referencia um provedor reconhecível`);
      continue;
    }
    const profileInfo = snapshot.providers.get(providerName);
    const profileBuiltInOpenai = providerName === "openai" && !profileInfo;
    const profileOrigin = profileBuiltInOpenai ? "openai" : providerIsLoopbackAuthorized(profileInfo, allowLoopbackProxy);
    if (profileOrigin) {
      if (profileOrigin !== "openai") warnings.push(`${snapshot.file}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${profileOrigin}`);
    } else {
      const suffix = allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT;
      conflicts.push(`${snapshot.file}: perfil [${profile}] usa provedor customizado não suportado com segurança${suffix}`);
    }
  }

  if (snapshot.preferredAuthMethod === "apikey") conflicts.push(`${snapshot.file}: preferred_auth_method=apikey`);
  if (snapshot.forcedLoginMethod === "api") conflicts.push(`${snapshot.file}: forced_login_method=api`);
  if (snapshot.sandboxWorkspaceNetworkAccess === true) warnings.push(`${snapshot.file}: sandbox_workspace_write.network_access=true (a ponte força false no executor)`);
}

/** Modelo padrão do Codex (chave `model` de primeiro nível do config.toml; não é segredo). */
export function codexConfiguredModel(paths: AuthPaths, env: NodeJS.ProcessEnv, ignoreUserConfig = false): string | null {
  const files = ignoreUserConfig
    ? [join(paths.projectRoot, ".codex", "config.toml")]
    : [join(env.CODEX_HOME ?? join(paths.home, ".codex"), "config.toml"), join(paths.projectRoot, ".codex", "config.toml")];
  let model: string | null = null;
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, "").trim();
      if (line.startsWith("[")) break; // só o nível raiz
      const m = /^model\s*=\s*["']([^"']+)["']/.exec(line);
      if (m) model = m[1] as string;
    }
  }
  return model;
}

export function codexConfigConflicts(
  paths: AuthPaths,
  env: NodeJS.ProcessEnv,
  allowLoopbackProxy = false,
  ignoreUserConfig = false,
): { conflicts: string[]; warnings: string[] } {
  const codexHome = env.CODEX_HOME ?? join(paths.home, ".codex");
  const userFile = join(codexHome, "config.toml");
  const projectFile = join(paths.projectRoot, ".codex", "config.toml");
  const conflicts: string[] = [];
  const warnings: string[] = [];
  if (ignoreUserConfig && existsSync(userFile)) warnings.push(`${userFile}: configuração de usuário ignorada pelo executor (--ignore-user-config)`);
  const system = readCodexSnapshot(paths.codexSystemConfig, conflicts);
  const global = !ignoreUserConfig ? readCodexSnapshot(userFile, conflicts) : undefined;
  const project = readCodexSnapshot(projectFile, conflicts);
  const managed = readCodexSnapshot(paths.codexManagedConfig, conflicts);
  const requirements = readCodexSnapshot(paths.codexRequirements, conflicts);
  const snapshots = [system, global, project].filter((snapshot): snapshot is CodexConfigSnapshot => snapshot !== undefined);
  for (const snapshot of snapshots) {
    validateCodexSnapshotSyntax(snapshot, conflicts);
    for (const [profile, providerName] of snapshot.profileProviders) {
      if (snapshot !== project) {
        if (providerName !== undefined && providerName !== "openai") warnings.push(`${snapshot.file}: perfil [${profile}] usa provedor customizado`);
        continue;
      }
      if (providerName === undefined) {
        conflicts.push(`${snapshot.file}: perfil [${profile}] não referencia um provedor reconhecível`);
        continue;
      }
      const providerIsBuiltInOpenai = providerName === "openai" && !system?.providers.has("openai") && !global?.providers.has("openai") && !project?.providers.has("openai");
      const info = mergeCodexProvider(system?.providers.get(providerName), global?.providers.get(providerName), project?.providers.get(providerName));
      const origin = providerIsBuiltInOpenai ? "openai" : providerIsLoopbackAuthorized(info, allowLoopbackProxy);
      if (origin) {
        if (origin !== "openai") warnings.push(`${snapshot.file}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
      } else {
        const suffix = allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT;
        conflicts.push(`${snapshot.file}: perfil [${profile}] usa provedor customizado não suportado com segurança${suffix}`);
      }
    }
  }

  const selectedProvider = effectiveString(system, global, project, "rootModelProvider");
  const effectiveSelectedProvider = selectedProvider ?? "openai";
  const providerNames = new Set<string>([...(system?.providers.keys() ?? []), ...(global?.providers.keys() ?? []), ...(project?.providers.keys() ?? [])]);
  const validateSelectedProvider = effectiveSelectedProvider !== "openai" || system?.providers.has(effectiveSelectedProvider) === true || global?.providers.has(effectiveSelectedProvider) === true || project?.providers.has(effectiveSelectedProvider) === true;
  if (validateSelectedProvider) {
    const info = mergeCodexProvider(system?.providers.get(effectiveSelectedProvider), global?.providers.get(effectiveSelectedProvider), project?.providers.get(effectiveSelectedProvider));
    const origin = providerIsLoopbackAuthorized(info, allowLoopbackProxy);
    const source = project?.providers.has(effectiveSelectedProvider)
      ? project.file
      : global?.providers.has(effectiveSelectedProvider)
        ? global.file
        : system?.providers.has(effectiveSelectedProvider)
          ? system.file
          : project?.rootModelProvider !== undefined
            ? project.file
            : global?.rootModelProvider !== undefined
              ? global.file
              : system?.rootModelProvider !== undefined
                ? system.file
                : undefined;
    if (origin && source) {
      warnings.push(`${source}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
    } else if (source) {
      const suffix = allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT;
      conflicts.push(`${source}: model_provider customizado (provedor diferente do padrão da assinatura)${suffix}`);
    }
  }

  // Project overlays can alter a provider table even when the root selection is
  // inherited or points elsewhere. Validate every project table against the
  // combined global/project result; only a complete loopback provider is safe
  // to leave as a warning.
  if (project) {
    for (const [name] of project.providers) {
      if (validateSelectedProvider && name === effectiveSelectedProvider) continue;
      const info = mergeCodexProvider(system?.providers.get(name), global?.providers.get(name), project.providers.get(name));
      const origin = providerIsLoopbackAuthorized(info, allowLoopbackProxy);
      if (origin) warnings.push(`${project.file}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
      else {
        const suffix = allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT;
        conflicts.push(`${project.file}: tabela de provedor customizado não é suportada com segurança${suffix}`);
      }
    }
  }
  for (const name of providerNames) {
    if (name !== effectiveSelectedProvider && !project?.providers.has(name)) {
      const source = global?.providers.has(name) ? global.file : system?.providers.has(name) ? system.file : undefined;
      if (source) warnings.push(`${source}: define provedor customizado (verificar se não está ativo)`);
    }
  }

  const openaiBaseUrl = effectiveRootUrl(system, global, project, "rootOpenaiBaseUrl");
  const openaiBaseSource = project?.rootOpenaiBaseUrl !== undefined
    ? project.file
    : global?.rootOpenaiBaseUrl !== undefined
      ? global.file
      : system?.rootOpenaiBaseUrl !== undefined
        ? system.file
        : undefined;
  if (openaiBaseUrl !== undefined && !isOfficialBaseUrl(openaiBaseUrl, "openai") && openaiBaseSource) {
    openaiBaseUrlVerdict(openaiBaseSource, openaiBaseUrl, allowLoopbackProxy, conflicts, warnings);
  }
  const chatgptBaseUrl = effectiveRootUrl(system, global, project, "rootChatgptBaseUrl");
  const chatgptBaseSource = project?.rootChatgptBaseUrl !== undefined
    ? project.file
    : global?.rootChatgptBaseUrl !== undefined
      ? global.file
      : system?.rootChatgptBaseUrl !== undefined
        ? system.file
        : undefined;
  if (chatgptBaseUrl !== undefined && !isOfficialBaseUrl(chatgptBaseUrl, "chatgpt") && chatgptBaseSource) {
    conflicts.push(`${chatgptBaseSource}: chatgpt_base_url seleciona endpoint não oficial`);
  }

  // Codex only applies project layers after its trust decision. A safe project
  // overlay cannot prove that an unsafe system/user route is really masked;
  // keep this path fail-closed because this checker does not implement trust.
  const projectHasRoutingOverride = project !== undefined && (
    project.rootModelProvider !== undefined
    || project.providers.size > 0
    || project.profileProviders.size > 0
    || project.rootOpenaiBaseUrl !== undefined
    || project.rootChatgptBaseUrl !== undefined
  );
  const baseRouteSource = global?.file ?? system?.file;
  if (projectHasRoutingOverride && baseRouteSource && effectiveBaseRouteRisk(system, global, allowLoopbackProxy) && conflicts.length === 0) {
    conflicts.push(`${baseRouteSource}: roteamento system/usuário não pode ser mascarado por configuração de projeto sem confiança verificável`);
  }

  const preferredAuthMethod = effectiveString(system, global, project, "preferredAuthMethod");
  const preferredSource = project?.preferredAuthMethod !== undefined
    ? project.file
    : global?.preferredAuthMethod !== undefined
      ? global.file
      : system?.preferredAuthMethod !== undefined
        ? system.file
        : undefined;
  if (preferredAuthMethod === "apikey" && preferredSource) conflicts.push(`${preferredSource}: preferred_auth_method=apikey`);
  const forcedLoginMethod = effectiveString(system, global, project, "forcedLoginMethod");
  const forcedSource = project?.forcedLoginMethod !== undefined
    ? project.file
    : global?.forcedLoginMethod !== undefined
      ? global.file
      : system?.forcedLoginMethod !== undefined
        ? system.file
        : undefined;
  if (forcedLoginMethod === "api" && forcedSource) conflicts.push(`${forcedSource}: forced_login_method=api`);
  const networkAccess = project?.sandboxWorkspaceNetworkAccess ?? global?.sandboxWorkspaceNetworkAccess ?? system?.sandboxWorkspaceNetworkAccess;
  const networkSource = project?.sandboxWorkspaceNetworkAccess !== undefined
    ? project.file
    : global?.sandboxWorkspaceNetworkAccess !== undefined
      ? global.file
      : system?.sandboxWorkspaceNetworkAccess !== undefined
        ? system.file
        : undefined;
  if (networkAccess === true && networkSource) warnings.push(`${networkSource}: sandbox_workspace_write.network_access=true (a ponte força false no executor)`);

  // Legacy managed and requirements TOMLs are checked independently. Their
  // values are not overlaid with user/project files, so a lower layer cannot
  // hide a managed route. MDM preferences and EnterpriseManaged cloud bundles
  // are intentionally outside this local checker and remain unverifiable.
  if (managed) validateStandaloneManagedCodexSnapshot(managed, allowLoopbackProxy, conflicts, warnings);
  if (requirements) validateStandaloneManagedCodexSnapshot(requirements, allowLoopbackProxy, conflicts, warnings);
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
  sources: { settingSources?: string; ignoreUserConfig?: boolean } = {},
): AuthCheck {
  const { env, removed } = childEnv(baseEnv);
  const extraUsage = cfg.billing.acknowledgeUnverifiableExtraUsage[provider] === true ? "unverifiable-acknowledged" : "unverifiable-not-acknowledged";
  const settings =
    provider === "claude"
      ? claudeSettingsConflicts(paths, baseEnv, cfg.billing.allowLoopbackProxy, sources.settingSources ?? cfg.executors.claude.settingSources)
      : codexConfigConflicts(paths, baseEnv, cfg.billing.allowLoopbackProxy, sources.ignoreUserConfig ?? cfg.executors.codex.ignoreUserConfig);
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
