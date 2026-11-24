// Gemini no Windows: ambiente do filho e perfil privado. Os ramos win32 rodam em qualquer SO pela plataforma injetada.
import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import { childEnv, isBillingEnvName } from "../src/permissions/auth.js";
import { geminiParentEnvProblem } from "../src/permissions/gemini-auth.js";

describe("childEnv no Windows", () => {
  it("remove cobrança em qualquer caixa e troca variáveis que diferem só na caixa", () => {
    const { env, removed } = childEnv({ gemini_api_key: "k", Anthropic_Api_Key: "a", Home: "C:\\real", Path: "p" }, { HOME: "D:\\priv" }, "win32");
    assert.equal("gemini_api_key" in env, false);
    assert.equal("Anthropic_Api_Key" in env, false);
    assert.equal("Home" in env, false);
    assert.equal(env.HOME, "D:\\priv");
    assert.equal(env.Path, "p");
    assert.deepEqual(removed, ["Anthropic_Api_Key", "gemini_api_key"]);
  });

  it("diagnóstico reconhece a chave de cobrança removida em outra caixa", () => {
    assert.equal(isBillingEnvName("Anthropic_Api_Key", "win32"), true);
    assert.equal(isBillingEnvName("Anthropic_Api_Key", "darwin"), false);
  });

  it("no macOS continua como antes", () => {
    const { env } = childEnv({ gemini_api_key: "k", Home: "/real" }, { HOME: "/priv" }, "darwin");
    assert.equal(env.gemini_api_key, "k");
    assert.equal(env.Home, "/real");
    assert.equal(env.HOME, "/priv");
  });
});

describe("geminiParentEnvProblem no Windows", () => {
  it("acha a variável de cobrança do Google em qualquer caixa", () => {
    assert.match(geminiParentEnvProblem({ gemini_api_key: "k" }, "win32") ?? "", /gemini_api_key/);
    assert.equal(geminiParentEnvProblem({ gemini_api_key: "k" }, "darwin"), null);
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { agyConfigAbove, chainStateDir, createPrivateHome, geminiStateRoot, launcherFor, privateProfileEnv, probeRoot, pruneGeminiStates, removeProbeDir, sweepProbeDirs, withMetadataProfile } from "../src/state/gemini-state.js";
import { chmodSync, readdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
// Pasta redirecionada: junction no Windows (não exige privilégio), link simbólico no POSIX.
const redirect = (target: string, link: string) => symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
import { utimesSync } from "node:fs";

const temps: string[] = [];
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe("perfil privado no Windows", () => {
  it("estado em %LOCALAPPDATA%\\duo\\gemini-state, inclusive com acento", () => {
    assert.equal(geminiStateRoot({ LOCALAPPDATA: "C:\\Users\\João\\AppData\\Local" }, "win32"), "C:\\Users\\João\\AppData\\Local\\duo\\gemini-state");
  });

  it("LOCALAPPDATA vazio usa o USERPROFILE; relativo ou ausente recusa", () => {
    assert.equal(geminiStateRoot({ LOCALAPPDATA: "", USERPROFILE: "C:\\Users\\v" }, "win32"), "C:\\Users\\v\\AppData\\Local\\duo\\gemini-state");
    assert.throws(() => geminiStateRoot({ LOCALAPPDATA: "rel", USERPROFILE: "outro" }, "win32"), /relativo/);
    assert.throws(() => geminiStateRoot({}, "win32"), /relativo/);
    assert.equal(geminiStateRoot({ LOCALAPPDATA: "D:/Profiles/Local" }, "win32"), "D:\\Profiles\\Local\\duo\\gemini-state");
    assert.throws(() => geminiStateRoot({ LOCALAPPDATA: "D:Local" }, "win32"), /relativo/);
  });

  it("HOME privado com AppData e sem o link do Keychain", () => {
    const dir = tempDir("duo-w32-home-");
    const { home } = createPrivateHome(dir, { HOME: "/nao/usar" }, "win32");
    assert.ok(existsSync(join(home, "AppData", "Roaming")));
    assert.ok(existsSync(join(home, "AppData", "Local")));
    assert.equal(existsSync(join(home, "Library")), false);
    assert.ok(existsSync(join(home, ".gemini", "config", "config.json")));
  });

  it("ambiente do agy com o perfil inteiro trocado", () => {
    const { env } = privateProfileEnv({ userprofile: "C:\\real", Path: "p" }, { home: "C:\\S\\home", tmpDir: "C:\\S\\tmp" }, "win32");
    assert.equal(env.USERPROFILE, "C:\\S\\home");
    assert.equal(env.HOME, "C:\\S\\home");
    assert.equal(env.APPDATA, "C:\\S\\home\\AppData\\Roaming");
    assert.equal(env.LOCALAPPDATA, "C:\\S\\home\\AppData\\Local");
    assert.equal(env.TEMP, "C:\\S\\tmp");
    assert.equal(env.TMP, "C:\\S\\tmp");
    assert.equal(env.HOMEDRIVE, "C:");
    assert.equal(env.HOMEPATH, "\\S\\home");
    assert.equal(env.NoDefaultCurrentDirectoryInExePath, "1"); // cmd.exe do hook não procura node na worktree
    assert.equal("userprofile" in env, false);
    assert.equal(env.Path, "p");
  });

  it("no macOS o ambiente é o de hoje (HOME e TMPDIR)", () => {
    const base = { PATH: "p", GEMINI_API_KEY: "k" };
    assert.deepEqual(privateProfileEnv(base, { home: "/h", tmpDir: "/t" }, "darwin"), childEnv(base, { HOME: "/h", TMPDIR: "/t" }, "darwin"));
  });

  it("sonda de metadados roda com HOME e pasta de trabalho privados, apagados depois", () => {
    let seen: { home?: string; cwd?: string } = {};
    const local = tempDir("duo-w32-local-");
    withMetadataProfile({ PATH: "p", LOCALAPPDATA: local }, (env, cwd) => { seen = { home: env.HOME, cwd }; assert.ok(existsSync(cwd)); }, "win32");
    assert.ok(seen.cwd?.startsWith(join(local, "duo", "gemini-state", "probes")), "perfil da sonda fica na raiz por usuário, não no TEMP");
    assert.ok(seen.home && seen.cwd && seen.cwd.startsWith(join(seen.home, "..")));
    assert.equal(existsSync(seen.home), false);
    assert.equal(existsSync(seen.cwd), false);
  });

  it("acha qualquer um dos quatro nomes de config do agy acima da pasta, não dentro dela", () => {
    for (const name of ["codeium.yaml", "codeium.yml", ".codeium.yaml", ".codeium.yml"]) {
      const top = tempDir("duo-w32-cfg-");
      const start = join(top, "a", "b");
      mkdirSync(start, { recursive: true });
      writeFileSync(join(top, name), "");
      writeFileSync(join(start, name), "");
      assert.equal(agyConfigAbove(start), join(top, name), name);
    }
    const clean = tempDir("duo-w32-cfg-");
    assert.equal(agyConfigAbove(clean, (p) => p.startsWith(clean)), null);
  });
});

import { readFileSync, realpathSync } from "node:fs";
import { cliVersions, discover } from "../src/adapters/catalog.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { packageRoot } from "../src/paths.js";
import { geminiAuthPreflight, geminiLoginProbe } from "../src/permissions/gemini-auth.js";
import { probeAgy } from "../src/adapters/capabilities.js";

describe("toda chamada do agy no Windows usa perfil e pasta privados", () => {
  const FAKE = join(packageRoot(), "tests", "fixtures", "fake-agy.mjs");
  const setup = () => {
    const base = realpathSync(tempDir("duo-w32-launch-"));
    // Perfil "real" simulado dentro do temporário: no Windows nativo o catálogo cria estado sob o LOCALAPPDATA.
    const owner = join(base, "dono");
    const REAL = { USERPROFILE: owner, APPDATA: join(owner, "AppData", "Roaming"), LOCALAPPDATA: join(owner, "AppData", "Local") };
    const project = join(base, "proj");
    mkdirSync(project, { recursive: true });
    const out = join(base, "env.jsonl");
    // PATH só com uma pasta vazia: claude e codex instalados na máquina nunca são chamados por este teste offline.
    const emptyBin = join(base, "bin"); mkdirSync(emptyBin);
    const env = { PATH: emptyBin, HOME: join(base, "realhome"), XDG_STATE_HOME: join(base, "state"), ...REAL, FAKE_AGY_ENV_OUT: out, FAKE_AGY_VERSION: "1.5.15" };
    // node + script: o Windows não executa um .mjs pelo shebang.
    const cfg = structuredClone(DEFAULT_CONFIG); cfg.executors.gemini.enabled = true; cfg.executors.gemini.command = [process.execPath, FAKE];
    const calls = () => readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, string | null> & { argv: string[] });
    return { base, project, env, cfg, calls, REAL };
  };
  const slash = (p: string | null | undefined) => String(p).replace(/\\/g, "/");
  // Privado = dentro de uma das áreas do duo (temporário de sondagem/login ou estado gemini-state), nunca as pastas
  // do perfil original em si.
  const PRIVATE = /duo-agy-meta-|duo-agy-login-|\/duo\/gemini-state\/|\/gemini-state\//;
  const assertPrivate = (c: Record<string, string | null>, project: string, REAL: Record<string, string>) => {
    for (const k of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] as const) {
      assert.ok(c[k], k);
      if (REAL[k]) assert.notEqual(slash(c[k]), slash(REAL[k]), k);
      assert.match(slash(c[k]), PRIVATE, k);
      // O filho recebeu um caminho absoluto de uma pasta que existe (não um nome relativo).
      assert.ok(isAbsolute(String(c[k])), `${k}: ${c[k]}`);
      if (k === "APPDATA" || k === "LOCALAPPDATA" || k === "TEMP") assert.equal((c as Record<string, unknown>)[`${k}_exists`], true, `${k} existe no filho`);
    }
    assert.notEqual(c.cwd, project);
    assert.ok(!String(c.cwd).startsWith(project));
  };

  it("cliVersions: versão do agy com perfil e pasta descartáveis", () => {
    const { project, env, cfg, calls, REAL } = setup();
    const v = cliVersions(cfg, env, "win32");
    assert.equal(v.gemini, "1.5.15");
    const c = calls().find((x) => x.argv[0] === "--version");
    assert.ok(c);
    assertPrivate(c, project, REAL);
    assert.match(String(c.cwd), /duo-agy-meta-.*work$/);
    assert.equal(existsSync(String(c.cwd)), false);
  });

  it("discover: agy models com o HOME do catálogo e pasta de trabalho privada", async () => {
    const { project, env, cfg, calls, REAL } = setup();
    await discover(cfg, project, env, null, { platform: "win32", cliVersions: { claude: null, codex: null, gemini: null } });
    const c = calls().find((x) => x.argv[0] === "models");
    assert.ok(c);
    assertPrivate(c, project, REAL);
    assert.match(slash(c.cwd), /gemini-state\/probes\/duo-agy-work-[^/]+$/);
    assert.ok(slash(c.cwd).startsWith(`${slash(REAL.LOCALAPPDATA)}/duo/gemini-state/`), "catálogo na raiz do Windows (LOCALAPPDATA)");
    assert.equal(existsSync(String(c.cwd)), false); // pasta nova a cada consulta, apagada depois
  });

  it("geminiLoginProbe: checagem de login com perfil e pasta privados", () => {
    const { project, env, cfg, calls, REAL } = setup();
    geminiLoginProbe({ ok: true, command: process.execPath, prefixArgs: [FAKE], source: "config" }, env, cfg, "win32");
    const c = calls().find((x) => x.argv[0] === "models");
    assert.ok(c);
    assertPrivate(c, project, REAL);
    assert.match(String(c.cwd), /duo-agy-login-.*work$/);
  });

  it("rastreio (DUO_TRACE_LOG): sondas de capacidade e checagem de login anotam cada agy com as pastas privadas, inclusive o TEMP", () => {
    const { base, env, cfg, calls } = setup();
    const log = join(base, "trace.jsonl");
    const prev = process.env.DUO_TRACE_LOG;
    process.env.DUO_TRACE_LOG = log;
    const resolved = { ok: true as const, command: process.execPath, prefixArgs: [FAKE], source: "config" as const };
    try {
      geminiLoginProbe(resolved, env, cfg, "win32");
      probeAgy(resolved, env, "win32");
    } finally { if (prev === undefined) delete process.env.DUO_TRACE_LOG; else process.env.DUO_TRACE_LOG = prev; }
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { label: string; pid: number; allowedRoots: string[] });
    const labels = lines.map((l) => l.label);
    for (const want of ["auth agy models", "caps agy --version", "caps agy --help"]) assert.ok(labels.includes(want), `${want}: ${JSON.stringify(labels)}`);
    const login = lines.find((l) => l.label === "auth agy models")!;
    const c = calls().find((x) => x.argv[0] === "models")!;
    const inside = (p: string) => login.allowedRoots.some((r) => p === r || p.startsWith(`${r}/`) || p.startsWith(`${r}\\`));
    for (const k of ["USERPROFILE", "TEMP", "TMP"] as const) assert.ok(inside(String(c[k])), `${k} ${c[k]} fora de ${JSON.stringify(login.allowedRoots)}`);
    assert.ok(inside(String(c.cwd)));
  });

  it("preflight da delegação roda na pasta privada que recebe e recusa config do agy acima dela", () => {
    const { base, env, cfg, calls } = setup();
    const home = join(base, "chain", "home");
    const attempt = join(home, "tmp", "attempt-1");
    mkdirSync(attempt, { recursive: true });
    const resolved = { ok: true as const, command: process.execPath, prefixArgs: [FAKE], source: "config" as const };
    geminiAuthPreflight(resolved, { ...env, HOME: home }, cfg, null, { cwd: attempt, platform: "win32" });
    assert.equal(calls().find((x) => x.argv[0] === "models")?.cwd, attempt);
    writeFileSync(join(base, "chain", ".codeium.yml"), "");
    const a = geminiAuthPreflight(resolved, { ...env, HOME: home }, cfg, null, { cwd: attempt, platform: "win32" });
    assert.equal(a.ok, false);
    assert.match(a.detail, /config do agy acima/);
  });
});

describe("lançador e raiz antiga no Windows", () => {
  it("só o script do node vira absoluto; outros argumentos ficam literais", () => {
    const base = tempDir("duo-w32-launcher-");
    mkdirSync(join(base, "tools")); writeFileSync(join(base, "tools", "agy.mjs"), "");
    mkdirSync(join(base, "dev"));
    assert.deepEqual(launcherFor({ command: "/usr/bin/node", prefixArgs: ["tools/agy.mjs", "--profile", "dev"] }, base).prefixArgs, [join(base, "tools", "agy.mjs"), "--profile", "dev"]);
    assert.deepEqual(launcherFor({ command: "/opt/wrapper", prefixArgs: ["dev"] }, base).prefixArgs, ["dev"]);
    // Bases separadas: o executável do PATH relativo resolve na pasta atual; o script configurado, na raiz do projeto.
    const cwdBase = tempDir("duo-w32-cmdbase-");
    mkdirSync(join(cwdBase, "tools")); writeFileSync(join(cwdBase, "tools", "agy.exe"), "");
    const l = launcherFor({ command: join("tools", "agy.exe"), prefixArgs: [] }, base, cwdBase);
    assert.equal(l.command, join(cwdBase, "tools", "agy.exe"));
  });

  it("prune no Windows também limpa o estado da raiz antiga (XDG/.local/state)", () => {
    const base = tempDir("duo-w32-legacy-");
    const env = { HOME: base, XDG_STATE_HOME: join(base, "xdg"), LOCALAPPDATA: join(base, "local") };
    const project = join(base, "proj");
    mkdirSync(project);
    const legacy = chainStateDir(project, "old", { HOME: base, XDG_STATE_HOME: join(base, "xdg") }, "linux");
    const removed = pruneGeminiStates({ classify: () => "orphan" }, env, "win32");
    assert.ok(removed.includes(legacy), JSON.stringify(removed));
    assert.equal(existsSync(legacy), false);
  });
});

describe("perfis de sonda abandonados", () => {
  it("remove só os de dono morto e antigos", () => {
    const root = tempDir("duo-w32-probes-");
    const mk = (name: string, pid: number, old: boolean) => {
      const d = join(root, name); mkdirSync(d);
      writeFileSync(join(d, "probe.json"), JSON.stringify({ pid }));
      if (old) { const t = new Date(Date.now() - 3600_000); utimesSync(d, t, t); }
      return d;
    };
    const dead = mk("duo-agy-meta-dead", 2 ** 22 + 12345, true);
    const live = mk("duo-agy-meta-live", process.pid, true);
    const fresh = mk("duo-agy-login-fresh", 2 ** 22 + 12346, false);
    const other = join(root, "outra-coisa"); mkdirSync(other);
    assert.deepEqual(sweepProbeDirs(root), [dead]);
    for (const d of [live, fresh, other]) assert.ok(existsSync(d), d);
  });
});

describe("limpeza: dono incerto e raiz nova indisponível", () => {
  it("perfil de sonda com probe.json sem PID válido fica", () => {
    const root = tempDir("duo-w32-probes2-");
    const d = join(root, "duo-agy-meta-x"); mkdirSync(d);
    writeFileSync(join(d, "probe.json"), "{}");
    const t = new Date(Date.now() - 3600_000); utimesSync(d, t, t);
    assert.deepEqual(sweepProbeDirs(root), []);
    assert.ok(existsSync(d));
  });

  it("sem LOCALAPPDATA/USERPROFILE válidos o prune ainda limpa a raiz antiga", () => {
    const base = tempDir("duo-w32-legacy2-");
    const project = join(base, "proj"); mkdirSync(project);
    const env = { HOME: base, XDG_STATE_HOME: join(base, "xdg") };
    const legacy = chainStateDir(project, "old", env, "linux");
    const errors: string[] = [];
    assert.ok(pruneGeminiStates({ classify: () => "orphan", onScanError: (w, r) => errors.push(`${w}: ${r}`) }, env, "win32").includes(legacy));
    assert.ok(errors.some((e) => /raiz do estado/.test(e)), "a raiz nova indisponível é reportada, não escondida");
  });
});

describe("pasta de estado redirecionada", () => {
  // Link em cada nível abaixo do LOCALAPPDATA: duo, gemini-state e probes.
  for (const level of ["duo", "gemini-state", "probes"] as const) {
    it(`link em ${level} é recusado antes de criar qualquer coisa no destino`, () => {
      const base = tempDir("duo-w32-junction-");
      const local = join(base, "local");
      const chain = ["duo", "gemini-state", "probes"];
      const upTo = chain.slice(0, chain.indexOf(level));
      mkdirSync(join(local, ...upTo), { recursive: true });
      const outside = join(base, "fora"); mkdirSync(outside);
      redirect(outside, join(local, ...upTo, level));
      assert.throws(() => probeRoot({ LOCALAPPDATA: local }, "win32"), /redirecionada/);
      assert.deepEqual(readdirSync(outside), [], "nada criado no destino do link");
    });
  }

  it("prune não lista nem apaga cadeias através de uma raiz redirecionada", () => {
    const base = tempDir("duo-w32-prune-junction-");
    const local = join(base, "local");
    mkdirSync(join(local, "duo"), { recursive: true });
    const target = join(base, "alvo"); mkdirSync(target);
    redirect(target, join(local, "duo", "gemini-state"));
    const project = join(base, "proj"); mkdirSync(project);
    // Cadeia já existente no destino do link (criada à mão: o chainStateDir do Windows recusaria o caminho).
    // Hash real do projeto: nenhuma diferença de hash pode esconder um caminho de remoção inseguro.
    const chain = join(target, createHash("sha256").update(project).digest("hex").slice(0, 12), "c1");
    mkdirSync(chain, { recursive: true });
    writeFileSync(join(chain, "owner.json"), JSON.stringify({ projectRoot: project, chainId: "c1" }));
    assert.throws(() => chainStateDir(project, "c2", { LOCALAPPDATA: local }, "win32"), /redirecionada/);
    const errors: string[] = [];
    pruneGeminiStates({ classify: () => "orphan", onScanError: (w, r) => errors.push(`${w}: ${r}`) }, { LOCALAPPDATA: local, HOME: base, XDG_STATE_HOME: join(base, "xdg") }, "win32");
    assert.ok(existsSync(chain), "cadeia no destino do link continua");
    // XDG apontando para a mesma árvore: a passada antiga também não apaga através do link.
    pruneGeminiStates({ classify: () => "orphan", onScanError: () => {} }, { LOCALAPPDATA: local, HOME: base, XDG_STATE_HOME: local }, "win32");
    assert.ok(existsSync(chain), "nem pela raiz antiga");
    // Mesma pasta com outra grafia (sistema de arquivos sem diferença de caixa): comparação por identidade, não por texto.
    const alias = join(base, "LOCAL");
    if (existsSync(alias)) {
      pruneGeminiStates({ classify: () => "orphan", onScanError: () => {} }, { LOCALAPPDATA: local, HOME: base, XDG_STATE_HOME: alias }, "win32");
      assert.ok(existsSync(chain), "nem por um apelido de caixa diferente");
    }
    assert.ok(errors.some((e) => /raiz do estado/.test(e)));
  });

  it("raiz antiga inacessível é reportada, não tratada como ausente", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    const base = tempDir("duo-w32-legacy-eacces-");
    const xdg = join(base, "xdg"); mkdirSync(join(xdg, "duo", "gemini-state"), { recursive: true });
    chmodSync(xdg, 0o000);
    try {
      const errors: string[] = [];
      pruneGeminiStates({ classify: () => "orphan", onScanError: (w, r) => errors.push(`${w}: ${r}`) }, { HOME: base, XDG_STATE_HOME: xdg, LOCALAPPDATA: join(base, "local") }, "win32");
      assert.ok(errors.some((e) => /raiz antiga/.test(e)), JSON.stringify(errors));
    } finally { chmodSync(xdg, 0o700); }
  });
});

describe("limpeza de perfil de sonda redirecionado e base na raiz da unidade", () => {
  it("removeProbeDir não apaga nada no destino de um link", () => {
    const base = tempDir("duo-w32-rmlink-");
    const target = join(base, "alvo"); mkdirSync(target); writeFileSync(join(target, "importante.txt"), "x");
    const link = join(base, "duo-agy-meta-x");
    redirect(target, link);
    removeProbeDir(link);
    assert.ok(existsSync(join(target, "importante.txt")));
  });

  it("LOCALAPPDATA na raiz da unidade mantém o separador", () => {
    assert.equal(geminiStateRoot({ LOCALAPPDATA: "D:\\" }, "win32"), "D:\\duo\\gemini-state");
  });
});
