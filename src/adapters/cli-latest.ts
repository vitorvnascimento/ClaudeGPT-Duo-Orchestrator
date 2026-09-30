// Consulta pública ao npm: somente versões, nunca instalação nem credenciais.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { DuoConfig, Provider } from "../config.js";
import { type Store, writeJsonAtomic } from "../state/store.js";
import { compareVersions, currentVersion, updateCheckDisabled } from "../update.js";

const TTL_MS = 6 * 60 * 60 * 1000;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?![\s\S])/;
const PACKAGES: Record<Provider, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };
export type CliLatest = { checkedAt: string; versions: Record<Provider, string | null> };
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "error" }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export async function fetchCliLatest(provider: Provider, fetchImpl: FetchLike = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${PACKAGES[provider].replace("/", "%2F")}/latest`, {
      headers: { Accept: "application/json", "User-Agent": `duo-orchestrator/${currentVersion()}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!res.ok) return null;
    const body = await res.json() as { version?: unknown } | null;
    return typeof body?.version === "string" && VERSION.test(body.version) ? body.version : null;
  } catch { return null; }
}

/** Arquivo regular e limitado, sem seguir links nem esperar em FIFO (padrão do update.ts). */
function readCache(path: string): CliLatest | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)); }
  catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const buf = Buffer.alloc(st.size);
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    const c = JSON.parse(text) as CliLatest | null;
    if (!c || typeof c.checkedAt !== "string" || !Number.isFinite(Date.parse(c.checkedAt)) || !c.versions) return null;
    if (!["claude", "codex"].every((p) => {
      const value = c.versions[p as Provider];
      return value === null || (typeof value === "string" && VERSION.test(value));
    })) return null;
    return { checkedAt: c.checkedAt, versions: { claude: c.versions.claude, codex: c.versions.codex } };
  } catch { return null; }
  finally { closeSync(fd); }
}

export async function loadCliLatest(store: Store, cfg: DuoConfig, opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: number } = {}): Promise<CliLatest | null> {
  const env = opts.env ?? process.env;
  if (!cfg.discovery.checkCliUpdates || updateCheckDisabled(env) || env.CODEX_SANDBOX_NETWORK_DISABLED === "1") return null;
  const now = opts.now ?? Date.now();
  const path = join(store.base, "cli-latest.json");
  const cached = readCache(path);
  const age = cached ? now - Date.parse(cached.checkedAt) : Infinity;
  if (cached && age >= 0 && age < TTL_MS) return cached;
  const [claude, codex] = await Promise.all([fetchCliLatest("claude", opts.fetchImpl), fetchCliLatest("codex", opts.fetchImpl)]);
  const result: CliLatest = { checkedAt: new Date(now).toISOString(), versions: { claude, codex } };
  try { writeJsonAtomic(path, result); } catch { /* aviso nunca impede um comando */ }
  return result;
}

export function cliUpdateWarnings(installed: Record<Provider, string | null>, latest: CliLatest | null): string[] {
  return (["claude", "codex"] as const).flatMap((p) => {
    const current = installed[p], published = latest?.versions[p];
    if (!current || !VERSION.test(current) || !published || !VERSION.test(published) || compareVersions(current, published) >= 0) return [];
    return [`CLI ${p} desatualizada (${current} < ${published}): modelos mais novos podem não aparecer. Atualize com: npm i -g ${PACKAGES[p]}@latest`];
  });
}
