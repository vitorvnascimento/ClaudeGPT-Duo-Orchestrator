// Estado nativo do executor Gemini: um HOME privado por cadeia, fora do projeto e do .duo/.
// O agy grava conversas, logs e cache ali (verificado: o ~/.gemini do usuário fica intacto). Só
// Library/Keychains aponta para o real, que é onde está o login da assinatura.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type ChainClass = "active" | "resumable" | "terminal" | "orphan";

function realHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
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
  if (!existsSync(owner)) writeFileSync(owner, `${JSON.stringify({ projectRoot, chainId, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  return dir;
}

export function createPrivateHome(chainDir: string, env: NodeJS.ProcessEnv = process.env): { home: string } {
  const home = join(chainDir, "home");
  mkdirSync(join(home, "Library"), { recursive: true, mode: 0o700 });
  const kc = join(home, "Library", "Keychains");
  // lstat: um link para Keychains inexistente é "quebrado" para existsSync, mas já existe.
  let linked = true;
  try { lstatSync(kc); } catch { linked = false; }
  if (!linked) symlinkSync(join(realHome(env), "Library", "Keychains"), kc);
  const cfgDir = join(home, ".gemini", "config");
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const cfg = join(cfgDir, "config.json");
  // O plugin embutido "swarm" vem ligado por padrão num HOME novo (observado no agy 1.5.3).
  if (!existsSync(cfg)) writeFileSync(cfg, `${JSON.stringify({ plugins: { swarm: { enabled: false } } }, null, 2)}\n`, { mode: 0o600 });
  return { home };
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
    if (!statSync(hd).isDirectory()) continue;
    for (const c of readdirSync(hd)) {
      const dir = join(hd, c);
      try {
        const o = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as { projectRoot: string; chainId: string };
        out.push({ dir, projectRoot: o.projectRoot, chainId: o.chainId, mtimeMs: statSync(join(dir, "owner.json")).mtimeMs });
      } catch { /* diretório sem dono legível: ignorado (não é nosso para apagar) */ }
    }
  }
  return out;
}

export function removeChainState(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Caminho esperado do estado de uma cadeia (sem criar nada). */
export function chainStatePath(projectRoot: string, chainId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(geminiStateRoot(env), createHash("sha256").update(projectRoot).digest("hex").slice(0, 12), chainId);
}

/**
 * Remoção a partir de um caminho guardado (task.geminiStateDir): só apaga se o caminho resolvido for exatamente o
 * esperado para este projeto e esta cadeia dentro da raiz de estado, com owner.json coerente e sem uso ativo.
 */
export function removeChainStateSafe(dir: string, projectRoot: string, chainId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const expected = chainStatePath(projectRoot, chainId, env);
    if (realpathSync(dir) !== realpathSync(expected)) return false;
    const owner = JSON.parse(readFileSync(join(expected, "owner.json"), "utf8")) as { projectRoot?: unknown; chainId?: unknown };
    if (owner.projectRoot !== projectRoot || owner.chainId !== chainId) return false;
    return withChainLock(expected, () => {
      if (anyAttemptAlive(expected) || anyClaimAlive(expected)) return false;
      rmSync(expected, { recursive: true, force: true });
      return true;
    }) ?? false;
  } catch {
    return false;
  }
}

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Trava curta por cadeia (prune.lock), compartilhada por quem usa o estado e pela limpeza. null = não obtida. */
export function withChainLock<T>(chainDir: string, fn: () => T, waitMs = 5000): T | null {
  const lock = join(chainDir, "prune.lock");
  const until = Date.now() + waitMs;
  for (;;) {
    let fd: number;
    try { fd = openSync(lock, "wx"); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // diretório sumiu
      try {
        const holder = Number(readFileSync(lock, "utf8"));
        if (holder && !isAlive(holder)) { rmSync(lock, { force: true }); continue; }
      } catch { /* trava sendo criada: espera */ }
      if (Date.now() > until) return null;
      sleepMs(50);
      continue;
    }
    try { writeFileSync(lock, String(process.pid)); return fn(); }
    finally { closeSync(fd); rmSync(lock, { force: true }); }
  }
}

/** Marca o estado da cadeia como em uso (delegação ou descoberta). A limpeza nunca apaga com marca viva. */
export function claimChainState(chainDir: string): () => void {
  const marker = join(chainDir, `inuse-${process.pid}-${randomBytes(4).toString("hex")}.json`);
  const ok = withChainLock(chainDir, () => { writeFileSync(marker, JSON.stringify({ pid: process.pid })); return true; });
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
    const gone = withChainLock(s.dir, () => {
      if (!eligible(effective(s.projectRoot, s.chainId, s.dir), s.mtimeMs)) return false;
      removeChainState(s.dir);
      return true;
    }, 0);
    if (gone) removed.push(s.dir);
  }
  return removed;
}
