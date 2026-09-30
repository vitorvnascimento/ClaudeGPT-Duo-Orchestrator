// Regressões offline dos seis achados de continuidade/qualidade (imagem está em router.test).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { delegate } from "../src/orchestration/delegate.js";
import { quotaStatePath } from "../src/orchestration/quota.js";
import { Store, writeJsonAtomic } from "../src/state/store.js";
import { baseRequest, makeSandbox, type Sandbox } from "./helpers.js";

let s: Sandbox;
afterEach(() => s?.cleanup());
const env = { FAKE_ADAPTIVE_CATALOG: "1" };
const edit = { "src/app.ts": "export const app = 1;\nexport const nova = 2;\n" };
const acceptance = { criteria: ["nova"], commands: [{ name: "nova", argv: ["node", "-e", 'process.exit(require("fs").readFileSync("src/app.ts","utf8").includes("nova") ? 0 : 1)'] }] };
const ok = { criteria: ["verificado"], commands: [{ name: "ok", argv: ["node", "-e", "process.exit(0)"] }] };
const request = (extra: Record<string, unknown> = {}) => baseRequest("claude", { adaptive: true, risk: "low", acceptance, ...extra });
const run = (req: Record<string, unknown>, fake: Record<string, string> = {}) => delegate({ cwd: s.root, requestPath: s.request(req), env: { ...s.env, ...env, ...fake }, authPaths: s.authPaths });
const resume = (taskId: unknown, fake: Record<string, string> = {}) => delegate({ cwd: s.root, resumeTaskId: String(taskId), env: { ...s.env, ...env, ...fake }, authPaths: s.authPaths });
const saved = (id: unknown) => new Store(s.root).findTask(String(id))!;

it("adversarial 1: piso valida modelo explícito efetivo antes da execução", async () => {
  s = makeSandbox();
  s.write("auth/login.ts", "export const login = true;\n");
  s.git("add", "auth/login.ts"); s.git("commit", "-qm", "auth");
  const out = await run(request({ risk: "high", scope: { allowedPaths: ["auth/login.ts"] }, model: "gpt-6-luna", acceptance: ok }));
  assert.equal(out.summary.state, "blocked");
  assert.equal(s.execCalls().length, 0);
  assert.match(String(out.summary.outcome), /risco\/escopo exige nível deep; gpt-6-luna é light/);
  assert.match(JSON.stringify(saved(out.summary.taskId).selection?.reason), /Remova.*model/);
});

it("adversarial 1: catálogo ausente não mascara modelo configurado ou piso desconhecido", async () => {
  s = makeSandbox({ executors: { codex: { model: "gpt-6-luna" } } });
  const first = await run(request({ risk: "high", acceptance: ok }), { FAKE_NO_CATALOG: "1" });
  assert.equal(first.summary.state, "blocked");
  assert.equal(saved(first.summary.taskId).selection?.tier, "light");
  s.config({ executors: { codex: { model: null } } });
  const unknown = await run(request({ risk: "high", model: "future-unclassified", acceptance: ok }));
  assert.equal(unknown.summary.state, "blocked");
  const cliDefault = await run(request({ risk: "high", acceptance: ok }), { FAKE_NO_CATALOG: "1" });
  assert.equal(cliDefault.summary.state, "blocked");
  assert.equal(s.execCalls().length, 0);
});

it("adversarial 1: effort explícito abaixo de high bloqueia piso deep; disabled preserva contrato", async () => {
  s = makeSandbox();
  const first = await run(request({ risk: "high", model: "gpt-6-astra", effort: "low", acceptance: ok }));
  assert.equal(first.summary.state, "blocked"); assert.equal(s.execCalls().length, 0);
  assert.match(String(first.summary.outcome), /effort.*low.*high/);
  const disabled = await run(request({ adaptive: false, risk: "high", model: "gpt-6-luna", effort: "low", acceptance: ok }));
  assert.equal(disabled.summary.state, "succeeded"); assert.equal(s.execCalls().length, 1);
});

it("adversarial 3: fallback de cota conserva xhigh alcançado pela verificação", async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 3 } }, limits: { maxDelegationsPerRun: 5 } });
  const out = await run(request({ complexity: "deep", isolation: "worktree" }), {
    FAKE_CODEX_EXTRA_MODELS: JSON.stringify([{ id: "gpt-5.6-astra" }]),
    FAKE_SCENARIO_BY_ATTEMPT: JSON.stringify({ 2: "rate-limit" }),
    FAKE_QUOTA_AFTER_EXEC: JSON.stringify({ ordinaryUsageAllowed: true, rateLimitsByLimitId: { astra: { normalModelSlug: "gpt-6-astra", primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } }),
    FAKE_WRITE_BY_ATTEMPT: JSON.stringify({ 3: edit }),
  });
  assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  assert.deepEqual(s.execCalls().map((c) => c.model), ["gpt-6-astra", "gpt-6-astra", "gpt-5.6-astra"]);
  assert.deepEqual(s.execCalls().map((c) => c.effort), ['model_reasoning_effort="high"', 'model_reasoning_effort="xhigh"', 'model_reasoning_effort="xhigh"']);
});

it("adversarial 3: sem destino que sustente xhigh bloqueia sem executar high", async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 3 }, include: ["codex:gpt-6-astra", "codex:gpt-5.6-astra"] }, limits: { maxDelegationsPerRun: 5 } });
  const out = await run(request({ complexity: "deep", isolation: "worktree" }), {
    FAKE_CODEX_EXTRA_MODELS: JSON.stringify([{ id: "gpt-5.6-astra", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }]),
    FAKE_SCENARIO_BY_ATTEMPT: JSON.stringify({ 2: "rate-limit" }),
    FAKE_QUOTA_AFTER_EXEC: JSON.stringify({ ordinaryUsageAllowed: true, rateLimitsByLimitId: { astra: { normalModelSlug: "gpt-6-astra", primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } }),
  });
  assert.equal(out.summary.state, "blocked");
  assert.equal(s.execCalls().length, 2);
  assert.equal(saved(out.summary.taskId).effort?.requested, "xhigh");
  assert.match(String(out.summary.outcome), /nenhum modelo equivalente.*esforço >= xhigh/);
});

it("adversarial 4: retomada mantém campos automáticos escaláveis e pedido original intocado", async () => {
  s = makeSandbox({ limits: { maxDelegationsPerRun: 5 } });
  const req = request({ isolation: "worktree" });
  const first = await run(req, { FAKE_REPORT: JSON.stringify({ status: "blocked", blockedReason: "Precisa de decisão do cérebro" }) });
  assert.equal(first.summary.state, "blocked");
  const out = await resume(first.summary.taskId, { FAKE_WRITE_BY_ATTEMPT: JSON.stringify({ 2: edit }) });
  assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  assert.equal(saved(out.summary.taskId).selection?.attempt, 2);
  assert.deepEqual(s.execCalls().map((c) => c.model), ["gpt-6-luna", "gpt-6-luna", "gpt-6.1-sol"]);
  for (const t of new Store(s.root).listTasks(new Store(s.root).loadRun(String(out.summary.runId))!)) {
    assert.deepEqual(JSON.parse(readFileSync(join(t.artifactsDir, "request.json"), "utf8")), req);
  }
});

it("adversarial 4: task legada sem origin retoma pedido original da raiz", async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 3 } }, limits: { maxDelegationsPerRun: 5 } });
  const req = request({ isolation: "worktree" });
  const first = await run(req, { FAKE_SCENARIO_BY_ATTEMPT: JSON.stringify({ 1: "rate-limit" }), FAKE_REPORT_BY_ATTEMPT: JSON.stringify({ 2: { status: "blocked", blockedReason: "Precisa de decisão do cérebro" } }) });
  assert.equal(first.summary.state, "blocked");
  const store = new Store(s.root), t = saved(first.summary.taskId), root = saved(t.selection?.attemptOf);
  assert.equal(t.selection?.attempt, 2);
  for (const old of [root, t]) {
    delete old.selection!.origin; delete old.selection!.chainRoot; store.saveTask(old);
  }
  // Formato antigo: a tentativa descendente salvava model/effort resolvidos no request.
  writeJsonAtomic(join(t.artifactsDir, "request.json"), { ...req, executor: t.executor, model: t.model.requested, effort: t.effort?.requested });
  const out = await resume(t.taskId, { FAKE_WRITE_BY_ATTEMPT: JSON.stringify({ 3: edit }) });
  assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  assert.equal(saved(out.summary.taskId).selection?.attempt, 3);
  assert.equal(saved(out.summary.taskId).selection?.origin?.effort, "auto");
  assert.deepEqual(JSON.parse(readFileSync(join(saved(out.summary.taskId).artifactsDir, "request.json"), "utf8")), req);
});

it("adversarial 5: retomada antes da base conserva orçamento de toda a cadeia", async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 2 } }, limits: { maxDelegationsPerRun: 5 } });
  const first = await run(request({ complexity: "standard", acceptance: ok }), { FAKE_SCENARIO: "rate-limit", FAKE_AUTH_BLOCK_CALL: "4" });
  const t = saved(first.summary.taskId);
  assert.equal(t.executor, "claude"); assert.equal(t.state, "blocked"); assert.equal(t.base, null);
  assert.equal(t.selection?.attempt, 2);
  writeJsonAtomic(quotaStatePath(new Store(s.root)), {});
  const out = await resume(t.taskId, { FAKE_SCENARIO: "rate-limit" });
  assert.equal(out.summary.state, "blocked");
  assert.equal(s.execCalls().length, 2);
  assert.equal(saved(out.summary.taskId).selection?.attempt, 2);
  assert.ok(saved(out.summary.taskId).limitations.some((l) => l.includes("maxAttempts=2")));
});

it("adversarial 6: taskKey reutiliza sucesso final de fallback e hash lógico original", async () => {
  s = makeSandbox();
  const req = request({ taskKey: "logical-task", complexity: "standard", acceptance: ok });
  const first = await run(req, { FAKE_SCENARIO_BY_ATTEMPT: JSON.stringify({ 1: "rate-limit" }) });
  assert.equal(first.summary.state, "succeeded", JSON.stringify(first.summary));
  const t = saved(first.summary.taskId);
  const repeated = await run({ ...req, runId: t.runId });
  assert.equal(repeated.summary.state, "succeeded", JSON.stringify(repeated.summary));
  assert.equal(repeated.summary.reused, true);
  assert.equal(repeated.summary.taskId, t.taskId); assert.equal(s.execCalls().length, 2);
  assert.equal(t.requestHash, saved(t.selection?.attemptOf).requestHash);
});
