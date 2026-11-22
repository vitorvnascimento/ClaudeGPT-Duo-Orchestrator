// Delegação ao executor Gemini de ponta a ponta com o agy falso (sem rede, sem cota).
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyTask } from "../src/orchestration/control.js";
import { delegate, type DelegateOptions } from "../src/orchestration/delegate.js";
import { packageRoot } from "../src/paths.js";
import { Store } from "../src/state/store.js";
import { baseRequest, makeSandbox, type Sandbox } from "./helpers.js";

const FAKE_AGY = join(packageRoot(), "tests", "fixtures", "fake-agy.mjs");
const VERIFIED = [{ version: "1.5.3", platform: process.platform }];
let sb: Sandbox | undefined;
afterEach(() => { sb?.cleanup(); sb = undefined; });

function setup(extra: Record<string, unknown> = {}): Sandbox {
  sb = makeSandbox({ executors: { gemini: { enabled: true, command: [FAKE_AGY] } }, billing: { acknowledgeUnverifiableExtraUsage: { gemini: true } }, ...extra });
  sb.env.PATH = `${join(process.execPath, "..")}:${sb.env.PATH ?? ""}`;
  return sb;
}
function req(over: Record<string, unknown> = {}) {
  return baseRequest("claude", { executor: "gemini", model: "gemini-4-argon-high", ...over });
}
async function run(s: Sandbox, r: Record<string, unknown>, env: Record<string, string> = {}, gemini: DelegateOptions["gemini"] = { verified: VERIFIED, sandbox: false }) {
  return delegate({ cwd: s.root, requestPath: s.request(r), env: { ...s.env, ...env }, authPaths: s.authPaths, gemini });
}
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

  it("unverified agy version is refused (default list is empty)", async () => {
    const s = setup();
    const out = await run(s, req(), {}, { sandbox: false });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /não verificada/);
    assert.equal(agyRuns(s).length, 0);
  });

  it("non-darwin platform refuses every kind", async () => {
    const s = setup();
    const out = await run(s, req({ kind: "review", scope: { allowedPaths: ["src"] } }), {}, { verified: [{ version: "1.5.3", platform: "linux" }], sandbox: false, platform: "linux" });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /macOS/);
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
