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
import { join } from "node:path";
import { agyConfigAbove, chainStateDir, createPrivateHome, geminiStateRoot, launcherFor, privateProfileEnv, pruneGeminiStates, sweepProbeDirs, withMetadataProfile } from "../src/state/gemini-state.js";
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
    assert.match(slash(c.cwd), /gemini-state\/.*\/catalog\/home\/work-[^/]+$/);
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
    writeFileSync(join(base, "tools", "agy.exe"), "");
    assert.equal(launcherFor({ command: join("tools", "agy.exe"), prefixArgs: [] }, base).command, join(base, "tools", "agy.exe"));
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
