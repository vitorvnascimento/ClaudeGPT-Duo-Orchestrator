import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveExecutable, type Resolved } from "../adapters/resolve.js";
import { childEnv } from "./auth.js";

export type EffectiveCodexConfig = {
  model_provider?: string;
  openai_base_url?: string;
  chatgpt_base_url?: string;
  providers: Record<string, { baseUrl?: string; requiresOpenaiAuth?: boolean; keys: string[] }>;
  mcpServers: string[];
  preferredAuthMethod?: string;
  forcedLoginMethod?: string;
  networkAccess?: boolean;
  model?: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Discard instructions, credentials, MCP definitions and every unused value immediately. */
function normalize(result: unknown): EffectiveCodexConfig | null {
  if (!object(result) || !object(result.config)) return null;
  const c = result.config;
  const out: EffectiveCodexConfig = { providers: Object.create(null) as EffectiveCodexConfig["providers"], mcpServers: [] };
  // Codex serializes ModelProviderInfo defaults (including null credential fields).
  // Layers preserve explicit keys, including unknown ones omitted by that typed serialization.
  // Never retain their values; disabled project layers do not participate in the effective config.
  const providerKeys = new Map<string, Set<string>>();
  if (result.layers != null) {
    if (!Array.isArray(result.layers)) return null;
    for (const layer of result.layers) {
      if (!object(layer) || !object(layer.config)) return null;
      if (layer.disabledReason != null) continue;
      const providers = layer.config.model_providers;
      if (providers == null) continue;
      if (!object(providers)) return null;
      for (const [name, provider] of Object.entries(providers)) {
        if (!object(provider)) return null;
        const keys = providerKeys.get(name) ?? new Set<string>();
        for (const key of Object.keys(provider)) keys.add(key);
        providerKeys.set(name, keys);
      }
    }
  }
  for (const [from, to] of [
    ["model_provider", "model_provider"], ["openai_base_url", "openai_base_url"], ["chatgpt_base_url", "chatgpt_base_url"],
    ["preferred_auth_method", "preferredAuthMethod"], ["forced_login_method", "forcedLoginMethod"], ["model", "model"],
  ] as const) {
    if (c[from] == null) continue;
    if (typeof c[from] !== "string") return null;
    out[to] = c[from];
  }
  for (const key of ["model_providers", "mcp_servers", "sandbox_workspace_write"] as const) {
    if (c[key] != null && !object(c[key])) return null;
  }
  for (const [name, provider] of Object.entries(c.model_providers ?? {})) {
    if (!object(provider)) return null;
    if (provider.base_url != null && typeof provider.base_url !== "string") return null;
    if (provider.requires_openai_auth != null && typeof provider.requires_openai_auth !== "boolean") return null;
    const explicit = providerKeys.get(name);
    // Also inspect non-null effective fields: a profile/runtime source must not hide credentials.
    // supports_standalone_web_search=false is an implicit Codex default, not an authored key.
    const keys = explicit ? new Set([...explicit, ...Object.keys(provider).filter((key) =>
      provider[key] != null && !(key === "supports_standalone_web_search" && provider[key] === false))]) : Object.keys(provider);
    out.providers[name] = {
      ...(typeof provider.base_url === "string" ? { baseUrl: provider.base_url } : {}),
      ...(typeof provider.requires_openai_auth === "boolean" ? { requiresOpenaiAuth: provider.requires_openai_auth } : {}),
      keys: [...keys].sort(),
    };
  }
  // A declared provider absent from the typed result cannot be verified.
  if ([...providerKeys.keys()].some((name) => !Object.hasOwn(out.providers, name))) return null;
  for (const [name, server] of Object.entries(c.mcp_servers ?? {})) {
    if (!object(server) || (server.enabled != null && typeof server.enabled !== "boolean")) return null;
    out.mcpServers.push(name);
  }
  if (object(c.sandbox_workspace_write) && c.sandbox_workspace_write.network_access != null) {
    if (typeof c.sandbox_workspace_write.network_access !== "boolean") return null;
    out.networkAccess = c.sandbox_workspace_write.network_access;
  }
  return out;
}

type ReadOptions = { cwd: string; env: NodeJS.ProcessEnv; ignoreUserConfig?: boolean; timeoutMs?: number; resolved?: Resolved };
const cache = new Map<string, { expires: number; value: Promise<EffectiveCodexConfig | null> }>();

/** Only initialize + config/read, never account methods, inference or config writes. */
export async function readEffectiveCodexConfig(options: ReadOptions): Promise<EffectiveCodexConfig | null> {
  try {
    const env = childEnv(options.env).env;
    const resolved = options.resolved ?? resolveExecutable("codex", undefined, env);
    if (!resolved.ok) return null;
    const cwd = resolve(options.cwd);
    // The digest distinguishes command/environment without retaining secret values in cache keys.
    const key = createHash("sha256").update(JSON.stringify([cwd, resolved, options.ignoreUserConfig === true, options.timeoutMs,
      Object.entries(env).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
    const now = Date.now();
    for (const [k, entry] of cache) if (entry.expires <= now) cache.delete(k);
    const hit = cache.get(key);
    if (hit) return structuredClone(await hit.value);
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    const entry = { expires: Infinity, value: read({ ...options, cwd, env }, resolved) };
    cache.set(key, entry);
    const value = await entry.value;
    entry.expires = Date.now() + 1000;
    return structuredClone(value);
  } catch { return null; }
}

async function read(options: ReadOptions, resolved: Resolved & { ok: true }): Promise<EffectiveCodexConfig | null> {
  let temporaryHome: string | undefined;
  try {
    const env = { ...options.env };
    if (options.ignoreUserConfig) {
      temporaryHome = await mkdtemp(join(tmpdir(), "duo-codex-config-"));
      env.CODEX_HOME = temporaryHome;
    }
    return await new Promise<EffectiveCodexConfig | null>((done) => {
      const child = spawn(resolved.command, [...resolved.prefixArgs, "app-server"], {
        cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
      let buffer = "", bytes = 0;
      let stage: "initialize" | "config/read" | "done" = "initialize";
      let value: EffectiveCodexConfig | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        done(value);
      };
      const stop = (result: EffectiveCodexConfig | null) => {
        if (stage === "done") return;
        stage = "done";
        value = result;
        buffer = "";
        child.stdin.end();
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 100);
      };
      const timer = setTimeout(() => stop(null), options.timeoutMs ?? 5000);
      child.on("error", () => { value = null; finish(); });
      child.on("close", finish);
      child.stdin.on("error", () => stop(null));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stage === "done") return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) { stop(null); return; }
        buffer += chunk;
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { stop(null); return; }
          if (!object(msg)) { stop(null); return; }
          if (msg.method !== undefined) continue; // Discard all notifications and server requests.
          if (msg.id !== (stage === "initialize" ? 1 : 2)) continue;
          if (msg.error !== undefined || !object(msg.result)) { stop(null); return; }
          if (stage === "initialize") {
            stage = "config/read";
            child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
            child.stdin.write(`${JSON.stringify({ id: 2, method: "config/read", params: { includeLayers: true, cwd: options.cwd } })}\n`);
          } else { stop(normalize(msg.result)); return; }
        }
      });
      child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {
        clientInfo: { name: "duo-orchestrator", version: "0.2.0" },
      } })}\n`);
    });
  } catch { return null; }
  finally { if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined); }
}
