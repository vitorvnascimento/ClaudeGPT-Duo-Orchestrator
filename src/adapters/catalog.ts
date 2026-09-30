// Descoberta dos modelos disponíveis nas contas conectadas, pelas CLIs oficiais e sem inferência.
// Cada conta tem uma cadeia de fontes, da mais estável para a menos estável:
// - Claude Code: handshake `initialize` do protocolo stream-json (o mesmo usado por supportedModels() do Agent SDK);
// - Codex: `codex app-server` → `model/list` + `modelProvider/capabilities/read` (métodos da superfície ESTÁVEL do
//   protocolo JSON-RPC que a extensão do VS Code e o app usam; schema publicado por `generate-json-schema`);
//   se falhar, `codex debug models` + `codex features list` (ferramenta de depuração, formato não contratual).
// Se todas as fontes de uma conta falharem, vale o último catálogo bom (marcado como desatualizado) e, por fim,
// `routing.candidates` da config. A resposta de cada fonte é validada: formato inesperado cai para a próxima.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type DuoConfig, type Provider } from "../config.js";
import { childEnv, codexConfiguredModel, defaultAuthPaths } from "../permissions/auth.js";
import { redact } from "../redact.js";
import { readJson, type Store, writeJsonAtomic } from "../state/store.js";
import { parseCodexQuota, saveQuota, type QuotaState } from "../orchestration/quota.js";
import { parseVersion } from "./capabilities.js";
import { extraUsage, tierOf } from "./tiers.js";
import { runQuick } from "./process.js";
import { resolveExecutable, type Resolved } from "./resolve.js";

/** Capacidades que uma subtarefa pode exigir. "code" = qualquer modelo de texto/código. */
export type Capability = "code" | "image_generation";

export type ModelInfo = {
  provider: Provider;
  source?: "discovered" | "user-config";
  /** Identificador a passar em --model (ID resolvido no Claude, slug no Codex). */
  id: string;
  aliases: string[];
  displayName: string;
  description: string;
  efforts: string[];
  contextWindow: number | null;
  /** Sinais do próprio fornecedor (não são ranking nosso). */
  vendorRecommended: boolean;
  legacy: boolean;
  capabilities: Capability[];
  /** Modelo sucessor indicado pelo fornecedor e data de aposentadoria, quando informados. */
  upgradeTo?: string | null;
  retirementAt?: string | null;
};

export type SourceKind = "claude-initialize" | "codex-app-server" | "codex-debug-models" | "none";

export type ProviderCatalog = {
  ok: boolean;
  source: string;
  sourceKind?: SourceKind;
  /** A fonte usada é uma superfície contratual/estável da CLI (false = fallback frágil). */
  stable?: boolean;
  quota?: QuotaState;
  /** Catálogo reaproveitado de uma descoberta anterior porque as fontes atuais falharam. */
  stale?: boolean;
  staleSince?: string;
  /** Fontes que falharam antes da usada (ou todas, quando ok=false). */
  attempts?: string[];
  error?: string;
  tools: string[];
  models: ModelInfo[];
};
export type Catalog = {
  discoveredAt: string;
  cliVersions: Record<Provider, string | null>;
  /** Descoberto dentro do sandbox do Codex (fonte estável indisponível ali): refeito ao rodar fora dele. */
  discoveredInSandbox?: boolean;
  providers: Record<Provider, ProviderCatalog>;
};

const TTL_MS = 6 * 60 * 60 * 1000;
/** Com fonte frágil, falha ou cache desatualizado, tenta de novo mais cedo. */
const DEGRADED_TTL_MS = 60 * 60 * 1000;
/** Último catálogo bom é aceito por até 30 dias; depois disso, só routing.candidates. */
const MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const LEGACY = /\b(older|legacy|deprecated)\b/i;
const CLIENT_INFO = { name: "duo-orchestrator", title: "ClaudeGPT - Duo Orchestrator by Fusic", version: "0.2.0" };

/** Processo rodando dentro do sandbox do Codex (ex.: `duo recommend` chamado pelo cérebro Codex). */
export function inCodexSandbox(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CODEX_SANDBOX) || env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
}

const errMsg = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

export function parseClaudeInitialize(response: Record<string, unknown>): ModelInfo[] {
  if (!Array.isArray(response.models)) throw new Error("formato inesperado do initialize: falta models[]");
  const raw = response.models as Record<string, unknown>[];
  const byId = new Map<string, ModelInfo>();
  let recommended: string | null = null;
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const value = String(m.value ?? "");
    const id = String(m.resolvedModel ?? value);
    if (!id) continue;
    if (value === "default") {
      recommended = id; // "Default (recommended)" é a recomendação do próprio fornecedor
      continue;
    }
    const existing = byId.get(id);
    if (existing) {
      if (value && !existing.aliases.includes(value)) existing.aliases.push(value);
      continue;
    }
    const description = String(m.description ?? "");
    byId.set(id, {
      provider: "claude",
      id,
      aliases: value && value !== id ? [value] : [],
      displayName: String(m.displayName ?? id),
      description,
      efforts: Array.isArray(m.supportedEffortLevels) ? (m.supportedEffortLevels as unknown[]).map(String) : [],
      contextWindow: null,
      vendorRecommended: false,
      legacy: LEGACY.test(description),
      capabilities: ["code"],
    });
  }
  if (recommended && byId.has(recommended)) (byId.get(recommended) as ModelInfo).vendorRecommended = true;
  return [...byId.values()];
}

/** Valida uma página de `model/list` (app-server v2). Campos extras são ignorados; faltar um obrigatório é erro. */
export function validateModelListPage(result: unknown): { data: Record<string, unknown>[]; nextCursor: string | null } {
  const o = result as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.data)) throw new Error("formato inesperado de model/list: falta data[]");
  (o.data as unknown[]).forEach((m, i) => {
    const x = m as Record<string, unknown> | null;
    if (!x || typeof x !== "object") throw new Error(`formato inesperado de model/list: data[${i}] não é objeto`);
    for (const k of ["id", "displayName"]) if (typeof x[k] !== "string" || !x[k]) throw new Error(`formato inesperado de model/list: data[${i}].${k}`);
    for (const k of ["hidden", "isDefault"]) if (typeof x[k] !== "boolean") throw new Error(`formato inesperado de model/list: data[${i}].${k}`);
  });
  const nc = o.nextCursor;
  if (nc !== undefined && nc !== null && typeof nc !== "string") throw new Error("formato inesperado de model/list: nextCursor");
  return { data: o.data as Record<string, unknown>[], nextCursor: typeof nc === "string" && nc ? nc : null };
}

export function parseCodexAppServerModels(data: Record<string, unknown>[], tools: string[]): ModelInfo[] {
  return data
    .filter((m) => m.hidden !== true)
    .map((m) => {
      const slug = String(typeof m.model === "string" && m.model ? m.model : m.id);
      const description = String(m.description ?? "");
      const info = (m.upgradeInfo ?? null) as { model?: unknown; retirementAt?: unknown } | null;
      const upgradeTo = typeof info?.model === "string" ? info.model : typeof m.upgrade === "string" ? m.upgrade : null;
      const retirementAt = typeof info?.retirementAt === "number" ? new Date(info.retirementAt * 1000).toISOString() : null;
      return {
        provider: "codex" as const,
        id: slug,
        aliases: m.id !== slug ? [String(m.id)] : [],
        displayName: String(m.displayName),
        description,
        efforts: Array.isArray(m.supportedReasoningEfforts)
          ? (m.supportedReasoningEfforts as { reasoningEffort?: unknown }[]).map((x) => String(x?.reasoningEffort ?? x))
          : [],
        contextWindow: null,
        vendorRecommended: m.isDefault === true,
        // Sucessor declarado pelo fornecedor é o sinal tipado; a descrição é só complemento.
        legacy: upgradeTo !== null || LEGACY.test(description),
        // A geração de imagem no Codex é uma ferramenta do provedor, disponível para os modelos do agente.
        capabilities: tools.includes("image_generation") ? ["code", "image_generation"] : ["code"],
        upgradeTo,
        retirementAt,
      };
    });
}

export function parseCodexModels(json: unknown, tools: string[]): ModelInfo[] {
  const models = (json as { models?: Record<string, unknown>[] } | null)?.models;
  if (!Array.isArray(models)) throw new Error("formato inesperado de debug models: falta models[]");
  const visible = models.filter((m) => m && typeof m.slug === "string" && m.visibility !== "hide");
  const topPriority = Math.min(...visible.map((m) => (typeof m.priority === "number" ? m.priority : Number.MAX_SAFE_INTEGER)));
  return visible.map((m) => {
    const description = String(m.description ?? "");
    return {
      provider: "codex" as const,
      id: String(m.slug),
      aliases: [],
      displayName: String(m.display_name ?? m.slug),
      description,
      efforts: Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as { effort?: unknown }[]).map((x) => String(x.effort ?? x)) : [],
      contextWindow: typeof m.context_window === "number" ? m.context_window : null,
      vendorRecommended: m.priority === topPriority,
      legacy: LEGACY.test(description),
      capabilities: tools.includes("image_generation") ? ["code", "image_generation"] : ["code"],
    };
  });
}

export function parseCodexFeatures(text: string): string[] {
  const tools: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+.*\s(true|false)\s*$/.exec(line.trim());
    if (m && m[2] === "true" && m[1] === "image_generation") tools.push("image_generation");
  }
  return tools;
}

/** Handshake initialize: abre a CLI em stream-json, pede a lista e fecha a entrada sem enviar mensagem (sem inferência). */
function claudeInitialize(resolved: Resolved & { ok: true }, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const args = [...resolved.prefixArgs, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", "", "--setting-sources", "user", "--strict-mcp-config"];
    const child = spawn(resolved.command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    let done = false;
    const finish = (err: Error | null, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill("SIGINT"), 3000).unref();
      if (err) reject(err);
      else resolvePromise(value as Record<string, unknown>);
    };
    const timer = setTimeout(() => finish(new Error("timeout no handshake initialize")), timeoutMs);
    child.on("error", (e) => finish(e));
    child.on("close", () => finish(new Error("CLI encerrou sem responder ao initialize")));
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line) as { type?: string; response?: { subtype?: string; response?: Record<string, unknown>; error?: string } };
          if (ev.type === "control_response") {
            if (ev.response?.subtype === "success" && ev.response.response) finish(null, ev.response.response);
            else finish(new Error(`initialize falhou: ${ev.response?.error ?? "resposta inesperada"}`));
          }
        } catch {
          /* linhas não JSON são ignoradas */
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "duo-models", request: { subtype: "initialize" } })}\n`);
  });
}

type AppServerResult = { models: Record<string, unknown>[]; imageGeneration: boolean | null; capabilitiesError?: string; quotaRaw?: unknown };

/**
 * Cliente JSON-RPC mínimo do `codex app-server` (stdio, uma mensagem JSON por linha).
 * Só chama métodos de leitura; notificações (ex.: account/updated) são descartadas e nunca persistidas.
 */
function codexAppServer(resolved: Resolved & { ok: true }, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 20_000): Promise<AppServerResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(resolved.command, [...resolved.prefixArgs, "app-server"], { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let readable: AppServerResult | undefined;
    const pending = new Map<number, (msg: { result?: unknown; error?: { message?: string; code?: number } }) => void>();
    let nextId = 0;
    let buf = "";
    let stderr = "";
    let done = false;
    const finish = (err: Error | null, value?: AppServerResult) => {
      if (done) return;
      done = true;
      // A leitura opcional de cota nunca invalida o catálogo já obtido.
      if (err && readable) { err = null; value = readable; }
      clearTimeout(timer);
      pending.clear();
      child.stdin.end();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000).unref();
      if (err) reject(err);
      else resolvePromise(value as AppServerResult);
    };
    const timer = setTimeout(() => finish(new Error(`sem resposta em ${timeoutMs / 1000}s`)), timeoutMs);
    child.on("error", (e) => finish(e));
    child.on("close", (code) => finish(new Error(`app-server encerrou (código ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)?.slice(0, 200)}` : ""}`)));
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString("utf8")).slice(-2000);
    });
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string; code?: number } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // Resposta = tem id e não tem method. Notificações e pedidos do servidor são ignorados.
        if (typeof msg.id === "number" && msg.method === undefined) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb?.(msg);
        }
      }
    });
    const call = (method: string, params?: Record<string, unknown>, optionalTimeout?: number) =>
      new Promise<unknown>((res, rej) => {
        const id = ++nextId;
        const timeout = optionalTimeout ? setTimeout(() => { pending.delete(id); res(null); }, optionalTimeout) : null;
        pending.set(id, (m) => { if (timeout) clearTimeout(timeout); return (m.error ? rej(new Error(`${method}: ${m.error.message ?? "erro"}${m.error.code !== undefined ? ` (${m.error.code})` : ""}`)) : res(m.result)); });
        child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
      });
    (async () => {
      await call("initialize", { clientInfo: CLIENT_INFO });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const models: Record<string, unknown>[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const r = validateModelListPage(await call("model/list", cursor ? { cursor } : {}));
        models.push(...r.data);
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      if (!models.some((m) => m.hidden !== true)) throw new Error("model/list não devolveu nenhum modelo visível");
      let imageGeneration: boolean | null = null;
      let capabilitiesError: string | undefined;
      try {
        const caps = (await call("modelProvider/capabilities/read", {})) as { imageGeneration?: unknown } | null;
        if (typeof caps?.imageGeneration !== "boolean") throw new Error("formato inesperado: falta imageGeneration");
        imageGeneration = caps.imageGeneration;
      } catch (e) {
        capabilitiesError = errMsg(e);
      }
      // Read-only, optional: never consume reset credits or persist the raw response.
      readable = { models, imageGeneration, ...(capabilitiesError ? { capabilitiesError } : {}) };
      const quotaRaw = await call("account/rateLimits/read", undefined, Math.min(1000, timeoutMs / 4)).catch(() => null);
      finish(null, { models, imageGeneration, quotaRaw, ...(capabilitiesError ? { capabilitiesError } : {}) });
    })().catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
  });
}

async function discoverClaude(cfg: DuoConfig, cwd: string, baseEnv: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): Promise<ProviderCatalog> {
  const claude = resolveExecutable("claude", cfg.executors.claude.command, baseEnv);
  if (!claude.ok) return { ok: false, source: "claude", sourceKind: "none", error: claude.reason, attempts: [`claude: ${claude.reason}`], tools: [], models: [] };
  try {
    const resp = await claudeInitialize(claude, env, cwd);
    // `account` (e-mail/organização) é descartado: nunca é persistido.
    const models = parseClaudeInitialize(resp);
    if (!models.length) throw new Error("initialize não devolveu modelos");
    return { ok: true, source: "claude initialize (protocolo do Agent SDK, supportedModels)", sourceKind: "claude-initialize", stable: true, attempts: [], tools: [], models };
  } catch (e) {
    const error = `claude initialize: ${errMsg(e)}`;
    return { ok: false, source: "claude", sourceKind: "none", error, attempts: [error], tools: [], models: [] };
  }
}

async function discoverCodex(cfg: DuoConfig, cwd: string, baseEnv: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, appServerTimeoutMs?: number): Promise<ProviderCatalog> {
  const codex = resolveExecutable("codex", cfg.executors.codex.command, baseEnv);
  if (!codex.ok) return { ok: false, source: "codex", sourceKind: "none", error: codex.reason, attempts: [`codex: ${codex.reason}`], tools: [], models: [] };
  const attempts: string[] = [];
  const featureTools = () => parseCodexFeatures(runQuick(codex.command, [...codex.prefixArgs, "features", "list"], { env, cwd, timeoutMs: 20_000 }).stdout);

  // 1) Fonte estável: app-server model/list + modelProvider/capabilities/read.
  //    Dentro do sandbox do Codex ela não roda: o app-server precisa gravar em ~/.codex (installation_id,
  //    tmp/arg0), que ali é somente leitura, e não há opção para mudar isso. Vai direto ao fallback.
  if (inCodexSandbox(baseEnv)) {
    attempts.push("app-server pulado: dentro do sandbox do Codex o ~/.codex é somente leitura (refeito fora do sandbox)");
  } else {
    try {
      const r = await codexAppServer(codex, env, cwd, appServerTimeoutMs);
      let tools: string[];
      if (r.imageGeneration !== null) tools = r.imageGeneration ? ["image_generation"] : [];
      else {
        attempts.push(`modelProvider/capabilities/read indisponível (${r.capabilitiesError}); ferramentas lidas de codex features list`);
        tools = featureTools();
      }
      const models = parseCodexAppServerModels(r.models, tools);
      const quota = parseCodexQuota(r.quotaRaw, models, cfg.routing.adaptive.quotaWarnPercent);
      return {
        ...(quota ? { quota } : {}),
        ok: true,
        source: "codex app-server model/list (protocolo estável usado pela extensão e pelo app)",
        sourceKind: "codex-app-server",
        stable: true,
        attempts,
        tools,
        models,
      };
    } catch (e) {
      attempts.push(`app-server model/list: ${errMsg(e)}`);
    }
  }

  // 2) Fallback frágil: ferramenta de depuração.
  const tools = featureTools();
  const r = runQuick(codex.command, [...codex.prefixArgs, "debug", "models"], { env, cwd, timeoutMs: 30_000 });
  try {
    const models = parseCodexModels(JSON.parse(r.stdout), tools);
    if (!models.length) throw new Error("nenhum modelo visível");
    return { ok: true, source: "codex debug models (fallback; formato não contratual)", sourceKind: "codex-debug-models", stable: false, attempts, tools, models };
  } catch (e) {
    attempts.push(`debug models: ${r.ok ? errMsg(e) : redact(r.error ?? (r.stderr.trim().slice(0, 200) || `código ${r.code}`))}`);
  }
  return { ok: false, source: "codex", sourceKind: "none", error: attempts.join(" | "), attempts, tools: [], models: [] };
}

/** Se as fontes atuais falharem, reaproveita o último catálogo bom da conta (até 30 dias), marcado como desatualizado. */
function withLastKnownGood(provider: Provider, fresh: ProviderCatalog, previous: Catalog | null): ProviderCatalog {
  if (fresh.ok) return fresh;
  const prev = previous?.providers?.[provider];
  if (!prev?.ok || !prev.models?.length) return fresh;
  const since = prev.staleSince ?? previous?.discoveredAt ?? "";
  if (!since || Date.now() - Date.parse(since) > MAX_STALE_MS) return fresh;
  return { ...prev, stale: true, staleSince: since, attempts: fresh.attempts ?? (fresh.error ? [fresh.error] : []), error: fresh.error };
}

export async function discover(
  cfg: DuoConfig,
  cwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  previous: Catalog | null = null,
  opts: { appServerTimeoutMs?: number; cliVersions?: Catalog["cliVersions"] } = {},
): Promise<Catalog> {
  const { env } = childEnv(baseEnv);
  const [claude, codex] = await Promise.all([discoverClaude(cfg, cwd, baseEnv, env), discoverCodex(cfg, cwd, baseEnv, env, opts.appServerTimeoutMs)]);
  return {
    discoveredAt: new Date().toISOString(),
    cliVersions: opts.cliVersions ?? cliVersions(cfg, baseEnv),
    ...(inCodexSandbox(baseEnv) ? { discoveredInSandbox: true } : {}),
    providers: { claude: withLastKnownGood("claude", claude, previous), codex: withLastKnownGood("codex", codex, previous) },
  };
}

/** Versão instalada: usa a mesma execução curta e ambiente filtrado da detecção de caps. */
export function cliVersions(cfg: DuoConfig, baseEnv: NodeJS.ProcessEnv): Catalog["cliVersions"] {
  const { env } = childEnv(baseEnv);
  const versions: Catalog["cliVersions"] = { claude: null, codex: null };
  for (const p of ["claude", "codex"] as const) {
    const resolved = resolveExecutable(p, cfg.executors[p].command, baseEnv);
    if (!resolved.ok) continue;
    const r = runQuick(resolved.command, [...resolved.prefixArgs, "--version"], { env });
    versions[p] = r.ok ? parseVersion(r.stdout + r.stderr) : null;
  }
  return versions;
}

/** Só lê model; configurações inválidas ou inacessíveis não impedem a descoberta. */
function withUserModels(catalog: Catalog, cfg: DuoConfig, cwd: string, env: NodeJS.ProcessEnv): Catalog {
  const out = structuredClone(catalog);
  const paths = defaultAuthPaths(cwd, env);
  const configured: { provider: Provider; id: string }[] = cfg.routing.extraModels.map((m) => {
    const colon = m.indexOf(":");
    return { provider: m.slice(0, colon) as Provider, id: m.slice(colon + 1) };
  });
  try {
    const model = codexConfiguredModel(paths, env);
    if (model) configured.push({ provider: "codex", id: model });
  } catch { /* config inacessível */ }
  try {
    const settings = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR ?? join(paths.home, ".claude"), "settings.json"), "utf8")) as { model?: unknown } | null;
    if (typeof settings?.model === "string") configured.push({ provider: "claude", id: settings.model });
  } catch { /* JSON inválido ou ausente */ }
  for (const pc of Object.values(out.providers)) {
    pc.models = pc.models.filter((m) => m.source !== "user-config").map((m) => ({ ...m, source: "discovered" }));
  }
  for (const { provider, id } of configured) {
    if (!/^[A-Za-z0-9._:\[\]-]{1,80}(?![\s\S])/.test(id) || findModel(out, provider, id)) continue;
    out.providers[provider].models.push({ provider, id, aliases: [], displayName: id, description: "", efforts: [], contextWindow: null, vendorRecommended: false, legacy: false, capabilities: ["code"], source: "user-config" });
  }
  return out;
}

/** A fase 2 pode forçar redescoberta após uma recusa de modelo. */
export function invalidateCatalog(store: Store): void {
  rmSync(catalogPath(store), { force: true });
}

export function catalogPath(store: Store): string {
  return join(store.base, "models.json");
}

/** 6 h com fontes estáveis; 1 h quando alguma conta usou fallback, falhou ou está com cache desatualizado. */
export function catalogTtlMs(c: Catalog): number {
  const degraded = Object.values(c.providers ?? {}).some((pc) => !pc.ok || pc.stale || pc.stable === false);
  return degraded ? DEGRADED_TTL_MS : TTL_MS;
}

/** Catálogo em cache (6 h, ou 1 h se degradado). `refresh` força nova descoberta. */
export async function loadCatalog(store: Store, cfg: DuoConfig, opts: { refresh?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Catalog> {
  const cached = readJson<Catalog>(catalogPath(store));
  const valid = cached && typeof cached.discoveredAt === "string" && cached.providers ? cached : null;
  const env = opts.env ?? process.env;
  const versions = cliVersions(cfg, env);
  const versionsMatch = valid?.cliVersions && (["claude", "codex"] as const).every((p) => valid.cliVersions[p] === versions[p]);
  const upgradeFromSandbox = Boolean(valid?.discoveredInSandbox) && !inCodexSandbox(env);
  if (!opts.refresh && valid && versionsMatch && !upgradeFromSandbox && Date.now() - Date.parse(valid.discoveredAt) < catalogTtlMs(valid)) return withUserModels(valid, cfg, store.projectRoot, env);
  const fresh = await discover(cfg, store.projectRoot, env, valid, { cliVersions: versions });
  if (fresh.providers.codex.quota && !fresh.providers.codex.stale) saveQuota(store, "codex", fresh.providers.codex.quota);
  writeJsonAtomic(catalogPath(store), fresh);
  return withUserModels(fresh, cfg, store.projectRoot, env);
}

/** Último catálogo gravado, mesmo expirado (só para exibição, sem disparar descoberta). */
export function cachedCatalog(store: Store): Catalog | null {
  const c = readJson<Catalog>(catalogPath(store));
  return c && typeof c.discoveredAt === "string" && c.providers ? c : null;
}

/**
 * Identidade de modelo, única para todo o duo. Sufixo de data (-20251001) não muda o modelo; variante entre
 * colchetes ([1m]) muda (tem cobrança própria) e é preservada. Alias de família sem versão ("opus", "sonnet")
 * não é uma identidade: só vale depois de resolvido pelo catálogo.
 */
export function modelKey(name: string): string {
  const n = name.trim().toLowerCase();
  const variant = /(\[[^\]]*\])$/.exec(n)?.[1] ?? "";
  const base = n.slice(0, n.length - variant.length).replace(/-\d{8}$/, "");
  return base + variant;
}

export const FAMILY_ALIAS = /^(opus|sonnet|haiku|fable)$/i;

export function findModel(catalog: Catalog, provider: Provider, name: string): ModelInfo | null {
  const n = name.trim().toLowerCase();
  const models = catalog.providers[provider]?.models ?? [];
  const exact = models.find((m) => m.id.toLowerCase() === n || m.aliases.some((a) => a.toLowerCase() === n));
  if (exact || FAMILY_ALIAS.test(n)) return exact ?? null;
  // ID com ou sem sufixo de data: mesma identidade (a variante [..] precisa coincidir).
  const key = modelKey(n);
  return models.find((m) => modelKey(m.id) === key) ?? null;
}

/**
 * Mesma identidade? Com catálogo, compara os IDs resolvidos. Sem catálogo (ou nome não resolvido), compara modelKey;
 * um alias de família não resolvido só casa quando `family: "loose"` (usado apenas para bloquear, nunca para autorizar).
 */
/**
 * O modelo informado pela execução corresponde ao pedido? Igual a sameModelIdentity estrita, com uma assimetria:
 * o cliente pode OMITIR a variante (o Claude Code remove "[1m]" antes da API e registra o nome servido), então um
 * relatório sem colchetes casa com o pedido "[1m]" do mesmo modelo; o relatório ACRESCENTAR uma variante não
 * pedida (ex.: pedido base, execução "[1m]") nunca casa: é outro modelo, com cobrança própria.
 */
export function reportedMatchesRequested(catalog: Catalog | null, provider: Provider, requested: string, reported: string): boolean {
  if (sameModelIdentity(catalog, provider, requested, reported, "strict")) return true;
  const resolve = (name: string) => (catalog && findModel(catalog, provider, name)?.id) ?? name;
  const req = modelKey(resolve(requested)), rep = modelKey(resolve(reported));
  return !rep.includes("[") && req.includes("[") && req.replace(/\[[^\]]*\]$/, "") === rep;
}

export function sameModelIdentity(catalog: Catalog | null, provider: Provider, a: string, b: string, family: "strict" | "loose" = "strict"): boolean {
  const resolve = (name: string) => (catalog && findModel(catalog, provider, name)?.id) ?? name;
  const ra = resolve(a), rb = resolve(b);
  if (modelKey(ra) === modelKey(rb)) return true;
  if (family === "loose") {
    // Alias de família não resolvido casa com qualquer modelo base dessa família (nunca com variante paga).
    const inFamily = (alias: string, id: string) => FAMILY_ALIAS.test(alias) && !id.includes("[") && new RegExp(`(^|-)${alias.toLowerCase()}(-|$)`).test(modelKey(id));
    if (inFamily(ra, rb) || inFamily(rb, ra)) return true;
  }
  return false;
}

/** Resumo de uma linha da origem do catálogo de uma conta. */
export function describeSource(pc: ProviderCatalog): string {
  if (!pc.ok) return `indisponível: ${pc.error ?? "sem detalhes"}`;
  const kind =
    pc.sourceKind === "codex-app-server" ? "app-server model/list" : pc.sourceKind === "codex-debug-models" ? "debug models" : pc.sourceKind === "claude-initialize" ? "initialize" : pc.source;
  const quality = pc.stale ? `cache de ${pc.staleSince} — fontes atuais falharam` : pc.stable === false ? "fallback frágil" : "estável";
  return `${pc.models.length} modelos${pc.tools.length ? ` + ${pc.tools.join(", ")}` : ""} via ${kind} (${quality})`;
}

export function formatCatalog(c: Catalog, cfg: DuoConfig = DEFAULT_CONFIG): string {
  const lines = [`Modelos disponíveis nas contas conectadas (descoberto em ${c.discoveredAt}):`];
  for (const [p, pc] of Object.entries(c.providers)) {
    lines.push(`\n[${p}] ${pc.ok ? pc.source : `indisponível: ${pc.error}`}${pc.tools.length ? ` | ferramentas: ${pc.tools.join(", ")}` : ""}`);
    if (pc.stale) lines.push(`  aviso: catálogo desatualizado (de ${pc.staleSince}); as fontes atuais falharam. A ponte não bloqueia modelos fora desta lista.`);
    else if (pc.ok && pc.stable === false) lines.push("  aviso: fonte frágil (fallback); a fonte estável falhou ou não roda neste ambiente.");
    for (const a of pc.ok ? (pc.attempts ?? []) : []) lines.push(`  fonte que falhou: ${a}`);
    for (const m of pc.models) {
      const level = tierOf(m, cfg);
      const flags = [
        `nível ${level.tier}${level.presumed ? " (presumido)" : ""}`,
        `esforços: ${m.efforts.join(", ") || "não informados"}`,
        extraUsage(m) ? "uso extra" : "",
        m.source === "user-config" ? "(configurado pelo usuário; não listado pela CLI)" : "",
        m.vendorRecommended ? "recomendado pelo fornecedor" : "",
        m.legacy ? `legado${m.upgradeTo ? ` → ${m.upgradeTo}` : ""}${m.retirementAt ? `, aposentadoria ${m.retirementAt.slice(0, 10)}` : ""}` : "",
        m.capabilities.includes("image_generation") ? "gera imagem (ferramenta)" : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`  ${m.id.padEnd(28)} ${m.displayName} — ${m.description}${flags ? ` [${flags}]` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Verificação de contrato sem inferência nem rede: gera o JSON Schema do protocolo do app-server
 * (`codex app-server generate-json-schema`, que exclui métodos experimentais) e confere que os métodos
 * e campos usados pela descoberta continuam na superfície estável. Detecta mudança antes de quebrar.
 */
export function checkCodexCatalogContract(command: string, prefixArgs: string[], env: NodeJS.ProcessEnv): { ok: boolean; problems: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "duo-codex-schema-"));
  try {
    const r = runQuick(command, [...prefixArgs, "app-server", "generate-json-schema", "--out", dir], { env, timeoutMs: 20_000 });
    if (!r.ok) return { ok: false, problems: [`generate-json-schema falhou: ${redact(r.error ?? (r.stderr.trim().split("\n").at(-1)?.slice(0, 200) || `código ${r.code}`))}`] };
    const problems: string[] = [];
    type Schema = { oneOf?: { properties?: { method?: { enum?: string[] } } }[]; required?: string[]; properties?: Record<string, unknown>; definitions?: Record<string, Schema> };
    const req = readJson<Schema>(join(dir, "ClientRequest.json"));
    const methods = new Set((req?.oneOf ?? []).flatMap((v) => v.properties?.method?.enum ?? []));
    for (const m of ["initialize", "model/list", "modelProvider/capabilities/read"]) if (!methods.has(m)) problems.push(`método ${m} fora da superfície estável`);
    const model = readJson<Schema>(join(dir, "v2", "ModelListResponse.json"))?.definitions?.Model;
    if (!model) problems.push("schema de model/list não encontrado (v2/ModelListResponse.json)");
    else {
      for (const k of ["id", "displayName", "hidden", "isDefault"]) if (!model.required?.includes(k)) problems.push(`Model.${k} deixou de ser obrigatório`);
      for (const k of ["model", "description", "supportedReasoningEfforts", "upgrade", "upgradeInfo"]) if (!(k in (model.properties ?? {}))) problems.push(`Model.${k} saiu do schema (informação opcional perdida)`);
    }
    const caps = readJson<Schema>(join(dir, "v2", "ModelProviderCapabilitiesReadResponse.json"));
    if (!caps?.required?.includes("imageGeneration")) problems.push("imageGeneration saiu de modelProvider/capabilities/read");
    return { ok: problems.length === 0, problems };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
