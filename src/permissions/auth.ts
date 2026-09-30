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

type ClaudeSettingsLayer = {
  file: string;
  settings: Record<string, unknown>;
};

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function claudeSettingsLayers(paths: AuthPaths, env: NodeJS.ProcessEnv): { regular: string[]; managed: string[] } {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(paths.home, ".claude");
  // Claude applies the user's two settings files before both project layers;
  // project-local settings are the final ordinary overlay. Keep managed
  // settings separate because a managed policy must remain visible even when a
  // lower layer tries to mask it.
  return {
    regular: [
      join(configDir, "settings.json"),
      join(configDir, "settings.local.json"),
      join(paths.projectRoot, ".claude", "settings.json"),
      join(paths.projectRoot, ".claude", "settings.local.json"),
    ],
    managed: paths.claudeManagedSettings,
  };
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
export function claudeSettingsConflicts(paths: AuthPaths, env: NodeJS.ProcessEnv, allowLoopbackProxy = false): { conflicts: string[]; warnings: string[] } {
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const files = claudeSettingsLayers(paths, env);
  const regular = readClaudeLayers(files.regular, warnings);

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
  providers: Map<string, CodexProviderInspection>;
  profileProviders: Map<string, string | undefined>;
  invalidProviderTables: Set<string>;
  unsupportedRoutingEntries: Set<string>;
  preferredAuthMethod: string | undefined;
  forcedLoginMethod: string | undefined;
  sandboxWorkspaceNetworkAccess: boolean | undefined;
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
        if (header.array || (provider.tail !== "" && provider.tail !== "http_headers" && !provider.tail.startsWith("http_headers."))) info.malformed = true;
        if (provider.tail === "http_headers" || provider.tail.startsWith("http_headers.")) info.credentialKeys.add("http_headers");
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
      const credentialKey = keyParts.find((part) => part === "env_key" || part === "experimental_bearer_token" || part === "http_headers");
      if (credentialKey) {
        // Only retain the credential key name. Its value is deliberately never
        // parsed into a string or included in a diagnostic.
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

function mergeCodexProvider(base: CodexProviderInspection | undefined, overlay: CodexProviderInspection | undefined): CodexProviderInspection {
  const result = base ? { ...base, credentialKeys: new Set(base.credentialKeys), seenKeys: new Set(base.seenKeys) } : emptyCodexProvider();
  if (!overlay) return result;
  if (overlay.baseUrl !== undefined) result.baseUrl = overlay.baseUrl;
  if (overlay.requiresOpenaiAuth !== undefined) result.requiresOpenaiAuth = overlay.requiresOpenaiAuth;
  for (const key of overlay.credentialKeys) result.credentialKeys.add(key);
  result.malformed = result.malformed || overlay.malformed;
  return result;
}

function effectiveString(global: CodexConfigSnapshot | undefined, project: CodexConfigSnapshot | undefined, key: "rootModelProvider" | "preferredAuthMethod" | "forcedLoginMethod"): string | undefined {
  const projectValue = project?.[key];
  return projectValue !== undefined ? projectValue : global?.[key];
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
  const global = existsSync(files[0]!) ? parseCodexConfig(files[0]!) : undefined;
  const project = existsSync(files[1]!) ? parseCodexConfig(files[1]!) : undefined;
  const snapshots = [global, project].filter((snapshot): snapshot is CodexConfigSnapshot => snapshot !== undefined);
  for (const snapshot of snapshots) {
    if (snapshot.rootModelProviderInvalid) conflicts.push(`${snapshot.file}: model_provider não é uma string TOML reconhecível`);
    for (const _ of snapshot.invalidProviderTables) conflicts.push(`${snapshot.file}: tabela de provedor customizado não é suportada com segurança`);
    for (const entry of snapshot.unsupportedRoutingEntries) conflicts.push(`${snapshot.file}: forma TOML não suportada para ${entry}`);
    for (const [profile, providerName] of snapshot.profileProviders) {
      if (snapshot !== project) {
        if (providerName !== undefined && providerName !== "openai") warnings.push(`${snapshot.file}: perfil [${profile}] usa provedor customizado`);
        continue;
      }
      if (providerName === undefined) {
        conflicts.push(`${snapshot.file}: perfil [${profile}] não referencia um provedor reconhecível`);
        continue;
      }
      const providerIsBuiltInOpenai = providerName === "openai" && !global?.providers.has("openai") && !project?.providers.has("openai");
      const info = mergeCodexProvider(global?.providers.get(providerName), project?.providers.get(providerName));
      const origin = providerIsBuiltInOpenai ? "openai" : providerIsLoopbackAuthorized(info, allowLoopbackProxy);
      if (origin) {
        if (origin !== "openai") warnings.push(`${snapshot.file}: proxy local (loopback) autorizado por billing.allowLoopbackProxy: ${origin}`);
      } else {
        const suffix = allowLoopbackProxy ? "" : LOOPBACK_PROXY_HINT;
        conflicts.push(`${snapshot.file}: perfil [${profile}] usa provedor customizado não suportado com segurança${suffix}`);
      }
    }
  }

  const selectedProvider = effectiveString(global, project, "rootModelProvider");
  const effectiveSelectedProvider = selectedProvider ?? "openai";
  const providerNames = new Set<string>([...(global?.providers.keys() ?? []), ...(project?.providers.keys() ?? [])]);
  const validateSelectedProvider = effectiveSelectedProvider !== "openai" || global?.providers.has(effectiveSelectedProvider) === true || project?.providers.has(effectiveSelectedProvider) === true;
  if (validateSelectedProvider) {
    const info = mergeCodexProvider(global?.providers.get(effectiveSelectedProvider), project?.providers.get(effectiveSelectedProvider));
    const origin = providerIsLoopbackAuthorized(info, allowLoopbackProxy);
    const source = project?.providers.has(effectiveSelectedProvider) ? project.file : global?.providers.has(effectiveSelectedProvider) ? global.file : project?.rootModelProvider !== undefined ? project.file : global?.file;
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
      const info = mergeCodexProvider(global?.providers.get(name), project.providers.get(name));
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
      const source = global?.providers.has(name) ? global.file : undefined;
      if (source) warnings.push(`${source}: define provedor customizado (verificar se não está ativo)`);
    }
  }

  const preferredAuthMethod = effectiveString(global, project, "preferredAuthMethod");
  if (preferredAuthMethod === "apikey") conflicts.push(`${project?.preferredAuthMethod !== undefined ? project.file : global?.file}: preferred_auth_method=apikey`);
  const forcedLoginMethod = effectiveString(global, project, "forcedLoginMethod");
  if (forcedLoginMethod === "api") conflicts.push(`${project?.forcedLoginMethod !== undefined ? project.file : global?.file}: forced_login_method=api`);
  const networkAccess = project?.sandboxWorkspaceNetworkAccess ?? global?.sandboxWorkspaceNetworkAccess;
  if (networkAccess === true) warnings.push(`${project?.sandboxWorkspaceNetworkAccess !== undefined ? project.file : global?.file}: sandbox_workspace_write.network_access=true (a ponte força false no executor)`);
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
