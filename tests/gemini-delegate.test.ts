// Delegação ao executor Gemini de ponta a ponta com o agy falso (sem rede, sem cota).
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GEMINI_VERIFIED, isVerifiedAgy } from "../src/adapters/gemini.js";
import { doctor, formatDoctor } from "../src/cli/doctor.js";
import { applyTask, cancelRun, refreshInterrupted } from "../src/orchestration/control.js";
import { DRIFT_MARKER, failDrift, finishDrift, geminiConfigRoots, lastGeminiDrift, startDrift } from "../src/orchestration/drift-check.js";
import { delegate, type DelegateOptions } from "../src/orchestration/delegate.js";
import { cliEntry, packageRoot } from "../src/paths.js";
import { Store } from "../src/state/store.js";
import { baseRequest, fakeAgyCommand, makeSandbox, withFakeAgyPath, type Sandbox } from "./helpers.js";

const FAKE_AGY = join(packageRoot(), "tests", "fixtures", "fake-agy.mjs");
const VERIFIED = [{ version: "1.5.3", platform: "darwin" as const }];
let sb: Sandbox | undefined;
afterEach(() => { sb?.cleanup(); sb = undefined; });

function setup(extra: Record<string, unknown> = {}): Sandbox {
  // fakeAgyCommand: no Windows nativo, shim .cmd no PATH (a config do gemini aceita só um caminho).
  sb = makeSandbox({ executors: { gemini: { enabled: true, command: fakeAgyCommand() } }, billing: { acknowledgeUnverifiableExtraUsage: { gemini: true } }, ...extra });
  sb.env.PATH = withFakeAgyPath(`${join(process.execPath, "..")}${delimiter}${sb.env.PATH ?? ""}`);
  // Estado das cadeias dentro do sandbox: no Windows nativo a raiz vem do LOCALAPPDATA, qualquer que seja a plataforma injetada.
  sb.env.LOCALAPPDATA = join(sb.home, "AppData", "Local");
  return sb;
}
function req(over: Record<string, unknown> = {}) {
  return baseRequest("claude", { executor: "gemini", model: "gemini-4-argon-high", ...over });
}
// Plataforma injetada (darwin): os testes offline não dependem do sistema que roda a suíte.
async function run(s: Sandbox, r: Record<string, unknown>, env: Record<string, string> = {}, gemini: DelegateOptions["gemini"] = { verified: VERIFIED, sandbox: false }) {
  return delegate({ cwd: s.root, requestPath: s.request(r), env: { ...s.env, ...env }, authPaths: s.authPaths, gemini: { platform: "darwin", ...gemini } });
}
async function resume(s: Sandbox, taskId: string, env: Record<string, string> = {}, gemini: DelegateOptions["gemini"] = { verified: VERIFIED, sandbox: false }) {
  return delegate({ cwd: s.root, resumeTaskId: taskId, env: { ...s.env, ...env }, authPaths: s.authPaths, gemini: { platform: "darwin", ...gemini } });
}
const WIN_GATE = { platform: "win32" as const, nodePath: "C:\\Program Files\\nodejs\\node.exe" };
const agyRuns = (s: Sandbox) => s.log().filter((e) => e.cmd === "agy-run") as { args: string[]; stdin: string; home: string; tmpdir: string; cwd: string }[];
const task = (s: Sandbox, id: unknown) => new Store(s.root).findTask(String(id))!;

describe("delegação ao gemini", () => {
  it("implement runs in a worktree with private HOME/TMPDIR and the prompt only on stdin", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const t = task(s, out.summary.taskId);
    assert.equal(t.isolation, "worktree");
    const [call] = agyRuns(s);
    assert.ok(call);
    assert.ok(!call.home.startsWith(s.home + "/.gemini") && call.home.includes("gemini-state"));
    assert.ok(call.tmpdir.startsWith(call.home));
    assert.ok(call.stdin.includes("Adicionar a constante nova"));
    assert.ok(!call.args.join(" ").includes("Adicionar a constante nova"));
    const inv = readFileSync(join(t.artifactsDir, "invocation.json"), "utf8");
    assert.ok(!inv.includes("Adicionar a constante nova"));
    assert.ok(existsSync(join(call.cwd, ".agents", "hooks.json")));
    assert.ok(!readFileSync(join(t.artifactsDir, "changes.patch"), "utf8").includes(".agents"));
    assert.equal(s.read("src/app.ts"), "export const app = 1;\n");
  });

  it("missing ancestors are created in the worktree only", async () => {
    const s = setup();
    const out = await run(s, req({ scope: { allowedPaths: ["src/new/deep/mod.ts"] } }), { FAKE_AGY_WRITES: JSON.stringify({ "src/new/deep/mod.ts": "x\n" }) });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.equal(existsSync(join(s.root, "src", "new")), false);
  });

  it("review also runs in a worktree (gemini never runs in-place)", async () => {
    const s = setup();
    const out = await run(s, req({ kind: "review", scope: { allowedPaths: ["src"] } }));
    assert.equal(task(s, out.summary.taskId).isolation, "worktree", JSON.stringify(out.summary));
  });

  it("gemini prompt has no shell permission and leaves acceptance to the bridge", async () => {
    const s = setup();
    const out = await run(s, req({ acceptance: { criteria: ["arquivo atualizado"], commands: [{ name: "t", argv: ["node", "-e", "0"] }] } }), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "y\n" }) });
    assert.ok(out.summary.taskId, JSON.stringify(out.summary));
    const prompt = readFileSync(join(task(s, out.summary.taskId).artifactsDir, "prompt.txt"), "utf8");
    assert.doesNotMatch(prompt, /cat or sed|If you run them yourself/);
    assert.match(prompt, /do not run any program|não rode nenhum programa/i);
  });

  it("model outside ^gemini- is refused before invocation", async () => {
    const s = setup();
    const out = await run(s, req({ model: "claude-opus-5-5-high" }));
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /gemini-/);
    assert.equal(agyRuns(s).length, 0);
  });

  it("pinned model incompatible with the explicit effort is blocked before invocation", async () => {
    const s = setup();
    const out = await run(s, req({ model: "gemini-4-argon-low", effort: "high" }));
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /esforço/);
    assert.equal(agyRuns(s).length, 0);
  });

  it("only agy 1.5.14 on macOS is verified by default", () => {
    assert.deepEqual(GEMINI_VERIFIED, [{ version: "1.5.14", platform: "darwin" }]);
    assert.equal(isVerifiedAgy("1.5.14", "darwin"), true);
    assert.equal(isVerifiedAgy("1.5.15", "darwin"), false);
    assert.equal(isVerifiedAgy("1.5.14", "linux"), false);
    assert.equal(isVerifiedAgy("1.5.14-rc.1", "darwin"), false);
  });

  it("the default list admits the exact 1.5.14 build and refuses a 1.5.14 build with metadata", async () => {
    const ok = setup();
    const good = await run(ok, req(), { FAKE_AGY_VERSION: "1.5.14", FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, { sandbox: false });
    assert.equal(good.summary.state, "succeeded", JSON.stringify(good.summary));
    ok.cleanup(); sb = undefined;
    for (const v of ["1.5.14+build.7", "1.5.14-rc.1", "agy 1.5.14"]) {
      const s = setup();
      const out = await run(s, req(), { FAKE_AGY_VERSION: v }, { sandbox: false });
      assert.equal(out.summary.state, "blocked", v);
      assert.match(String(out.summary.outcome), /não verificada/, v);
      // Versão simples aparece como está; outra saída vira só um hash (nunca texto cru na task/telemetria).
      assert.ok(String(out.summary.outcome).includes(/^\d+\.\d+\.\d+/.test(v) ? v : "sha256:"), String(out.summary.outcome));
      assert.equal(agyRuns(s).length, 0, v);
      s.cleanup(); sb = undefined;
    }
  });

  it("a --version probe that exits nonzero is never verified, even printing 1.5.14", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_VERSION: "1.5.14", FAKE_AGY_VERSION_EXIT: "1" }, { sandbox: false });
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.equal(agyRuns(s).length, 0);
  });

  it("an agy version outside the default verified list is refused", async () => {
    const s = setup();
    const out = await run(s, req(), {}, { sandbox: false });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /não verificada/);
    assert.equal(agyRuns(s).length, 0);
  });

  it("unsupported platform (linux) refuses every kind", async () => {
    const s = setup();
    const out = await run(s, req({ kind: "review", scope: { allowedPaths: ["src"] } }), {}, { verified: [{ version: "1.5.3", platform: "linux" }], sandbox: false, platform: "linux" });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /exige macOS ou Windows nesta versão/);
  });

  it("win32 passes the gates without sandbox-exec and the preflight runs in the attempt dir", async () => {
    const s = setup();
    const envOut = join(s.home, "agy-env.jsonl");
    let probed = 0;
    const withAcceptance = req({ acceptance: { criteria: ["src/app.ts exporta a constante nova"], commands: [{ name: "smoke", argv: ["node", "-e", "0"] }] } });
    const out = await run(s, withAcceptance, { LOCALAPPDATA: join(s.home, "AppData", "Local"), FAKE_AGY_ENV_OUT: envOut, FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) },
      { verified: [{ version: "1.5.3", platform: "win32" }], platform: "win32", probe: () => { probed++; return { ok: false, reason: "não deveria rodar" }; }, gate: WIN_GATE });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.match(JSON.stringify(out.summary), /"name":"smoke","ran":true,"passed":true/);
    assert.equal(probed, 0);
    const [call] = agyRuns(s);
    assert.ok(call);
    const hook = (JSON.parse(readFileSync(join(call.cwd, ".agents", "hooks.json"), "utf8")) as Record<string, { PreToolUse: { hooks: { command: string }[] }[] }>)["duo-gate"]?.PreToolUse[0]?.hooks[0]?.command ?? "";
    assert.match(hook, /^set "NODE_OPTIONS=" && set "PATH=C:\\Program Files\\nodejs" && node "[^"]+" "[^"]+" "[^"]+" "\d+"$/, hook);
    const lines = readFileSync(envOut, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    const login = lines.filter((l) => l.argv[0] === "models").at(-1);
    assert.ok(login && /attempt-/.test(login.cwd), JSON.stringify(login));
    const inv = readFileSync(join(task(s, out.summary.taskId).artifactsDir, "invocation.json"), "utf8");
    assert.ok(!inv.includes("sandbox-exec"), inv.slice(0, 400));
    assert.equal(task(s, out.summary.taskId).model.reported, "gemini-4-argon-high");
  });

  it("win32: a hook path the Windows command line refuses blocks the task (persisted, nothing launched)", async () => {
    const s = setup();
    const out = await run(s, req(), {}, { verified: [{ version: "1.5.3", platform: "win32" }], platform: "win32", gate: { platform: "win32", nodePath: "C:\\Users\\O'Neil\\node.exe" } });
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.match(String(out.summary.outcome), /gate do gemini: .*caractere não suportado/);
    assert.equal(task(s, out.summary.taskId).state, "blocked");
    assert.equal(agyRuns(s).length, 0);
  });

  it("win32: an agy config file above the worktree blocks before the gate is written", async () => {
    const s = setup();
    writeFileSync(join(s.root, ".duo", ".codeium.yml"), "");
    const out = await run(s, req(), {}, { verified: [{ version: "1.5.3", platform: "win32" }], platform: "win32", gate: WIN_GATE });
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.match(String(out.summary.outcome), /config do agy acima da worktree \(\.codeium\.yml, 2 níveis acima\): remova ou mova o arquivo/);
    assert.ok(!String(out.summary.outcome).includes(s.root), "caminho completo não aparece");
    assert.equal(existsSync(join(s.root, ".duo", "worktrees", String(out.summary.taskId), ".agents", "hooks.json")), false);
    assert.equal(agyRuns(s).length, 0);
  });

  // O perfil do macOS cria um link para o Keychain: no Windows nativo isso pede privilégio de symlink.
  it("darwin does not check agy config files above the worktree", { skip: process.platform === "win32" }, async () => {
    const s = setup();
    writeFileSync(join(s.root, ".duo", ".codeium.yml"), "");
    const mac = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) });
    assert.equal(mac.summary.state, "succeeded", JSON.stringify(mac.summary));
  });

  it("win32: an agy config file in the project root is refused before the snapshot, and resume works once it is removed", async () => {
    const s = setup();
    writeFileSync(join(s.root, "codeium.yaml"), "");
    const out = await run(s, req(), {}, { verified: [{ version: "1.5.3", platform: "win32" }], platform: "win32", gate: WIN_GATE });
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.match(JSON.stringify(out.summary), /config do agy acima da worktree \(codeium\.yaml, 3 níveis acima\)/);
    assert.equal(agyRuns(s).length, 0);
    rmSync(join(s.root, "codeium.yaml"));
    assert.ok(out.summary.taskId, "o bloqueio devolve a tarefa para o --resume");
    const again = await resume(s, String(out.summary.taskId), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, { verified: [{ version: "1.5.3", platform: "win32" }], platform: "win32", gate: WIN_GATE });
    assert.equal(again.summary.state, "succeeded", JSON.stringify(again.summary));
    assert.equal(again.summary.taskId, out.summary.taskId);
  });

  it("win32: an agy config that appears during the login check still blocks before the spawn", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_MODELS_TOUCH: join(s.root, ".duo", "codeium.yml") }, { verified: [{ version: "1.5.3", platform: "win32" }], platform: "win32", gate: WIN_GATE });
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.match(String(out.summary.outcome), /config do agy acima da worktree \(codeium\.yml, 2 níveis acima\)/);
    assert.equal(agyRuns(s).length, 0);
  });

  it("win32: a refused probe profile blocks with its own reason, not as an unverified version", async () => {
    const s = setup();
    const local = join(s.home, "AppData", "Local");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, ".codeium.yml"), "");
    const out = await run(s, req(), { LOCALAPPDATA: local }, { verified: [{ version: "1.5.3", platform: "win32" }], platform: "win32" });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /sonda do agy: .*config do agy acima/);
    assert.doesNotMatch(String(out.summary.outcome), /não verificada/);
    assert.equal(agyRuns(s).length, 0);
  });

  it("failed OS probe refuses a review too", async () => {
    const s = setup();
    const out = await run(s, req({ kind: "review", scope: { allowedPaths: ["src"] } }), {}, { verified: VERIFIED, probe: () => ({ ok: false, reason: "sem sandbox" }) });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /sem sandbox/);
  });

  it("GEMINI_API_KEY in the brain env blocks before sanitizing", async () => {
    const s = setup();
    const out = await run(s, req(), { GEMINI_API_KEY: "x" });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /GEMINI_API_KEY/);
    assert.equal(agyRuns(s).length, 0);
  });

  it("a deny glob the OS profile cannot enforce blocks before any worktree is created", async () => {
    const s = setup({ scope: { deny: [".git/**", ".duo/**", "?.txt"] } });
    const out = await run(s, req());
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.match(String(out.summary.outcome), /scope\.deny/);
    assert.equal(task(s, out.summary.taskId).worktree ?? null, null);
    assert.equal(agyRuns(s).length, 0);
  });

  it("an API-key login signal blocks before the model call", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_AUTH: "apikey" });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /api_key/);
    assert.equal(agyRuns(s).length, 0);
  });

  it("denied action with no report → failed summary names the action", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_SCENARIO: "synthetic-denied-empty" });
    assert.equal(out.summary.state, "failed");
    assert.match(String(out.summary.outcome), /negada pela contenção.*write_file/);
  });

  it("served model from the gate log is recorded", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "z\n" }) });
    assert.equal(task(s, out.summary.taskId).model.reported, "gemini-4-argon-high");
  });

  it("a gemini task blocked before admission is still resumable (born in a worktree)", async () => {
    const s = setup();
    const blocked = await run(s, req(), { FAKE_AGY_VERSION: "1.5.2" });
    assert.equal(blocked.summary.state, "blocked", JSON.stringify(blocked.summary));
    assert.equal(task(s, blocked.summary.taskId).isolation, "worktree");
    const out = await resume(s, String(blocked.summary.taskId), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  });

  it("an explicit in-place gemini request is persisted as worktree and stays resumable", async () => {
    const s = setup();
    const blocked = await run(s, req({ isolation: "in-place" }), { FAKE_AGY_VERSION: "1.5.2" });
    assert.equal(blocked.summary.state, "blocked", JSON.stringify(blocked.summary));
    assert.equal(task(s, blocked.summary.taskId).isolation, "worktree");
    const out = await resume(s, String(blocked.summary.taskId), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  });

  it("a worktree created for another executor gets .agents excluded from the gemini patch", async () => {
    const s = setup();
    const blocked = await run(s, req(), { FAKE_AGY_AUTH: "apikey" });
    assert.equal(blocked.summary.state, "blocked", JSON.stringify(blocked.summary));
    const store = new Store(s.root);
    const t = task(s, blocked.summary.taskId);
    t.worktreeLinks = (t.worktreeLinks ?? []).filter((l) => l !== ".agents"); store.saveTask(t);
    const out = await resume(s, String(blocked.summary.taskId), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const patch = readFileSync(join(task(s, out.summary.taskId).artifactsDir, "changes.patch"), "utf8");
    assert.ok(!patch.includes(".agents"));
  });

  it("chain state is removed after apply", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 3;\n" }) });
    const t = task(s, out.summary.taskId);
    assert.ok(t.geminiStateDir && existsSync(t.geminiStateDir));
    const r = applyTask(s.root, t.taskId, s.env);
    assert.ok(r.ok, r.message);
    assert.equal(existsSync(t.geminiStateDir), false);
    assert.equal(s.read("src/app.ts"), "export const app = 3;\n");
  });

  // MSIX no Windows (AppData\Local virtualizado) e /var no macOS: a mesma pasta por outro caminho.
  it("chain state is removed after apply even when the project is reached by a non-canonical path", { skip: process.platform === "win32" }, async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 4;\n" }) });
    const t = task(s, out.summary.taskId);
    assert.ok(t.geminiStateDir && existsSync(t.geminiStateDir));
    const alias = join(s.tmp, "alias-proj");
    symlinkSync(s.root, alias);
    const r = applyTask(alias, t.taskId, s.env);
    assert.ok(r.ok, r.message);
    assert.equal(existsSync(t.geminiStateDir), false);
  });

  it("with the real sandbox on, the run still succeeds", { skip: process.platform !== "darwin" }, async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 4;\n" }), FAKE_LOG: "" }, { verified: VERIFIED });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  });
});

describe("limpeza do HOME do gemini por qualquer executor", () => {
  it("apply of a codex task that closes the chain removes the chain's gemini state", async () => {
    const { chainStateDir } = await import("../src/state/gemini-state.js");
    const s = setup();
    const out = await run(s, baseRequest("claude", { executor: "codex", isolation: "worktree" }), { FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 1;\nexport const nova = 2;\n" }) });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const t = task(s, out.summary.taskId);
    const chainId = t.selection?.chainId ?? t.taskId;
    const dir = chainStateDir(s.root, chainId, s.env);
    assert.ok(existsSync(dir));
    const r = applyTask(s.root, t.taskId, s.env);
    assert.ok(r.ok, r.message);
    assert.equal(existsSync(dir), false);
  });
});

describe("classe da cadeia para o prune", () => {
  it("an earlier applied attempt does not make a resumed chain terminal", async () => {
    const { classifyGeminiChain } = await import("../src/orchestration/control.js");
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 3;\n" }) });
    const store = new Store(s.root);
    const t = task(s, out.summary.taskId);
    t.applied = true; store.saveTask(t);
    const chainId = t.selection?.chainId ?? t.taskId;
    assert.equal(classifyGeminiChain(s.root, chainId), "terminal");
    store.updateChain(t.runId, chainId, (c) => { c.latestTaskId = "task-later"; c.status = "blocked"; });
    assert.equal(classifyGeminiChain(s.root, chainId), "resumable");
  });
});

describe("posse do estado do gemini", () => {
  it("an early exit (login refused) releases the in-use claim", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_AUTH: "apikey" });
    assert.equal(out.summary.state, "blocked");
    const dir = task(s, out.summary.taskId).geminiStateDir as string;
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("inuse-")), []);
  });
});

describe("limpeza amarrada à cadeia da task", () => {
  it("apply does not delete another chain's state when selection.chainId points elsewhere", async () => {
    const s = setup();
    const a = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 5;\n" }) });
    const b = await run(s, req({ runId: a.summary.runId, scope: { allowedPaths: ["src/util.ts"] } }), { FAKE_AGY_WRITES: JSON.stringify({ "src/util.ts": "export const util = 5;\n" }) });
    const store = new Store(s.root);
    const ta = store.findTask(String(a.summary.taskId))!;
    const tb = store.findTask(String(b.summary.taskId))!;
    assert.ok(tb.geminiStateDir && existsSync(tb.geminiStateDir));
    // adultera a task A para apontar para a cadeia da task B
    (ta as { selection: unknown }).selection = { ...(ta.selection ?? {}), chainId: tb.selection?.chainId ?? tb.taskId };
    store.saveTask(ta);
    const r = applyTask(s.root, ta.taskId, s.env);
    assert.ok(r.ok, r.message);
    assert.ok(existsSync(tb.geminiStateDir), "estado da outra cadeia preservado");
  });
});

describe("conferência pós-tarefa no Windows (só avisa)", () => {
  const WIN = { verified: [{ version: "1.5.3", platform: "win32" as const }], platform: "win32" as const, gate: WIN_GATE };
  const marker = (s: Sandbox, id: unknown) => join(task(s, id).artifactsDir, DRIFT_MARKER);

  it("a write into the main checkout during the attempt is reported; the task still succeeds; apply needs --ack-drift", async () => {
    const s = setup();
    const out = await run(s, req(), { USERPROFILE: s.home, FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }), FAKE_AGY_ABS_WRITES: JSON.stringify({ [join(s.root, "notes.txt")]: "fora da worktree\n" }) }, WIN);
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const t = task(s, out.summary.taskId);
    assert.equal(t.drift?.status, "complete");
    assert.ok(t.drift?.changed.some((p) => p.endsWith("notes.txt")), JSON.stringify(t.drift));
    assert.ok(t.limitations.includes("checkout drift during the Gemini attempt (1 paths)"), JSON.stringify(t.limitations));
    assert.equal(existsSync(marker(s, t.taskId)), false);
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const rep = await doctor(s.root, { ...s.env, USERPROFILE: s.home }, s.authPaths, offline, { platform: "win32", verified: WIN.verified });
    assert.match(formatDoctor(rep), new RegExp(`conferência pós-tarefa do gemini: ${t.taskId} — 1 caminho\\(s\\) mudaram fora da worktree; apply pede --ack-drift`), formatDoctor(rep));
    const refused = applyTask(s.root, t.taskId, s.env);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /--ack-drift/);
    assert.match(refused.message, /\b1\b/);
    assert.match(refused.message, /notes\.txt/);
    assert.ok(refused.message.includes(join(t.artifactsDir, "task.json")), refused.message);
    const ok = applyTask(s.root, t.taskId, s.env, { ackDrift: true });
    assert.ok(ok.ok, ok.message);
    assert.ok(task(s, t.taskId).appliedAt);
  });

  it("a sibling apply during the attempt is named in appliedNotes", async () => {
    const s = setup();
    const sib = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 9;\n" }) });
    assert.equal(sib.summary.state, "succeeded", JSON.stringify(sib.summary));
    const execOut = join(s.home, "exec.out");
    const out = await run(s, req(), { FAKE_AGY_EXEC: JSON.stringify([cliEntry(), "apply", "--task-id", String(sib.summary.taskId)]), FAKE_AGY_EXEC_CWD: s.root, FAKE_AGY_EXEC_OUT: execOut, FAKE_AGY_EXEC_ENV: JSON.stringify({ LOCALAPPDATA: s.env.LOCALAPPDATA }) }, WIN);
    assert.ok(task(s, sib.summary.taskId).applied, readFileSync(execOut, "utf8"));
    const d = task(s, out.summary.taskId).drift;
    assert.ok(d?.appliedNotes.some((n) => n.taskId === String(sib.summary.taskId) && n.path.endsWith(join("src", "app.ts"))), JSON.stringify(d));
  });

  it("darwin writes no marker and no task.drift", { skip: process.platform === "win32" }, async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }), FAKE_AGY_ABS_WRITES: JSON.stringify({ [join(s.root, "notes.txt")]: "x\n" }) });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.equal(task(s, out.summary.taskId).drift, undefined);
    assert.equal(existsSync(marker(s, out.summary.taskId)), false);
  });

  it("recovery: executor alive keeps the marker as pending; once it is dead the comparison is recorded once", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    const store = new Store(s.root);
    const t = task(s, out.summary.taskId);
    delete t.drift;
    startDrift(t, s.root, s.env, "attempt-x");
    writeFileSync(join(s.root, "late.txt"), "x\n");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    t.state = "running";
    t.pids = { bridge: deadPid(), child: child.pid! };
    store.saveTask(t);
    refreshInterrupted(store, t.taskId, s.env);
    let fresh = task(s, t.taskId);
    assert.equal(fresh.drift?.status, "pending");
    assert.equal(fresh.drift?.incomplete, true);
    assert.ok(existsSync(marker(s, t.taskId)));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    refreshInterrupted(store, t.taskId, s.env);
    fresh = task(s, t.taskId);
    assert.equal(fresh.drift?.status, "complete");
    assert.ok(fresh.drift?.changed.some((p) => p.endsWith("late.txt")), JSON.stringify(fresh.drift));
    assert.ok(!fresh.limitations.includes("post-run check incomplete"), JSON.stringify(fresh.limitations));
    assert.equal(existsSync(marker(s, t.taskId)), false);
    const saved = JSON.stringify(fresh.drift);
    writeFileSync(join(s.root, "later.txt"), "x\n");
    refreshInterrupted(store, t.taskId, s.env);
    assert.equal(JSON.stringify(task(s, t.taskId).drift), saved);
  });

  it("a crash between saving task.drift and removing the marker keeps the saved result", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    const store = new Store(s.root);
    const t = task(s, out.summary.taskId);
    startDrift(t, s.root, s.env, "attempt-y");
    writeFileSync(join(s.root, "late.txt"), "x\n");
    t.drift = { attemptId: "attempt-y", status: "complete", changed: ["salvo"], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: false };
    t.pids = { bridge: deadPid(), child: null };
    store.saveTask(t);
    refreshInterrupted(store, t.taskId, s.env);
    assert.deepEqual(task(s, t.taskId).drift?.changed, ["salvo"]);
    assert.equal(existsSync(marker(s, t.taskId)), false);
  });

  it("cancel with a dead executor finishes the comparison from the marker", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    const store = new Store(s.root);
    const t = task(s, out.summary.taskId);
    delete t.drift;
    startDrift(t, s.root, s.env, "attempt-z");
    writeFileSync(join(s.root, "late.txt"), "x\n");
    t.pids = { bridge: deadPid(), child: deadPid() };
    store.saveTask(t);
    await cancelRun(s.root, t.runId, 0, s.env);
    assert.equal(task(s, t.taskId).drift?.status, "complete");
    assert.equal(existsSync(marker(s, t.taskId)), false);
  });

  it("finishDrift with the executor still alive never records a complete result", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    const store = new Store(s.root);
    const t = task(s, out.summary.taskId);
    delete t.drift;
    startDrift(t, s.root, s.env, "attempt-w");
    finishDrift(store, t, s.env, { executorAlive: true });
    assert.deepEqual(task(s, t.taskId).drift, { attemptId: "attempt-w", status: "pending", changed: [], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: true });
    assert.ok(task(s, t.taskId).limitations.includes("post-run check incomplete"));
    assert.ok(existsSync(marker(s, t.taskId)));
  });
});

describe("conferência pós-tarefa: falha fechado (revisão)", () => {
  const WIN = { verified: [{ version: "1.5.3", platform: "win32" as const }], platform: "win32" as const, gate: WIN_GATE };
  const marker = (s: Sandbox, id: unknown) => join(task(s, id).artifactsDir, DRIFT_MARKER);
  async function clean(s: Sandbox) {
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    return task(s, out.summary.taskId);
  }

  it("recovery with no recorded child PID keeps the check pending (executor may still be writing)", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-np");
    t.state = "running";
    t.pids = { bridge: deadPid(), child: null };
    store.saveTask(t);
    refreshInterrupted(store, t.taskId, s.env);
    assert.equal(task(s, t.taskId).drift?.status, "pending");
    assert.ok(existsSync(marker(s, t.taskId)));
  });

  it("a resumed attempt keeps the earlier attempt's unresolved drift; apply still needs --ack-drift", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    t.drift = { attemptId: "attempt-1", status: "complete", changed: [join(s.root, "fora.txt")], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: false };
    const m = startDrift(t, s.root, s.env, "attempt-2");
    finishDrift(store, t, s.env, { executorAlive: false, marker: m });
    const fresh = task(s, t.taskId);
    assert.equal(fresh.drift?.attemptId, "attempt-2");
    assert.deepEqual(fresh.drift?.changed, []);
    assert.equal(fresh.driftHistory?.[0]?.attemptId, "attempt-1");
    assert.ok(fresh.limitations.includes("checkout drift during the Gemini attempt (1 paths)"), JSON.stringify(fresh.limitations));
    const r = applyTask(s.root, t.taskId, s.env);
    assert.equal(r.ok, false);
    assert.match(r.message, /fora\.txt/);
    assert.ok(r.message.includes(`${t.taskId}: driftHistory[0]`), r.message);
  });

  it("an outstanding marker or a pending drift blocks apply without --ack-drift", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-p");
    store.saveTask(t);
    const r = applyTask(s.root, t.taskId, s.env);
    assert.equal(r.ok, false);
    assert.match(r.message, /incompleta/);
  });

  it("a baseline marker that disappeared while the drift was pending is incomplete, not clean", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-gone");
    store.saveTask(t);
    rmSync(marker(s, t.taskId));
    finishDrift(store, t, s.env, { executorAlive: false, recovery: true });
    assert.deepEqual({ status: task(s, t.taskId).drift?.status, incomplete: task(s, t.taskId).drift?.incomplete }, { status: "complete", incomplete: true });
  });

  it("the bridge compares against its in-memory baseline, not a rewritten marker file", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    const m = startDrift(t, s.root, s.env, "attempt-mem");
    writeFileSync(join(s.root, "escondido.txt"), "x\n");
    // o executor reescreve o marcador com um "antes" que já inclui a mudança
    const forged = startDrift(structuredClone(t), s.root, s.env, "attempt-mem");
    assert.ok(forged);
    finishDrift(store, t, s.env, { executorAlive: false, marker: m });
    assert.ok(task(s, t.taskId).drift?.changed.some((p) => p.endsWith("escondido.txt")), JSON.stringify(task(s, t.taskId).drift));
  });

  it("a sibling worktree created after the baseline is seen in the final snapshot", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    const m = startDrift(t, s.root, s.env, "attempt-sib");
    const sib = join(s.root, ".duo", "worktrees", "nova");
    const r = spawnSync("git", ["worktree", "add", "-q", "--detach", sib], { cwd: s.root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    finishDrift(store, t, s.env, { executorAlive: false, marker: m });
    assert.ok(task(s, t.taskId).drift?.changed.some((p) => p.endsWith("nova")), JSON.stringify(task(s, t.taskId).drift));
  });

  // Windows: a ponte grava o "antes" com C:\... e a recuperação pelo duo status recebe a raiz do git como C:/...;
  // a mesma pasta em outra grafia não pode virar "checkout surgido".
  it("recovery reached through another spelling of the project root reports no phantom checkout", async () => {
    const s = setup();
    const t = await clean(s);
    const m = startDrift(t, s.root, s.env, "attempt-spell");
    finishDrift(new Store(`${s.root}/`), t, s.env, { executorAlive: false, marker: m });
    assert.deepEqual(task(s, t.taskId).drift?.changed, [], JSON.stringify(task(s, t.taskId).drift));
  });

  it("a marker written with another spelling of the root (older bridge) still compares the same checkout", async () => {
    const s = setup();
    const t = await clean(s);
    const m = startDrift(t, s.root, s.env, "attempt-old");
    const key = Object.keys(m.before.checkouts).find((k) => k === s.root)!;
    m.before.checkouts = { [`${s.root}/`]: m.before.checkouts[key]! };
    m.checkouts = m.checkouts.map((c) => (c === s.root ? `${s.root}/` : c));
    writeFileSync(join(s.root, "src", "app.ts"), "export const app = 99;\n"); // mudança real ainda tem de aparecer
    finishDrift(new Store(s.root), t, s.env, { executorAlive: false, marker: m });
    assert.deepEqual(task(s, t.taskId).drift?.changed, [join(s.root, "src", "app.ts")], JSON.stringify(task(s, t.taskId).drift));
  });

  it("siblings that cannot be listed make the check incomplete", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    const wts = join(s.root, ".duo", "worktrees");
    const m = startDrift(t, s.root, s.env, "attempt-acl");
    chmodSync(wts, 0o000);
    try { finishDrift(store, t, s.env, { executorAlive: false, marker: m }); } finally { chmodSync(wts, 0o755); }
    assert.equal(task(s, t.taskId).drift?.incomplete, true);
  });

  it("a marker that cannot be read right now stays pending; the baseline is kept", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-lock");
    store.saveTask(t);
    chmodSync(marker(s, t.taskId), 0o000);
    try { finishDrift(store, t, s.env, { executorAlive: false, recovery: true }); } finally { chmodSync(marker(s, t.taskId), 0o644); }
    assert.equal(task(s, t.taskId).drift?.status, "pending");
    assert.ok(existsSync(marker(s, t.taskId)));
  });

  it("a recovery that read the task before a resume never overwrites the new attempt nor removes its marker", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-old");
    store.saveTask(t);
    const stale = task(s, t.taskId);
    const next = task(s, t.taskId);
    startDrift(next, s.root, s.env, "attempt-new");
    next.state = "running";
    store.saveTask(next);
    finishDrift(store, stale, s.env, { executorAlive: false, recovery: true });
    const fresh = task(s, t.taskId);
    assert.equal(fresh.state, "running");
    assert.equal(fresh.drift?.attemptId, "attempt-new");
    assert.ok(existsSync(marker(s, t.taskId)));
  });
});

describe("conferência pós-tarefa: ciclo de vida (revisão 2)", () => {
  const WIN = { verified: [{ version: "1.5.3", platform: "win32" as const }], platform: "win32" as const, gate: WIN_GATE };
  const marker = (s: Sandbox, id: unknown) => join(task(s, id).artifactsDir, DRIFT_MARKER);
  async function clean(s: Sandbox) {
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    return task(s, out.summary.taskId);
  }

  it("an adaptive resume (new task id) cannot apply without --ack-drift for the earlier attempt's drift", async () => {
    const s = setup();
    const first = await run(s, req({ adaptive: true }), { FAKE_AGY_ABS_WRITES: JSON.stringify({ [join(s.root, "fora.txt")]: "x\n" }), FAKE_REPORT: JSON.stringify({ status: "blocked", blockedReason: "precisa de decisão" }) }, WIN);
    assert.equal(first.summary.state, "blocked", JSON.stringify(first.summary));
    assert.ok(task(s, first.summary.taskId).drift?.changed.length, JSON.stringify(task(s, first.summary.taskId).drift));
    const next = await resume(s, String(first.summary.taskId), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    assert.equal(next.summary.state, "succeeded", JSON.stringify(next.summary));
    assert.notEqual(next.summary.taskId, first.summary.taskId); // retomada adaptativa: task nova na mesma cadeia
    const r = applyTask(s.root, String(next.summary.taskId), s.env);
    assert.equal(r.ok, false, r.message);
    assert.match(r.message, /fora\.txt/);
    assert.ok(r.message.includes(`${first.summary.taskId}: drift`), r.message);
  });

  it("an unreadable earlier Gemini attempt in the chain blocks apply and is named", async () => {
    const s = setup();
    const first = await run(s, req({ adaptive: true }), { FAKE_REPORT: JSON.stringify({ status: "blocked", blockedReason: "precisa de decisão" }) }, WIN);
    const next = await resume(s, String(first.summary.taskId), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    assert.equal(next.summary.state, "succeeded", JSON.stringify(next.summary));
    writeFileSync(join(task(s, first.summary.taskId).artifactsDir, "task.json"), "{corrompido");
    const r = applyTask(s.root, String(next.summary.taskId), s.env);
    assert.equal(r.ok, false, r.message);
    assert.match(r.message, new RegExp(`${first.summary.taskId}: tentativa ilegível`));
  });

  it("a second recovery from a stale pending read never replaces a completed comparison", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-c");
    t.pids = { bridge: deadPid(), child: deadPid() };
    store.saveTask(t);
    const stale = task(s, t.taskId);
    writeFileSync(join(s.root, "late.txt"), "x\n");
    finishDrift(store, task(s, t.taskId), s.env, { executorAlive: false, recovery: true });
    finishDrift(store, stale, s.env, { executorAlive: false, recovery: true });
    const d = task(s, t.taskId).drift;
    assert.equal(d?.incomplete, false, JSON.stringify(d));
    assert.ok(d?.changed.some((p) => p.endsWith("late.txt")), JSON.stringify(d));
  });

  it("cancel keeps the dead executor PID while the check is pending, so a later recovery can compare", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-keep");
    writeFileSync(join(s.root, "late.txt"), "x\n");
    t.state = "running";
    t.pids = { bridge: deadPid(), child: deadPid() };
    store.saveTask(t);
    chmodSync(marker(s, t.taskId), 0o000);
    try { await cancelRun(s.root, t.runId, 0, s.env); } finally { chmodSync(marker(s, t.taskId), 0o644); }
    assert.equal(task(s, t.taskId).drift?.status, "pending");
    assert.ok(task(s, t.taskId).pids.child);
    refreshInterrupted(store, t.taskId, s.env);
    assert.equal(task(s, t.taskId).drift?.status, "complete");
    assert.ok(task(s, t.taskId).drift?.changed.some((p) => p.endsWith("late.txt")));
  });

  it("doctor's last warning skips a healthy running attempt", async () => {
    const s = setup();
    const store = new Store(s.root);
    const old = await clean(s);
    old.drift = { attemptId: "old", status: "complete", changed: ["x"], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: false };
    store.saveTask(old);
    const live = await clean(s);
    startDrift(live, s.root, s.env, "attempt-live");
    live.state = "running";
    live.pids = { bridge: process.pid, child: null };
    store.saveTask(live);
    assert.equal(lastGeminiDrift(store)?.taskId, old.taskId);
  });

  it("resume settles the previous attempt with its own (dead) executor PID, keeping the changed paths", async () => {
    const s = setup();
    const first = await run(s, req(), { FAKE_REPORT: JSON.stringify({ status: "blocked", blockedReason: "precisa de decisão" }) }, WIN);
    assert.equal(first.summary.state, "blocked", JSON.stringify(first.summary));
    const store = new Store(s.root);
    const t = task(s, first.summary.taskId);
    startDrift(t, s.root, s.env, "attempt-old");
    t.pids = { bridge: deadPid(), child: deadPid() };
    store.saveTask(t);
    writeFileSync(join(s.root, "durante.txt"), "x\n");
    await resume(s, t.taskId, { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    const old = task(s, t.taskId);
    const all = [old.drift, ...(old.driftHistory ?? [])].filter((d) => d?.attemptId === "attempt-old");
    assert.ok(all.some((d) => d?.status === "complete" && d.changed.some((p) => p.endsWith("durante.txt"))), JSON.stringify(old));
  });

  it("cancel of a running task with a confirmed-dead executor records the comparison", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-cancel");
    writeFileSync(join(s.root, "late.txt"), "x\n");
    t.state = "running";
    t.pids = { bridge: deadPid(), child: deadPid() };
    store.saveTask(t);
    await cancelRun(s.root, t.runId, 0, s.env);
    const fresh = task(s, t.taskId);
    assert.equal(fresh.drift?.status, "complete", JSON.stringify(fresh.drift));
    assert.ok(fresh.drift?.changed.some((p) => p.endsWith("late.txt")));
  });

  it("failDrift after a saved comparison keeps the changed paths", async () => {
    const s = setup();
    const t = await clean(s);
    t.drift = { attemptId: "a", status: "complete", changed: ["x"], appliedNotes: [], hiddenUnchecked: [], unverified: [], incomplete: false };
    failDrift(t, "a");
    assert.deepEqual(t.drift.changed, ["x"]);
    assert.equal(t.drift.incomplete, true);
  });

  it("recovery finishes a pending drift whose marker disappeared (through refreshInterrupted)", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-lost");
    t.pids = { bridge: deadPid(), child: deadPid() };
    store.saveTask(t);
    rmSync(marker(s, t.taskId));
    refreshInterrupted(store, t.taskId, s.env);
    assert.deepEqual({ status: task(s, t.taskId).drift?.status, incomplete: task(s, t.taskId).drift?.incomplete }, { status: "complete", incomplete: true });
  });

  it("siblings not listable at baseline are not reported as created afterwards", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    const sib = join(s.root, ".duo", "worktrees", "irma");
    assert.equal(spawnSync("git", ["worktree", "add", "-q", "--detach", sib], { cwd: s.root }).status, 0);
    const wts = join(s.root, ".duo", "worktrees");
    chmodSync(wts, 0o000);
    let m;
    try { m = startDrift(t, s.root, s.env, "attempt-unlisted"); } finally { chmodSync(wts, 0o755); }
    finishDrift(store, t, s.env, { executorAlive: false, marker: m });
    const d = task(s, t.taskId).drift;
    assert.equal(d?.incomplete, true);
    assert.ok(!d?.changed.some((p) => p.endsWith("irma")), JSON.stringify(d));
  });

  it("a pending check is not rewritten on every status poll", async () => {
    const s = setup();
    const store = new Store(s.root);
    const t = await clean(s);
    startDrift(t, s.root, s.env, "attempt-poll");
    t.pids = { bridge: deadPid(), child: null };
    store.saveTask(t);
    refreshInterrupted(store, t.taskId, s.env);
    const first = task(s, t.taskId).updatedAt;
    await new Promise((r) => setTimeout(r, 20));
    refreshInterrupted(store, t.taskId, s.env);
    assert.equal(task(s, t.taskId).updatedAt, first);
  });

  it("duo apply --ack-drift false is refused (no positional value counts as consent)", async () => {
    const s = setup();
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }), FAKE_AGY_ABS_WRITES: JSON.stringify({ [join(s.root, "notes.txt")]: "x\n" }) }, WIN);
    const r = spawnSync(process.execPath, [cliEntry(), "apply", "--task-id", String(out.summary.taskId), "--ack-drift", "false"], { cwd: s.root, env: s.env, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(task(s, out.summary.taskId).applied, false);
  });
});

describe("raízes de config reais do agy no Windows", () => {
  it("uses USERPROFILE (not HOME), its agent dot-dirs and matching APPDATA/LOCALAPPDATA entries", () => {
    const base = mkdtempSync(join(tmpdir(), "duo-roots-"));
    try {
      const home = join(base, "home"), profile = join(base, "profile"), appData = join(base, "Roaming"), local = join(base, "Local");
      for (const d of [home, join(profile, ".codeium"), join(profile, ".outra"), join(appData, "Antigravity"), join(appData, "Outro"), join(local, "duo")]) mkdirSync(d, { recursive: true });
      const { roots, errors } = geminiConfigRoots({ HOME: home, USERPROFILE: profile, APPDATA: appData, LOCALAPPDATA: local });
      assert.deepEqual(roots, [join(appData, "Antigravity"), join(profile, ".codeium"), join(profile, ".gemini")].sort());
      assert.deepEqual(errors, []);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe("rastreio de lançamentos (DUO_TRACE_LOG, só testes)", () => {
  const WIN = { verified: [{ version: "1.5.3", platform: "win32" as const }], platform: "win32" as const, gate: WIN_GATE };

  it("each agy launch of a delegation records its launcher, PID, image and allowed roots", async () => {
    const s = setup();
    const log = join(s.tmp, "trace.jsonl");
    const prev = process.env.DUO_TRACE_LOG;
    process.env.DUO_TRACE_LOG = log;
    let out;
    try { out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN); }
    finally { if (prev === undefined) delete process.env.DUO_TRACE_LOG; else process.env.DUO_TRACE_LOG = prev; }
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const t = task(s, out.summary.taskId);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { launcher: { pid: number; image: string }; pid: number; image: string; label: string; allowedRoots: string[] });
    const labels = lines.map((l) => l.label);
    for (const want of ["caps agy --version", "caps agy --help", "auth agy models", "delegate agy"]) assert.ok(labels.includes(want), `${want}: ${JSON.stringify(labels)}`);
    for (const l of lines) {
      assert.deepEqual(l.launcher, { pid: process.pid, image: process.execPath });
      assert.ok(Number.isInteger(l.pid) && l.pid > 0 && typeof l.image === "string" && l.image.length > 0, JSON.stringify(l));
    }
    const run1 = lines.find((l) => l.label === "delegate agy")!;
    assert.ok(run1.allowedRoots.includes(t.worktree!), JSON.stringify(run1.allowedRoots));
    assert.ok(run1.allowedRoots.every((r) => r === t.worktree || r.startsWith(t.geminiStateDir!)), JSON.stringify(run1.allowedRoots));
  });

  it("without DUO_TRACE_LOG nothing is recorded", async () => {
    const s = setup();
    assert.equal(process.env.DUO_TRACE_LOG, undefined);
    const out = await run(s, req(), { FAKE_AGY_WRITES: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) }, WIN);
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.equal(existsSync(join(s.tmp, "trace.jsonl")), false);
  });
});

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  return r.pid;
}
