// Delegação ao executor Gemini de ponta a ponta com o agy falso (sem rede, sem cota).
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GEMINI_VERIFIED, isVerifiedAgy } from "../src/adapters/gemini.js";
import { applyTask } from "../src/orchestration/control.js";
import { delegate, type DelegateOptions } from "../src/orchestration/delegate.js";
import { packageRoot } from "../src/paths.js";
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

  it("win32: an agy config file above the worktree blocks before the gate is written; darwin does not check", async () => {
    const s = setup();
    writeFileSync(join(s.root, ".duo", ".codeium.yml"), "");
    const out = await run(s, req(), {}, { verified: [{ version: "1.5.3", platform: "win32" }], platform: "win32", gate: WIN_GATE });
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.match(String(out.summary.outcome), /config do agy acima da worktree \(\.codeium\.yml, 2 níveis acima\): remova ou mova o arquivo/);
    assert.ok(!String(out.summary.outcome).includes(s.root), "caminho completo não aparece");
    assert.equal(existsSync(join(s.root, ".duo", "worktrees", String(out.summary.taskId), ".agents", "hooks.json")), false);
    assert.equal(agyRuns(s).length, 0);
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
