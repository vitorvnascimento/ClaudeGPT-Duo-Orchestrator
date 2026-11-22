// HOME privado do executor Gemini (estado nativo do agy fora do .duo/) e seu ciclo de vida.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { attemptTmpDir, chainStateDir, createPrivateHome, geminiStateRoot, listGeminiStates, pruneGeminiStates, sweepStaleAttempts, type ChainClass } from "../src/state/gemini-state.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
function tmp(prefix: string): string { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; }
function fakeEnv(): NodeJS.ProcessEnv { const home = tmp("duo-gs-home-"); mkdirSync(join(home, "Library", "Keychains"), { recursive: true }); return { HOME: home, XDG_STATE_HOME: join(home, ".state") }; }

describe("HOME privado", () => {
  it("state dir is 0700 and outside the project; owner.json holds no prompt text", () => {
    const env = fakeEnv();
    const project = tmp("duo-gs-proj-");
    const dir = chainStateDir(project, "chain-1", env);
    assert.ok(dir.startsWith(geminiStateRoot(env)));
    assert.ok(!dir.startsWith(project));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(owner).sort(), ["chainId", "createdAt", "projectRoot"]);
  });

  it("createPrivateHome links only Library/Keychains and seeds swarm off", () => {
    const env = fakeEnv();
    const dir = chainStateDir(tmp("duo-gs-proj-"), "c", env);
    const { home } = createPrivateHome(dir, env);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    const kc = join(home, "Library", "Keychains");
    assert.ok(lstatSync(kc).isSymbolicLink());
    assert.equal(readlinkSync(kc), join(env.HOME as string, "Library", "Keychains"));
    assert.deepEqual(readdirSync(join(home, "Library")), ["Keychains"]);
    const cfg = JSON.parse(readFileSync(join(home, ".gemini", "config", "config.json"), "utf8")) as { plugins: { swarm: { enabled: boolean } } };
    assert.equal(cfg.plugins.swarm.enabled, false);
    createPrivateHome(dir, env); // idempotente
  });
});

describe("tentativas", () => {
  it("cleanup removes the attempt tmp", () => {
    const env = fakeEnv();
    const dir = chainStateDir(tmp("duo-gs-proj-"), "c", env);
    createPrivateHome(dir, env);
    const a = attemptTmpDir(dir);
    writeFileSync(join(a.path, "x"), "1");
    a.cleanup();
    assert.equal(existsSync(a.path), false);
  });

  it("stale attempt dirs swept after SIGKILL; resumable conversation state stays", async () => {
    const env = fakeEnv();
    const dir = chainStateDir(tmp("duo-gs-proj-"), "c", env);
    const { home } = createPrivateHome(dir, env);
    mkdirSync(join(home, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "conversations", "conv.pb"), "x");
    const mod = new URL("../src/state/gemini-state.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(mod)}); const a = m.attemptTmpDir(${JSON.stringify(dir)}); console.log(a.path); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
    const path = await new Promise<string>((res) => child.stdout.once("data", (d: Buffer) => res(d.toString().trim())));
    assert.ok(existsSync(path));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    assert.deepEqual(sweepStaleAttempts(dir), [path]);
    assert.equal(existsSync(path), false);
    assert.ok(existsSync(join(home, ".gemini", "antigravity-cli", "conversations", "conv.pb")));
  });

  it("attempt dir kept while the detached executor child survives the bridge", async () => {
    const env = fakeEnv();
    const dir = chainStateDir(tmp("duo-gs-proj-"), "c", env);
    createPrivateHome(dir, env);
    const a = attemptTmpDir(dir);
    const sleeper = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    a.setChildPid(sleeper.pid as number);
    // simula ponte morta reescrevendo o pid da ponte para um pid inexistente
    const meta = JSON.parse(readFileSync(join(a.path, "attempt.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(a.path, "attempt.json"), JSON.stringify({ ...meta, bridgePid: 2 ** 22 + 7 }));
    assert.deepEqual(sweepStaleAttempts(dir), []);
    sleeper.kill("SIGKILL");
    await new Promise((r) => sleeper.once("exit", r));
    assert.deepEqual(sweepStaleAttempts(dir), [a.path]);
  });
});

describe("prune", () => {
  function setupChains(env: NodeJS.ProcessEnv) {
    const project = tmp("duo-gs-proj-");
    mkdirSync(join(project, ".duo"));
    const dirsBy: Record<string, string> = {};
    for (const id of ["active", "resumable", "terminal"]) { const d = chainStateDir(project, id, env); createPrivateHome(d, env); dirsBy[id] = d; }
    const gone = tmp("duo-gs-gone-");
    dirsBy.orphan = chainStateDir(gone, "orphan", env);
    rmSync(gone, { recursive: true, force: true });
    return { project, dirsBy };
  }
  const classify = (_p: string, id: string): ChainClass => (id === "orphan" ? "orphan" : id as ChainClass);

  it("removes terminal and orphan, keeps resumable and active", () => {
    const env = fakeEnv();
    const { dirsBy } = setupChains(env);
    const removed = pruneGeminiStates({ classify }, env);
    assert.deepEqual(removed.sort(), [dirsBy.orphan, dirsBy.terminal].sort());
    assert.ok(existsSync(dirsBy.active as string) && existsSync(dirsBy.resumable as string));
    assert.equal(listGeminiStates(env).length, 2);
  });

  it("older-than removes old resumable chains but never an active one", () => {
    const env = fakeEnv();
    const { dirsBy } = setupChains(env);
    const old = new Date(Date.now() - 10 * 86400_000);
    for (const d of Object.values(dirsBy)) if (existsSync(d)) utimesSync(join(d, "owner.json"), old, old);
    const removed = pruneGeminiStates({ classify, olderThanDays: 0 }, env);
    assert.ok(removed.includes(dirsBy.resumable as string));
    assert.ok(!removed.includes(dirsBy.active as string));
    assert.ok(existsSync(dirsBy.active as string));
  });

  it("class rechecked under lock: a chain that becomes active between listing and deletion is kept", () => {
    const env = fakeEnv();
    const { dirsBy } = setupChains(env);
    let calls = 0;
    const flaky = (p: string, id: string): ChainClass => (id === "terminal" ? (calls++ === 0 ? "terminal" : "active") : classify(p, id));
    const removed = pruneGeminiStates({ classify: flaky }, env);
    assert.ok(!removed.includes(dirsBy.terminal as string));
    assert.ok(existsSync(dirsBy.terminal as string));
  });

  it("a chain whose recorded executor child is alive counts as active", () => {
    const env = fakeEnv();
    const { dirsBy } = setupChains(env);
    const a = attemptTmpDir(dirsBy.terminal as string);
    const sleeper = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    a.setChildPid(sleeper.pid as number);
    const removed = pruneGeminiStates({ classify, olderThanDays: 0 }, env);
    process.kill(sleeper.pid as number, "SIGKILL");
    assert.ok(!removed.includes(dirsBy.terminal as string));
  });
});

describe("prune validado", () => {
  it("older-than counts from the last use, not from creation", async () => {
    const { claimChainState } = await import("../src/state/gemini-state.js");
    const env = fakeEnv();
    const project = tmp("duo-gs-proj-");
    mkdirSync(join(project, ".duo"));
    const d = chainStateDir(project, "r1", env);
    const old = new Date(Date.now() - 10 * 86400_000);
    utimesSync(join(d, "owner.json"), old, old);
    claimChainState(d)();
    const removed = pruneGeminiStates({ classify: () => "resumable", olderThanDays: 5 }, env);
    assert.deepEqual(removed, []);
    assert.ok(existsSync(d));
  });
  it("prune never deletes a chain dir that is a symlink or sits under a foreign hash", () => {
    const env = fakeEnv();
    const project = tmp("duo-gs-proj-");
    mkdirSync(join(project, ".duo"));
    const real = chainStateDir(project, "c1", env);
    const victim = tmp("duo-gs-victim-");
    writeFileSync(join(victim, "keep.txt"), "x");
    // Diretório de hash alheio com owner.json apontando para este projeto.
    const foreign = join(geminiStateRoot(env), "aaaaaaaaaaaa", "c9");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "owner.json"), JSON.stringify({ projectRoot: project, chainId: "c9" }));
    // Link no lugar de uma cadeia, com owner.json válido do lado de fora.
    writeFileSync(join(victim, "owner.json"), JSON.stringify({ projectRoot: project, chainId: "c2" }));
    symlinkSync(victim, join(real, "..", "c2"));
    const removed = pruneGeminiStates({ classify: () => "terminal" }, env);
    assert.ok(existsSync(join(victim, "keep.txt")), "alvo do link intacto");
    assert.ok(existsSync(foreign), "hash alheio intacto");
    assert.ok(removed.includes(real));
  });
});

describe("pasta do projeto redirecionada", () => {
  it("a symlinked project-hash dir never lets removal reach the relocated tree", async () => {
    const { removeChainStateSafe, projectStateDir } = await import("../src/state/gemini-state.js");
    const env = fakeEnv();
    const project = tmp("duo-gs-proj-");
    const dir = chainStateDir(project, "c1", env);
    const projDir = projectStateDir(project, env);
    const relocated = tmp("duo-gs-reloc-");
    // Move a árvore para fora e deixa um link no lugar da pasta do projeto.
    fs.cpSync(projDir, join(relocated, "p"), { recursive: true });
    rmSync(projDir, { recursive: true, force: true });
    symlinkSync(join(relocated, "p"), projDir);
    assert.equal(removeChainStateSafe(dir, project, "c1", env), false);
    assert.ok(existsSync(join(relocated, "p", "c1", "owner.json")));
  });
});

describe("remoção validada", () => {
  it("removeChainStateSafe deletes only the expected chain path of this project", async () => {
    const { removeChainStateSafe } = await import("../src/state/gemini-state.js");
    const env = fakeEnv();
    const project = tmp("duo-gs-proj-");
    const dir = chainStateDir(project, "c1", env);
    const other = chainStateDir(project, "c2", env);
    const victim = tmp("duo-gs-victim-");
    assert.equal(removeChainStateSafe(victim, project, "c1", env), false);
    assert.ok(existsSync(victim));
    assert.equal(removeChainStateSafe(other, project, "c1", env), false, "outra cadeia do mesmo projeto");
    assert.ok(existsSync(other));
    assert.equal(removeChainStateSafe(dir, tmp("duo-gs-other-"), "c1", env), false);
    assert.equal(removeChainStateSafe(dir, project, "c1", env), true);
    assert.equal(existsSync(dir), false);
  });

  it("a live claim keeps the state from prune and from safe removal", async () => {
    const { claimChainState, removeChainStateSafe } = await import("../src/state/gemini-state.js");
    const env = fakeEnv();
    const project = tmp("duo-gs-proj-");
    mkdirSync(join(project, ".duo"));
    const dir = chainStateDir(project, "c1", env);
    const release = claimChainState(dir);
    assert.deepEqual(pruneGeminiStates({ classify: () => "terminal" }, env), []);
    assert.equal(removeChainStateSafe(dir, project, "c1", env), false);
    release();
    assert.deepEqual(pruneGeminiStates({ classify: () => "terminal" }, env), [dir]);
  });
});

describe("HOME privado concorrente", () => {
  it("parallel processes setting up the same chain never fail", async () => {
    const env = fakeEnv();
    const project = tmp("duo-gs-proj-");
    const mod = join(process.cwd(), "dist", "src", "state", "gemini-state.js");
    const code = `import(${JSON.stringify(mod)}).then((m) => { const d = m.chainStateDir(${JSON.stringify(project)}, "c1", process.env); m.createPrivateHome(d, process.env); })`;
    const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise<number>((res) => {
      const c = spawn(process.execPath, ["-e", code], { env: { ...env, PATH: process.env.PATH }, stdio: "ignore" });
      c.on("exit", (code) => res(code ?? 1));
    })));
    assert.deepEqual(runs, Array(8).fill(0));
  });
});

describe("HOME privado idempotente", () => {
  it("createPrivateHome twice works when the real Keychains does not exist (dangling link)", () => {
    const home = tmp("duo-gs-nohome-");
    const env = { HOME: home };
    const dir = chainStateDir(tmp("duo-gs-proj-"), "c", env);
    createPrivateHome(dir, env);
    assert.doesNotThrow(() => createPrivateHome(dir, env));
  });
});

describe("trava e caminhos da cadeia", () => {
  it("invalid chain ids are refused and never resolve outside the project dir", async () => {
    const { chainStatePath, removeChainStateSafe } = await import("../src/state/gemini-state.js");
    const env = fakeEnv();
    const project = tmp("duo-gs-proj-");
    assert.throws(() => chainStatePath(project, "../x", env));
    assert.throws(() => chainStatePath(project, "a/b", env));
    assert.equal(removeChainStateSafe(tmp("duo-gs-victim-"), project, "../..", env), false);
  });
  it("an abandoned empty chain lock (sibling file) is recovered", async () => {
    const { claimChainState } = await import("../src/state/gemini-state.js");
    const env = fakeEnv();
    const dir = chainStateDir(tmp("duo-gs-proj-"), "c", env);
    writeFileSync(`${dir}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${dir}.lock`, old, old); // ilegível e velho (>10 s): o withFileLock recupera
    const release = claimChainState(dir);
    release();
  });
});
