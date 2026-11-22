// Estado nativo do executor Gemini: um HOME privado por cadeia, fora do projeto e do .duo/.
// O agy grava conversas, logs e cache ali (verificado: o ~/.gemini do usuário fica intacto). Só
// Library/Keychains aponta para o real, que é onde está o login da assinatura.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { withFileLock } from "./store.js";
import { basename, dirname, join } from "node:path";

export type ChainClass = "active" | "resumable" | "terminal" | "orphan";

function realHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

function writeOnce(path: string, data: string): void {
  try { writeFileSync(path, data, { mode: 0o600, flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
}

export function geminiStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === "darwin"
    ? join(realHome(env), "Library", "Application Support", "duo", "gemini-state")
    : join(env.XDG_STATE_HOME ?? join(realHome(env), ".local", "state"), "duo", "gemini-state");
}

export function chainStateDir(projectRoot: string, chainId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(chainId)) throw new Error(`chainId inválido: ${chainId}`);
  const dir = join(geminiStateRoot(env), createHash("sha256").update(projectRoot).digest("hex").slice(0, 12), chainId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = join(dir, "owner.json");
  // "wx": dois processos criando a mesma cadeia ao mesmo tempo; o segundo encontra o arquivo e segue.
  if (!existsSync(owner)) writeOnce(owner, `${JSON.stringify({ projectRoot, chainId, createdAt: new Date().toISOString() })}\n`);
  return dir;
}

export function createPrivateHome(chainDir: string, env: NodeJS.ProcessEnv = process.env): { home: string } {
  const home = join(chainDir, "home");
  mkdirSync(join(home, "Library"), { recursive: true, mode: 0o700 });
  const kc = join(home, "Library", "Keychains");
  // lstat: um link para Keychains inexistente é "quebrado" para existsSync, mas já existe.
  let linked = true;
  try { lstatSync(kc); } catch { linked = false; }
  if (!linked) {
    try { symlinkSync(join(realHome(env), "Library", "Keychains"), kc); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  const cfgDir = join(home, ".gemini", "config");
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const cfg = join(cfgDir, "config.json");
  // O plugin embutido "swarm" vem ligado por padrão num HOME novo (observado no agy 1.5.3).
  if (!existsSync(cfg)) writeOnce(cfg, `${JSON.stringify({ plugins: { swarm: { enabled: false } } }, null, 2)}\n`);
  return { home };
}

/** Marca de último uso (claim e tentativa): a idade do prune conta a partir dela, não da criação. */
const LAST_USED = "last-used";
function touchLastUsed(chainDir: string): void {
  try { writeFileSync(join(chainDir, LAST_USED), `${new Date().toISOString()}\n`, { mode: 0o600 }); } catch { /* sem marca: vale a criação */ }
}

/** Último uso da cadeia: o mais recente entre a criação (owner.json) e a marca de uso. */
export function lastUsedMs(chainDir: string): number {
  const at = (name: string) => { try { return statSync(join(chainDir, name)).mtimeMs; } catch { return 0; } };
  return Math.max(at("owner.json"), at(LAST_USED));
}

const isAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

function attemptsDir(chainDir: string): string {
  return join(chainDir, "home", "tmp");
}

export function attemptTmpDir(chainDir: string): { path: string; setChildPid(pid: number): void; cleanup(): void } {
  const path = join(attemptsDir(chainDir), `attempt-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  touchLastUsed(chainDir);
  const meta = join(path, "attempt.json");
  const write = (childPid: number | null) => writeFileSync(meta, JSON.stringify({ bridgePid: process.pid, childPid }));
  write(null);
  return { path, setChildPid: (pid) => write(pid), cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

function attemptAlive(dir: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(dir, "attempt.json"), "utf8")) as { bridgePid?: unknown; childPid?: unknown };
    return isAlive(m.bridgePid) || isAlive(m.childPid);
  } catch { return false; }
}

/** Remove tentativas cuja ponte E cujo executor (que roda destacado e pode sobreviver à ponte) já morreram. */
export function sweepStaleAttempts(chainDir: string): string[] {
  const base = attemptsDir(chainDir);
  if (!existsSync(base)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    if (!name.startsWith("attempt-") || attemptAlive(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

function anyAttemptAlive(chainDir: string): boolean {
  const base = attemptsDir(chainDir);
  return existsSync(base) && readdirSync(base).some((n) => n.startsWith("attempt-") && attemptAlive(join(base, n)));
}

export function listGeminiStates(env: NodeJS.ProcessEnv = process.env): { dir: string; projectRoot: string; chainId: string; mtimeMs: number }[] {
  const root = geminiStateRoot(env);
  if (!existsSync(root)) return [];
  const out: { dir: string; projectRoot: string; chainId: string; mtimeMs: number }[] = [];
  for (const h of readdirSync(root)) {
    const hd = join(root, h);
    // Links nunca são seguidos: nem a pasta do projeto nem a da cadeia.
    if (!lstatSync(hd).isDirectory()) continue;
    for (const c of readdirSync(hd)) {
      const dir = join(hd, c);
      try {
        if (!lstatSync(dir).isDirectory()) continue;
        const o = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as { projectRoot: string; chainId: string };
        out.push({ dir, projectRoot: o.projectRoot, chainId: o.chainId, mtimeMs: lastUsedMs(dir) });
      } catch { /* diretório sem dono legível: ignorado (não é nosso para apagar) */ }
    }
  }
  return out;
}

export function removeChainState(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Caminho esperado do estado de uma cadeia (sem criar nada). */
const CHAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function projectStateDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(geminiStateRoot(env), createHash("sha256").update(projectRoot).digest("hex").slice(0, 12));
}

export function chainStatePath(projectRoot: string, chainId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!CHAIN_ID.test(chainId) || chainId.includes("..")) throw new Error(`chainId inválido: ${chainId}`);
  return join(projectStateDir(projectRoot, env), chainId);
}

/**
 * Remoção a partir de um caminho guardado (task.geminiStateDir): só apaga se o caminho resolvido for exatamente o
 * esperado para este projeto e esta cadeia dentro da raiz de estado, com owner.json coerente e sem uso ativo.
 */
/**
 * O caminho é exatamente o estado desta cadeia deste projeto? Diretório real (não link), filho direto da pasta canônica
 * do projeto (hash do projectRoot) com o nome da cadeia, e owner.json coerente. Devolve o caminho esperado ou null.
 */
function validChainDir(dir: string, projectRoot: string, chainId: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const expected = chainStatePath(projectRoot, chainId, env);
    if (lstatSync(dir).isSymbolicLink() || lstatSync(expected).isSymbolicLink()) return null;
    const real = realpathSync(dir);
    if (dirname(real) !== realpathSync(projectStateDir(projectRoot, env)) || real !== realpathSync(expected)) return null;
    const owner = JSON.parse(readFileSync(join(expected, "owner.json"), "utf8")) as { projectRoot?: unknown; chainId?: unknown };
    return owner.projectRoot === projectRoot && owner.chainId === chainId ? expected : null;
  } catch {
    return null;
  }
}

export function removeChainStateSafe(dir: string, projectRoot: string, chainId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = validChainDir(dir, projectRoot, chainId, env);
  if (!expected) return false;
  return withChainLock(expected, () => {
    // Revalida com a trava pega: o caminho não pode ter sido trocado por um link no meio.
    if (validChainDir(dir, projectRoot, chainId, env) !== expected || anyAttemptAlive(expected) || anyClaimAlive(expected)) return false;
    rmSync(expected, { recursive: true, force: true });
    return true;
  }) ?? false;
}


/**
 * Trava curta por cadeia, compartilhada por quem usa o estado e pela limpeza. Usa o withFileLock do store (recuperação
 * de trava morta por geração) num arquivo IRMÃO do diretório (<cadeia>.lock), que sobrevive à remoção da cadeia.
 * null = trava não obtida no prazo ou erro de sistema de arquivos.
 */
export function withChainLock<T>(chainDir: string, fn: () => T, waitMs = 5000): T | null {
  if (!existsSync(chainDir)) return null;
  try { return withFileLock(`${chainDir}.lock`, waitMs, fn); }
  catch { return null; }
}

/** Marca o estado da cadeia como em uso (delegação ou descoberta). A limpeza nunca apaga com marca viva. */
export function claimChainState(chainDir: string): () => void {
  const marker = join(chainDir, `inuse-${process.pid}-${randomBytes(4).toString("hex")}.json`);
  const ok = withChainLock(chainDir, () => { writeFileSync(marker, JSON.stringify({ pid: process.pid })); touchLastUsed(chainDir); return true; });
  if (!ok) throw new Error(`estado do gemini ocupado pela limpeza: ${chainDir}`);
  return () => rmSync(marker, { force: true });
}

function anyClaimAlive(chainDir: string): boolean {
  if (!existsSync(chainDir)) return false;
  return readdirSync(chainDir).some((n) => {
    if (!n.startsWith("inuse-")) return false;
    try { return isAlive((JSON.parse(readFileSync(join(chainDir, n), "utf8")) as { pid?: unknown }).pid); } catch { return false; }
  });
}

/**
 * Apaga estados terminais e órfãos; retomáveis só com olderThanDays; ativos nunca. A classe é conferida de novo
 * com a trava da cadeia pega, logo antes de apagar, e um executor vivo registrado conta como ativo.
 */
export function pruneGeminiStates(
  opts: { olderThanDays?: number; classify(projectRoot: string, chainId: string): ChainClass },
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const removed: string[] = [];
  const effective = (projectRoot: string, chainId: string, dir: string): ChainClass => {
    if (anyAttemptAlive(dir) || anyClaimAlive(dir)) return "active";
    if (!existsSync(join(projectRoot, ".duo"))) return "orphan";
    return opts.classify(projectRoot, chainId);
  };
  const eligible = (cls: ChainClass, mtimeMs: number) =>
    cls === "terminal" || cls === "orphan" || (cls === "resumable" && opts.olderThanDays !== undefined && Date.now() - mtimeMs >= opts.olderThanDays * 86400_000);
  for (const s of listGeminiStates(env)) {
    if (!eligible(effective(s.projectRoot, s.chainId, s.dir), s.mtimeMs)) continue;
    // Só apaga o caminho validado (nome, hash do projeto, dono, sem link), conferido de novo com a trava pega.
    if (!validChainDir(s.dir, s.projectRoot, s.chainId, env)) continue;
    const gone = withChainLock(s.dir, () => {
      const expected = validChainDir(s.dir, s.projectRoot, s.chainId, env);
      if (!expected || !eligible(effective(s.projectRoot, s.chainId, expected), lastUsedMs(expected))) return false;
      removeChainState(expected);
      return true;
    }, 0);
    if (gone) removed.push(s.dir);
  }
  return removed;
}
