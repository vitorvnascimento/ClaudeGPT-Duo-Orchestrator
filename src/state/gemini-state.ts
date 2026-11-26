// Estado nativo do executor Gemini: um HOME privado por cadeia, fora do projeto e do .duo/.
// O agy grava conversas, logs e cache ali (verificado: o ~/.gemini do usuário fica intacto). Só
// Library/Keychains aponta para o real, que é onde está o login da assinatura.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { withFileLock } from "./store.js";
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
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

/** Base confiável do estado no Windows (o LOCALAPPDATA do dono, validado). Só caminho local totalmente qualificado:
 * C:\x e C:/x valem; C:x (relativo à unidade), vazio e relativo não. Fora de um Windows real (simulação nos testes)
 * também vale um caminho POSIX absoluto. */
function win32StateBase(env: NodeJS.ProcessEnv): string {
  const ok = (p: string | undefined): p is string => !!p && (/^[A-Za-z]:[\\/]/.test(p) || (process.platform !== "win32" && p.startsWith("/")));
  const base = ok(env.LOCALAPPDATA) ? env.LOCALAPPDATA : ok(env.USERPROFILE) ? joinFor(env.USERPROFILE, "AppData", "Local") : null;
  if (!base) throw new Error("LOCALAPPDATA/USERPROFILE ausente ou relativo: estado privado do gemini sem lugar seguro");
  return base;
}

export function geminiStateRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return joinFor(win32StateBase(env), "duo", "gemini-state");
  return platform === "darwin"
    ? join(realHome(env), "Library", "Application Support", "duo", "gemini-state")
    : join(env.XDG_STATE_HOME ?? join(realHome(env), ".local", "state"), "duo", "gemini-state");
}

export function chainStateDir(projectRoot: string, chainId: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(chainId)) throw new Error(`chainId inválido: ${chainId}`);
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  let dir: string;
  if (platform === "win32") {
    // Windows: cada nível desde o LOCALAPPDATA conferido antes de escrever (nada de owner.json num destino redirecionado).
    const { base, parts } = win32StateChain(env);
    dir = safeDirChain(base, [...parts, hash, chainId], true);
  } else {
    dir = join(geminiStateRoot(env, platform), hash, chainId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
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
  // Caminhos no estilo do próprio home (C:\... no Windows; POSIX na simulação dos testes): sempre absolutos e reais.
  const drive = /^[A-Za-z]:/.test(home) ? win32.parse(home).root.replace(/\\$/, "") : "";
  return childEnv(base, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: joinFor(home, "AppData", "Roaming"),
    LOCALAPPDATA: joinFor(home, "AppData", "Local"),
    TEMP: tmpDir,
    TMP: tmpDir,
    TMPDIR: tmpDir,
    ...(drive ? { HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) } : {}),
    // O cmd.exe que roda o hook não procura executável na pasta atual (a worktree): o `node` vem só do PATH.
    NoDefaultCurrentDirectoryInExePath: "1",
  }, "win32");
}

/** Lançador do agy para rodar fora da pasta do projeto: só quando o comando é o node, o script (primeiro argumento,
 * relativo e existente) vira absoluto contra a pasta onde o duo resolveu a config. Os demais argumentos ficam
 * literais, iguais aos da execução real. */
export function launcherFor(resolved: { command: string; prefixArgs: string[] }, scriptBase: string = process.cwd(), commandBase: string = process.cwd()): { command: string; prefixArgs: string[] } {
  // Executável achado por uma entrada relativa do PATH (tools\agy.exe): relativo à pasta atual, onde foi achado.
  const command = !isAbsolute(resolved.command) && existsSync(resolve(commandBase, resolved.command)) ? resolve(commandBase, resolved.command) : resolved.command;
  // Script configurado no projeto (["node", "tools/agy.mjs"]): relativo à raiz do projeto, como na execução real.
  const [first, ...rest] = resolved.prefixArgs;
  const isNode = /^node(\.exe)?$/i.test(basename(command));
  // Fixado na raiz do projeto mesmo se faltar: um script ausente nunca troca por outro de mesmo nome noutra pasta.
  if (!isNode || first === undefined || first.startsWith("-") || isAbsolute(first)) return { command, prefixArgs: [...resolved.prefixArgs] };
  return { command, prefixArgs: [resolve(scriptBase, first), ...rest] };
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
  const root = checkedProbeRoot(env, platform, true);
  sweepProbeDirs(root);
  return root;
}

/**
 * Anda de uma base confiável (o LOCALAPPDATA do dono) pelos componentes `duo`, `gemini-state`, ... um a um: cada um,
 * se existe, tem de ser pasta real (nem link nem junction) filha real da anterior; só então o próximo é criado. Assim
 * nada é criado nem apagado através de um redirecionamento em qualquer nível.
 */
function safeDirChain(base: string, parts: string[], create: boolean): string {
  // A base (LOCALAPPDATA do dono) é confiável: pode ser criada de uma vez se ainda não existe.
  if (create && !existsSync(base)) mkdirSync(base, { recursive: true }); // raiz de unidade (D:\) já existe: sem mkdir
  let cur = base;
  for (const part of parts) {
    const next = joinFor(cur, part);
    let st;
    try { st = lstatSync(next); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw e;
      // Outro processo pode criar no mesmo instante: EEXIST segue para a mesma conferência abaixo.
      try { mkdirSync(next, { mode: 0o700 }); } catch (e2) { if ((e2 as NodeJS.ErrnoException).code !== "EEXIST") throw e2; }
      st = lstatSync(next);
    }
    if (st.isSymbolicLink() || !st.isDirectory() || realpathSync(next) !== join(realpathSync(cur), part)) {
      throw new Error(`pasta de estado do gemini redirecionada (link ou junction): ${part}`);
    }
    cur = next;
  }
  return cur;
}

/** Base confiável e componentes da raiz de estado no Windows (LOCALAPPDATA\duo\gemini-state). */
function win32StateChain(env: NodeJS.ProcessEnv): { base: string; parts: string[] } {
  return { base: win32StateBase(env), parts: ["duo", "gemini-state"] };
}

/** dir é a mesma pasta que ancestor, ou fica dentro dela? Compara identidades do sistema de arquivos subindo de dir. */
function sameOrInside(dir: string, ancestor: string): boolean {
  const id = (p: string) => { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; };
  const target = id(ancestor);
  let cur = realpathSync(dir);
  for (;;) {
    if (id(cur) === target) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/** A pasta probes, validada componente a componente desde o LOCALAPPDATA (ver safeDirChain). */
function checkedProbeRoot(env: NodeJS.ProcessEnv, _platform: NodeJS.Platform, create: boolean): string {
  const { base, parts } = win32StateChain(env);
  return safeDirChain(base, [...parts, "probes"], create);
}

/** Remoção com novas tentativas (no Windows um arquivo ainda aberto dá EBUSY/EPERM por um instante). Falha que
 * persiste não troca o resultado da sonda: a pasta fica para a limpeza dos abandonados. */
const RM_RETRY = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/** Remoção que tenta de novo e nunca lança: o que sobrar fica para sweepStaleAttempts. */
function removeQuietly(dir: string): boolean {
  try { rmSync(dir, RM_RETRY); } catch { /* handle ainda preso (Windows EPERM/EBUSY) */ }
  return !existsSync(dir);
}

export function removeProbeDir(dir: string): boolean {
  const opts = RM_RETRY;
  try {
    // Pasta trocada por link/junction desde a criação: não lista nem apaga nada no destino.
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || realpathSync(dir) !== join(realpathSync(dirname(dir)), basename(dir))) return false;
    // O probe.json (dono) sai por último: se algo travar antes, a pasta continua reconhecível para sweepProbeDirs.
    for (const n of readdirSync(dir)) if (n !== "probe.json") rmSync(join(dir, n), opts);
    rmSync(dir, opts);
    return !existsSync(dir);
  } catch { return false; /* fica para sweepProbeDirs */ }
}

/** Perfil descartável de sonda com dono (probe.json com o PID): se a ponte morrer antes do finally, a próxima sonda
 * ou o prune reconhecem a pasta abandonada. */
export function newProbeDir(env: NodeJS.ProcessEnv, prefix: string, platform: NodeJS.Platform = process.platform): string {
  const dir = mkdtempSync(join(probeRoot(env, platform), prefix));
  writeFileSync(join(dir, "probe.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return dir;
}

/** Remove perfis de sonda abandonados: dono morto e mais de 10 min. Sem probe.json legível não toca (pode estar nascendo). */
function isDefinitelyDead(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function sweepProbeDirs(root: string, minAgeMs = 10 * 60_000): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return removed; }
  for (const n of names) {
    if (!/^duo-agy-(meta|login|work)-/.test(n)) continue;
    const dir = join(root, n);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      const m = JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")) as { pid?: unknown };
      // Só com dono conhecido e comprovadamente morto (ESRCH); dono inválido ou incerto: deixa.
      if (!isDefinitelyDead(m.pid) || Date.now() - statSync(dir).mtimeMs < minAgeMs) continue;
      // Mesma remoção com o dono por último: se algo travar, a pasta continua reconhecível na próxima varredura.
      if (removeProbeDir(dir)) removed.push(dir);
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
    removeProbeDir(dir);
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
  return { path, setChildPid: (pid) => write(pid), cleanup: () => { removeQuietly(path); } };
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
    if (removeQuietly(dir)) removed.push(dir);
  }
  return removed;
}

function anyAttemptAlive(chainDir: string): boolean {
  const base = attemptsDir(chainDir);
  return existsSync(base) && readdirSync(base).some((n) => n.startsWith("attempt-") && attemptAlive(join(base, n)));
}

export function listGeminiStates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { dir: string; projectRoot: string; chainId: string; mtimeMs: number }[] {
  const root = geminiStateRoot(env, platform);
  // Só "não existe" (ENOENT) é raiz ausente; acesso negado ou erro de E/S propaga (o prune reporta).
  try { readdirSync(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
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
  opts: { olderThanDays?: number; classify(projectRoot: string, chainId: string): ChainClass; onScanError?(what: string, reason: string): void },
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
  const scanError = (what: string, e: unknown) => {
    const reason = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    if (opts.onScanError) opts.onScanError(what, reason); else throw e;
  };
  if (platform === "win32") {
    try { const root = checkedProbeRoot(env, platform, false); removed.push(...sweepProbeDirs(root)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") scanError("pastas de sonda", e); }
  }
  // Cada raiz por si: a nova indisponível (LOCALAPPDATA/USERPROFILE inválidos) não impede limpar a antiga.
  // Raiz antiga ausente não é erro (listGeminiStates devolve vazio); falha de leitura de qualquer raiz é reportada.
  const listed = (plat: NodeJS.Platform) => { try { return listGeminiStates(env, plat); } catch (e) { scanError(plat === "linux" && platform === "win32" ? "raiz antiga do estado" : "raiz do estado", e); return []; } };
  // Raiz nova redirecionada (link/junction em duo ou gemini-state): nada dela é listado nem apagado.
  let currentUnsafe = false;
  if (platform === "win32") {
    try { const { base, parts } = win32StateChain(env); safeDirChain(base, parts, false); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") { currentUnsafe = true; scanError("raiz do estado", e); } }
  }
  // Raiz antiga no Windows: conferida (sem link/junction em duo e gemini-state) e pulada se for a mesma pasta da nova.
  let legacyUnsafe = false;
  if (platform === "win32") {
    const legacyBase = env.XDG_STATE_HOME ?? join(realHome(env), ".local", "state");
    try {
      const legacyRoot = safeDirChain(legacyBase, ["duo", "gemini-state"], false);
      // Mesma árvore da nova (mesma pasta, ou uma dentro da outra, inclusive pelo destino de um link recusado): pula.
      let currentReal: string | null = null;
      try { currentReal = realpathSync(geminiStateRoot(env, "win32")); } catch { currentReal = null; }
      // Por identidade (dispositivo + inode/fileId), não por texto: no NTFS a mesma pasta pode ter grafias diferentes
      // (caixa, nome curto 8.3).
      if (currentReal !== null && (sameOrInside(legacyRoot, currentReal) || sameOrInside(currentReal, legacyRoot))) legacyUnsafe = true;
    } catch (e) {
      legacyUnsafe = true;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") scanError("raiz antiga do estado", e);
    }
  }
  const skip = (plat: NodeJS.Platform) => (plat === platform && currentUnsafe) || (plat === "linux" && platform === "win32" && legacyUnsafe);
  for (const plat of roots) for (const s of (skip(plat) ? [] : listed(plat))) {
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
