// Estado nativo do executor Gemini: um HOME privado por cadeia, fora do projeto e do .duo/.
// O agy grava conversas, logs e cache ali (verificado: o ~/.gemini do usuário fica intacto). Só
// Library/Keychains aponta para o real, que é onde está o login da assinatura.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { withFileLock } from "./store.js";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { childEnv } from "../permissions/auth.js";

export type ChainClass = "active" | "resumable" | "terminal" | "orphan";

function realHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

function writeOnce(path: string, data: string): void {
  try { writeFileSync(path, data, { mode: 0o600, flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
}

/** join com o separador do próprio caminho: C:\... usa o do Windows; o resto, o nativo. */
const joinFor = (base: string, ...parts: string[]): string => (/^[A-Za-z]:[\\/]/.test(base) ? win32.join(base, ...parts) : join(base, ...parts));

export function geminiStateRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // Só caminho local totalmente qualificado (C:\...): vazio ou relativo criaria o estado privado na pasta atual.
    // Fora de um Windows real (simulação nos testes) também vale um caminho POSIX absoluto.
    // C:\x e C:/x valem; C:x (relativo à unidade), vazio e relativo não.
    const ok = (p: string | undefined): p is string => !!p && (/^[A-Za-z]:[\\/]/.test(p) || (process.platform !== "win32" && p.startsWith("/")));
    const base = ok(env.LOCALAPPDATA) ? env.LOCALAPPDATA : ok(env.USERPROFILE) ? joinFor(env.USERPROFILE, "AppData", "Local") : null;
    if (!base) throw new Error("LOCALAPPDATA/USERPROFILE ausente ou relativo: estado privado do gemini sem lugar seguro");
    return joinFor(base, "duo", "gemini-state");
  }
  return platform === "darwin"
    ? join(realHome(env), "Library", "Application Support", "duo", "gemini-state")
    : join(env.XDG_STATE_HOME ?? join(realHome(env), ".local", "state"), "duo", "gemini-state");
}

export function chainStateDir(projectRoot: string, chainId: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(chainId)) throw new Error(`chainId inválido: ${chainId}`);
  const dir = join(geminiStateRoot(env, platform), createHash("sha256").update(projectRoot).digest("hex").slice(0, 12), chainId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = join(dir, "owner.json");
  // "wx": dois processos criando a mesma cadeia ao mesmo tempo; o segundo encontra o arquivo e segue.
  if (!existsSync(owner)) writeOnce(owner, `${JSON.stringify({ projectRoot, chainId, createdAt: new Date().toISOString() })}\n`);
  return dir;
}

export function createPrivateHome(chainDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { home: string } {
  const home = join(chainDir, "home");
  if (platform === "win32") {
    // Windows: o login fica no Gerenciador de Credenciais (fatos da Fase 0), nada a ligar; só as pastas do perfil.
    mkdirSync(join(home, "AppData", "Roaming"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "AppData", "Local"), { recursive: true, mode: 0o700 });
  } else linkKeychains(home, env);
  seedConfig(home);
  return { home };
}

function linkKeychains(home: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(join(home, "Library"), { recursive: true, mode: 0o700 });
  const kc = join(home, "Library", "Keychains");
  // lstat: um link para Keychains inexistente é "quebrado" para existsSync, mas já existe.
  let linked = true;
  try { lstatSync(kc); } catch { linked = false; }
  if (!linked) {
    try { symlinkSync(join(realHome(env), "Library", "Keychains"), kc); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}

function seedConfig(home: string): void {
  const cfgDir = join(home, ".gemini", "config");
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const cfg = join(cfgDir, "config.json");
  // O plugin embutido "swarm" vem ligado por padrão num HOME novo (observado no agy 1.5.3).
  if (!existsSync(cfg)) writeOnce(cfg, `${JSON.stringify({ plugins: { swarm: { enabled: false } } }, null, 2)}\n`);
}

/** Ambiente de toda chamada do agy. macOS: HOME e TMPDIR privados (como sempre). Windows: o perfil inteiro, porque lá
 * o agy acha config e estado por USERPROFILE/APPDATA/LOCALAPPDATA e grava temporários em TEMP/TMP. */
export function privateProfileEnv(base: NodeJS.ProcessEnv, profile: { home: string; tmpDir: string }, platform: NodeJS.Platform = process.platform): { env: NodeJS.ProcessEnv; removed: string[] } {
  const { home, tmpDir } = profile;
  if (platform !== "win32") return childEnv(base, { HOME: home, TMPDIR: tmpDir }, platform);
  const drive = win32.parse(home).root.replace(/\\$/, "");
  return childEnv(base, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: win32.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: win32.join(home, "AppData", "Local"),
    TEMP: tmpDir,
    TMP: tmpDir,
    TMPDIR: tmpDir,
    HOMEDRIVE: drive,
    HOMEPATH: home.slice(drive.length),
    // O cmd.exe que roda o hook não procura executável na pasta atual (a worktree): o `node` vem só do PATH.
    NoDefaultCurrentDirectoryInExePath: "1",
  }, "win32");
}

/** Lançador do agy para rodar fora da pasta do projeto: só quando o comando é o node, o script (primeiro argumento,
 * relativo e existente) vira absoluto contra a pasta onde o duo resolveu a config. Os demais argumentos ficam
 * literais, iguais aos da execução real. */
export function launcherFor(resolved: { command: string; prefixArgs: string[] }, base: string = process.cwd()): { command: string; prefixArgs: string[] } {
  // O executável achado por uma entrada relativa do PATH (tools\agy.exe) também vira absoluto.
  const command = !isAbsolute(resolved.command) && existsSync(resolve(base, resolved.command)) ? resolve(base, resolved.command) : resolved.command;
  const [first, ...rest] = resolved.prefixArgs;
  const isNode = /^node(\.exe)?$/i.test(basename(command));
  if (!isNode || first === undefined || first.startsWith("-") || isAbsolute(first) || !existsSync(resolve(base, first))) return { command, prefixArgs: [...resolved.prefixArgs] };
  return { command, prefixArgs: [resolve(base, first), ...rest] };
}

/** Nomes de config que o agy procura em todas as pastas acima da pasta de trabalho (fatos do Windows, Fase 0). */
export const CODEIUM_CONFIG_NAMES = ["codeium.yaml", "codeium.yml", ".codeium.yaml", ".codeium.yml"] as const;

/** Primeiro arquivo de config do agy nas pastas ACIMA de startDir (até a raiz), ou null. */
export function agyConfigAbove(startDir: string, exists: (p: string) => boolean = existsSync): string | null {
  let dir = dirname(resolve(startDir));
  for (;;) {
    for (const name of CODEIUM_CONFIG_NAMES) { const p = join(dir, name); if (exists(p)) return p; }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Onde nascem os perfis descartáveis das sondas. Windows: dentro da raiz de estado por usuário (%LOCALAPPDATA%), não
 * no TEMP, que pode ser compartilhado e cujas permissões herdadas não são privadas. Outros: o temporário do sistema. */
export function probeRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return tmpdir();
  const root = joinFor(geminiStateRoot(env, platform), "probes");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  sweepProbeDirs(root);
  return root;
}

/** Perfil descartável de sonda com dono (probe.json com o PID): se a ponte morrer antes do finally, a próxima sonda
 * ou o prune reconhecem a pasta abandonada. */
export function newProbeDir(env: NodeJS.ProcessEnv, prefix: string, platform: NodeJS.Platform = process.platform): string {
  const dir = mkdtempSync(join(probeRoot(env, platform), prefix));
  writeFileSync(join(dir, "probe.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return dir;
}

/** Remove perfis de sonda abandonados: dono morto e mais de 10 min. Sem probe.json legível não toca (pode estar nascendo). */
export function sweepProbeDirs(root: string, minAgeMs = 10 * 60_000): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return removed; }
  for (const n of names) {
    if (!/^duo-agy-(meta|login)-/.test(n)) continue;
    const dir = join(root, n);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      const m = JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")) as { pid?: unknown };
      if (isAlive(m.pid) || Date.now() - statSync(dir).mtimeMs < minAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch { /* sem dono legível: deixa */ }
  }
  return removed;
}

/** Sondas de metadados do agy (versão, ajuda, modelos) com perfil e pasta de trabalho privados e descartáveis: nunca
 * rodam na pasta do projeto nem com o perfil real. No Windows a pasta de trabalho é conferida contra config do agy acima. */
export function withMetadataProfile<T>(base: NodeJS.ProcessEnv, fn: (env: NodeJS.ProcessEnv, cwd: string) => T, platform: NodeJS.Platform = process.platform): T {
  const dir = newProbeDir(base, "duo-agy-meta-", platform);
  try {
    const { home } = createPrivateHome(dir, base, platform);
    const tmp = join(dir, "tmp");
    const work = join(dir, "work");
    mkdirSync(tmp, { mode: 0o700 });
    mkdirSync(work, { mode: 0o700 });
    if (platform === "win32") {
      const found = agyConfigAbove(work);
      if (found) throw new Error(`config do agy acima da pasta de sondagem (${basename(found)}); remova ou mova o arquivo`);
    }
    return fn(privateProfileEnv(base, { home, tmpDir: tmp }, platform).env, work);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

export function listGeminiStates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { dir: string; projectRoot: string; chainId: string; mtimeMs: number }[] {
  const root = geminiStateRoot(env, platform);
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

export function projectStateDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(geminiStateRoot(env, platform), createHash("sha256").update(projectRoot).digest("hex").slice(0, 12));
}

export function chainStatePath(projectRoot: string, chainId: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (!CHAIN_ID.test(chainId) || chainId.includes("..")) throw new Error(`chainId inválido: ${chainId}`);
  return join(projectStateDir(projectRoot, env, platform), chainId);
}

/**
 * Remoção a partir de um caminho guardado (task.geminiStateDir): só apaga se o caminho resolvido for exatamente o
 * esperado para este projeto e esta cadeia dentro da raiz de estado, com owner.json coerente e sem uso ativo.
 */
/**
 * O caminho é exatamente o estado desta cadeia deste projeto? Diretório real (não link), filho direto da pasta canônica
 * do projeto (hash do projectRoot) com o nome da cadeia, e owner.json coerente. Devolve o caminho esperado ou null.
 */
function validChainDir(dir: string, projectRoot: string, chainId: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  try {
    const expected = chainStatePath(projectRoot, chainId, env, platform);
    // Nenhum nível pode ser link: nem a cadeia, nem a pasta do projeto (hash), que tem de ser filha real da raiz confiável.
    const projDir = projectStateDir(projectRoot, env, platform);
    if (!lstatSync(projDir).isDirectory() || dirname(realpathSync(projDir)) !== realpathSync(geminiStateRoot(env, platform))) return null;
    if (lstatSync(dir).isSymbolicLink() || lstatSync(expected).isSymbolicLink()) return null;
    const real = realpathSync(dir);
    if (dirname(real) !== realpathSync(projectStateDir(projectRoot, env, platform)) || real !== realpathSync(expected)) return null;
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
  platform: NodeJS.Platform = process.platform,
): string[] {
  const removed: string[] = [];
  const effective = (projectRoot: string, chainId: string, dir: string): ChainClass => {
    if (anyAttemptAlive(dir) || anyClaimAlive(dir)) return "active";
    if (!existsSync(join(projectRoot, ".duo"))) return "orphan";
    return opts.classify(projectRoot, chainId);
  };
  const eligible = (cls: ChainClass, mtimeMs: number) =>
    cls === "terminal" || cls === "orphan" || (cls === "resumable" && opts.olderThanDays !== undefined && Date.now() - mtimeMs >= opts.olderThanDays * 86400_000);
  // No Windows, também a raiz antiga (XDG/.local/state, usada antes do suporte ao Windows): só para limpar, nunca para
  // lançar o agy de novo com aquele perfil.
  const roots: NodeJS.Platform[] = platform === "win32" ? ["win32", "linux"] : [platform];
  if (platform === "win32") try { removed.push(...sweepProbeDirs(joinFor(geminiStateRoot(env, platform), "probes"))); } catch { /* raiz inválida: só as cadeias */ }
  for (const plat of roots) for (const s of listGeminiStates(env, plat)) {
    if (!eligible(effective(s.projectRoot, s.chainId, s.dir), s.mtimeMs)) continue;
    // Só apaga o caminho validado (nome, hash do projeto, dono, sem link), conferido de novo com a trava pega.
    if (!validChainDir(s.dir, s.projectRoot, s.chainId, env, plat)) continue;
    const gone = withChainLock(s.dir, () => {
      const expected = validChainDir(s.dir, s.projectRoot, s.chainId, env, plat);
      if (!expected || !eligible(effective(s.projectRoot, s.chainId, expected), lastUsedMs(expected))) return false;
      removeChainState(expected);
      return true;
    }, 0);
    if (gone) removed.push(s.dir);
  }
  return removed;
}
