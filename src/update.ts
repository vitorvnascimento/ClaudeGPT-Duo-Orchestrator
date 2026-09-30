// Aviso de nova versão: consulta pública e anônima à última release do GitHub, sem credenciais.
//
// Garantias: a requisição não leva token, cookie nem variável de ambiente (só Accept e User-Agent); nada da resposta
// é exibido sem validação (versão x.y.z, URL do .tgz do próprio repositório); a consulta roda no máximo a cada 24 h,
// em segundo plano, e nunca atrasa um comando; nunca roda dentro de um executor (DUO_DEPTH) nem com
// DUO_NO_UPDATE_CHECK=1 ou CI. A instalação só acontece com `duo update --apply`, pedida pelo usuário.
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { cliEntry, packageRoot } from "./paths.js";

export const UPDATE_REPO = "vitorvnascimento/duo-orchestrator";
const LATEST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Uma reserva (lock) mais velha que isto é de um processo que morreu: pode ser retomada. */
const STALE_LOCK_MS = 10 * 60 * 1000;
const MAX_CACHE_BYTES = 64 * 1024;
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

export type LatestRelease = { version: string; tarballUrl: string; pageUrl: string };
export type UpdateCache = { checkedAt: string; ok: boolean; latest: LatestRelease | null };
type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "follow" | "error" }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export function currentVersion(): string {
  return (JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string }).version;
}

export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a), pb = VERSION.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Valida a resposta da API: só aceita release estável deste repositório com o .tgz esperado. */
export function parseLatestRelease(body: unknown): LatestRelease | null {
  if (!body || typeof body !== "object") return null;
  const r = body as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (r.draft !== false || r.prerelease !== false || typeof r.tag_name !== "string") return null;
  const tag = /^v(\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(r.tag_name);
  if (!tag) return null;
  const version = tag[1] as string;
  const tarballUrl = `https://github.com/${UPDATE_REPO}/releases/download/v${version}/duo-orchestrator-${version}.tgz`;
  const assets = Array.isArray(r.assets) ? r.assets : [];
  if (!assets.some((a) => a && typeof a === "object" && (a as { browser_download_url?: unknown }).browser_download_url === tarballUrl)) return null;
  return { version, tarballUrl, pageUrl: `https://github.com/${UPDATE_REPO}/releases/tag/v${version}` };
}

export async function fetchLatestRelease(fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 5000): Promise<LatestRelease | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  // Cabeçalhos fixos e explícitos: nenhuma credencial (GITHUB_TOKEN, gh, cookies) sai daqui.
  const res = await fetchImpl(LATEST_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `duo-orchestrator/${currentVersion()}` },
    signal,
    redirect: "error",
  });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
  return parseLatestRelease(await res.json());
}

export function updateCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(env.HOME || homedir(), ".cache");
  return join(base, "duo-orchestrator", "update-check.json");
}

/** Lê o cache sem nunca bloquear: só arquivo regular, pequeno, aberto sem espera (um FIFO no lugar não trava o comando). */
function readSmallRegularFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CACHE_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function readUpdateCache(env: NodeJS.ProcessEnv = process.env): UpdateCache | null {
  try {
    const text = readSmallRegularFile(updateCachePath(env));
    if (text === null) return null;
    const c = JSON.parse(text) as UpdateCache;
    if (typeof c.checkedAt !== "string" || Number.isNaN(Date.parse(c.checkedAt))) return null;
    const latest = c.latest && VERSION.test(c.latest.version) ? parseLatestRelease({
      tag_name: `v${c.latest.version}`, draft: false, prerelease: false, assets: [{ browser_download_url: c.latest.tarballUrl }],
    }) : null;
    return { checkedAt: c.checkedAt, ok: c.ok === true, latest };
  } catch {
    return null;
  }
}

function writeUpdateCache(cache: UpdateCache, env: NodeJS.ProcessEnv): void {
  const path = updateCachePath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, path);
}

function lockPath(env: NodeJS.ProcessEnv): string {
  return `${updateCachePath(env)}.lock`;
}

/** Reserva atômica da consulta: só um processo por vez consulta (O_EXCL); reserva órfã expira. */
export function reserveUpdateCheck(env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const lock = lockPath(env);
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (now - statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
        unlinkSync(lock);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseUpdateCheck(env: NodeJS.ProcessEnv = process.env): void {
  try {
    unlinkSync(lockPath(env));
  } catch {
    /* já liberada */
  }
}

/** Tenta a reserva por até `waitMs` (o trabalhador em segundo plano costuma terminar em poucos segundos). */
export async function acquireUpdateCheck(env: NodeJS.ProcessEnv = process.env, waitMs = 6000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (reserveUpdateCheck(env)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Consulta agora. Só grava o cache com `write` (o chamador precisa ter a reserva): todas as gravações ficam
 * serializadas, e uma falha nunca sobrescreve um sucesso recente.
 */
export async function refreshUpdateCache(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike, now = Date.now(), write = true): Promise<UpdateCache> {
  let cache: UpdateCache;
  try {
    cache = { checkedAt: new Date(now).toISOString(), ok: true, latest: await fetchLatestRelease(fetchImpl) };
  } catch {
    // Relido na hora de gravar: uma consulta concorrente que deu certo não é apagada por esta falha.
    const current = readUpdateCache(env);
    if (current?.ok && now - Date.parse(current.checkedAt) < CHECK_INTERVAL_MS) return current;
    cache = { checkedAt: new Date(now).toISOString(), ok: false, latest: current?.latest ?? null };
  }
  if (write) writeUpdateCache(cache, env);
  return cache;
}

/**
 * Ambiente do `npm install -g` de `duo update --apply`: só o necessário para o npm achar o próprio prefixo e o cache.
 * Tokens, proxies e variáveis npm_config_* do shell não passam; o npm ainda lê o ~/.npmrc do usuário, como sempre.
 */
export function installerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TMPDIR", "TEMP", "TMP", "NVM_DIR", "NVM_BIN"];
  return Object.fromEntries(keep.filter((k) => typeof env[k] === "string").map((k) => [k, env[k] as string]));
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DUO_NO_UPDATE_CHECK === "1" || Boolean(env.DUO_DEPTH) || Boolean(env.CI) || Boolean(env.CODEX_SANDBOX);
}

export function cacheIsStale(cache: UpdateCache | null, now = Date.now()): boolean {
  if (!cache) return true;
  // Falhas também esperam 24 h: sem rede, o duo não fica tentando a cada comando.
  return now - Date.parse(cache.checkedAt) >= CHECK_INTERVAL_MS;
}

export function updateNotice(cache: UpdateCache | null, current: string): string | null {
  const latest = cache?.latest;
  if (!latest || compareVersions(latest.version, current) <= 0) return null;
  return `duo: nova versão ${latest.version} disponível (instalada: ${current}). Novidades: ${latest.pageUrl}\n` +
    `     Atualize com: duo update --apply   (desligar aviso: DUO_NO_UPDATE_CHECK=1)`;
}

/**
 * Chamado a cada comando: mostra o aviso (stderr, para não quebrar saídas --json) a partir do cache e, se o cache
 * estiver velho, dispara a consulta num processo separado que não segura o terminal.
 */
export function checkForUpdatesInBackground(env: NodeJS.ProcessEnv = process.env, write = (s: string): void => { process.stderr.write(s); }): void {
  if (updateCheckDisabled(env)) return;
  try {
    const cache = readUpdateCache(env);
    const notice = updateNotice(cache, currentVersion());
    if (notice) write(`${notice}\n`);
    // Relido depois da reserva: outro processo pode ter acabado de consultar e liberado.
    if (cacheIsStale(cache) && reserveUpdateCheck(env)) {
      if (!cacheIsStale(readUpdateCache(env))) {
        releaseUpdateCheck(env);
        return;
      }
      const child = spawn(process.execPath, [cliEntry(), "update", "--check", "--quiet"], {
        detached: true,
        stdio: "ignore",
        env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "", ...(env.XDG_CACHE_HOME ? { XDG_CACHE_HOME: env.XDG_CACHE_HOME } : {}), DUO_UPDATE_WORKER: "1" },
      });
      child.on("error", () => releaseUpdateCheck(env));
      child.unref();
    }
  } catch {
    /* aviso de versão nunca atrapalha um comando */
  }
}
