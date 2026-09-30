// Reproduções da terceira rodada: CLIs simuladas, nenhum acesso a fornecedores.
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { delegate } from "../src/orchestration/delegate.js";
import { isPidAlive } from "../src/adapters/process.js";
import { saveQuota } from "../src/orchestration/quota.js";
import { Store, writeJsonAtomic } from "../src/state/store.js";
import { catalogPath } from "../src/adapters/catalog.js";
import { adaptiveCatalog } from "./adaptive-catalog.js";
import { baseRequest, makeSandbox, type Sandbox } from "./helpers.js";

let s: Sandbox;
afterEach(async () => {
  try {
    const pids = (s?.log() ?? []).flatMap((call) => typeof call.pid === "number" ? [call.pid] : []);
    const deadline = Date.now() + 2500;
    while (pids.some(isPidAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    for (const pid of pids) assert.equal(isPidAlive(pid), false, `processo órfão: ${pid}`);
  }
  finally { s?.cleanup(); }
});
const ok = { criteria: ["verificado"], commands: [{ name: "ok", argv: ["node", "-e", "process.exit(0)"] }] };
const req = (extra: Record<string, unknown> = {}) => baseRequest("claude", { adaptive: true, risk: "medium", acceptance: ok, ...extra });
const run = (request: Record<string, unknown>, fake: Record<string, string> = {}) => delegate({ cwd: s.root, requestPath: s.request(request), env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", ...fake }, authPaths: s.authPaths });
const resume = (taskId: string) => delegate({ cwd: s.root, resumeTaskId: taskId, env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1" }, authPaths: s.authPaths });
const failOnce = { criteria: ["passa na segunda verificação"], commands: [{ name: "counter", argv: ["node", "-e", 'const fs=require("fs"), p=".duo/accept-count"; const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));process.exit(n===0?1:0)'] }] };

for (const gate of ["auth", "caps"] as const) it(`rodada 4 achado 2: gate ${gate} sem invocação reutiliza a reserva com maxAttempts=2`, async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 2 } } });
  const fake: Record<string, string> = gate === "auth" ? { FAKE_AUTH: "none" } : { FAKE_HELP: "missing-schema" };
  const first = await run(req({ brain: "codex", executor: "claude" }), fake);
  assert.equal(first.summary.state, "blocked");
  const taskId = String(first.summary.taskId);
  for (let i = 0; i < 3; i++) {
    const blocked = await delegate({ cwd: s.root, resumeTaskId: taskId, env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", ...fake }, authPaths: s.authPaths });
    assert.equal(blocked.summary.state, "blocked");
    assert.equal(blocked.summary.taskId, taskId);
  }
  assert.equal(s.execCalls().length, 0);
  const recovered = await resume(taskId);
  assert.equal(recovered.summary.state, "succeeded", JSON.stringify(recovered.summary));
  assert.equal(recovered.summary.taskId, taskId);
  const chain = new Store(s.root).listChains(String(first.summary.runId))[0]!;
  assert.equal(chain.attempts.length, 1);
  assert.equal(s.execCalls().length, 1);
});

it("rodada 4 achado 3: catálogo recuperado seleciona modelo ausente na mesma tentativa", async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 2 } } });
  const first = await run(req({ complexity: "deep" }), { FAKE_NO_CATALOG: "1" });
  assert.equal(first.summary.state, "blocked");
  const store = new Store(s.root), taskId = String(first.summary.taskId);
  assert.equal(store.findTask(taskId)!.model.requested, null);
  assert.equal(s.execCalls().length, 0);
  writeJsonAtomic(catalogPath(store), { ...adaptiveCatalog, discoveredAt: new Date().toISOString() });
  const recovered = await resume(taskId);
  assert.equal(recovered.summary.state, "succeeded", JSON.stringify(recovered.summary));
  assert.equal(recovered.summary.taskId, taskId);
  assert.equal(s.execCalls()[0]?.model, "gpt-6-astra");
  const chain = store.listChains(String(first.summary.runId))[0]!;
  assert.equal(chain.minTier, "deep");
  assert.equal(chain.minEffort, "high");
});

it("rodada 4 achado 3: task 0.2.0 sem selection/effort/Chain retoma com modelo automático", async () => {
  s = makeSandbox();
  const first = await run(req({ adaptive: false }), { FAKE_AUTH: "none" });
  const store = new Store(s.root), original = store.findTask(String(first.summary.taskId))!;
  const old = { ...original, taskId: "task-legacy-resume", selection: undefined, effort: undefined };
  const request = req(); delete request.adaptive;
  // Um run.json de 0.2.0, sem diretório de revisões.
  const legacyRun = { ...store.loadRun(old.runId)!, runId: "run-legacy-resume", taskIds: [old.taskId] };
  old.runId = legacyRun.runId;
  old.artifactsDir = store.taskDir(old.runId, old.taskId);
  writeJsonAtomic(join(old.artifactsDir, "task.json"), old);
  writeJsonAtomic(join(old.artifactsDir, "request.json"), request);
  writeJsonAtomic(join(store.runDir(old.runId), "run.json"), legacyRun);
  assert.equal(store.loadChain(old.runId, old.taskId), null);
  const recovered = await resume(old.taskId);
  assert.equal(recovered.summary.state, "succeeded", JSON.stringify(recovered.summary));
  assert.equal(recovered.summary.taskId, old.taskId);
  assert.equal(s.execCalls().length, 1);
  assert.equal(s.execCalls()[0]?.model, "gpt-6.1-sol");
});

it("rodada 3 achado 2: fallback Astra/high para Opus/high rejeita init Sonnet/high", async () => {
  s = makeSandbox();
  const out = await run(req({ complexity: "deep" }), {
    FAKE_SCENARIO_BY_ATTEMPT: JSON.stringify({ 1: "rate-limit", 2: "success" }),
    FAKE_CLAUDE_REPORTED_MODEL: "claude-sonnet-5-5",
  });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
  const task = new Store(s.root).findTask(String(out.summary.taskId))!;
  assert.equal(task.model.requested, "claude-opus-5-5");
  assert.equal(task.verification?.acceptance.length, 0);
  assert.match(String(out.summary.outcome), /piso deep/);
});

it("rodada 3 achado 2: escalada Sol para Astra rejeita rollout Sol/high", async () => {
  s = makeSandbox();
  const out = await run(req({ acceptance: failOnce }), { FAKE_ROLLOUT_MODEL: "gpt-6.1-sol", FAKE_ROLLOUT_EFFORT: "high" });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
  assert.equal(s.execCalls().length, 2);
  assert.equal(new Store(s.root).findTask(String(out.summary.taskId))!.model.requested, "gpt-6-astra");
  assert.equal(s.read(".duo/accept-count"), "1", "modelo inferior não chega ao aceite");
});

it("rodada 3 achado 3: ancestral de fallback concluído é recusada após reset da cota", async () => {
  s = makeSandbox({ limits: { maxDelegationsPerRun: 6 } });
  const request = req({ taskKey: "logical-task" });
  const out = await run(request, { FAKE_SCENARIO_BY_ATTEMPT: JSON.stringify({ 1: "rate-limit", 2: "success" }) });
  assert.equal(out.summary.state, "succeeded");
  const store = new Store(s.root), final = store.findTask(String(out.summary.taskId))!;
  const first = store.listTasks(store.loadRun(final.runId)!)[0]!;
  saveQuota(store, "codex", { status: "exhausted", resetsAt: new Date(Date.now() - 1000).toISOString(), usedPercent: 100, affectedModels: null, observedAt: new Date().toISOString(), source: "task-error" });
  const again = await resume(first.taskId);
  assert.equal(again.summary.state, "rejected");
  assert.match(String(again.summary.error), /tentativa substituída.*succeeded.*última tentativa/);
  assert.equal(s.execCalls().length, 2);
  const reused = await run({ ...request, runId: final.runId });
  assert.equal(reused.summary.taskId, final.taskId);
  assert.equal(reused.summary.reused, true);
});

it("Chain: retomar a última tentativa succeeded devolve o resultado sem executar", async () => {
  s = makeSandbox();
  const out = await run(req());
  const again = await resume(String(out.summary.taskId));
  assert.equal(again.summary.state, "succeeded");
  assert.equal(again.summary.reused, true);
  assert.equal(s.execCalls().length, 1);
});

it("rodada 3 achado 4: escalada preserva task concorrente e sua idempotência no run", async () => {
  s = makeSandbox({ limits: { maxDelegationsPerRun: 6 } });
  const seed = await run(req({ brain: "codex", executor: "claude" }));
  const runId = String(seed.summary.runId);
  const a = run(req({ runId, brain: "codex", executor: "claude", taskKey: "A", acceptance: failOnce }), { FAKE_CLAUDE_INIT_DELAY_MS: "1500" });
  let b: Awaited<ReturnType<typeof run>>;
  try {
    const deadline = Date.now() + 10000;
    while (s.execCalls().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.execCalls().length, 2, "A iniciou");
    b = await run(req({ runId, brain: "codex", executor: "claude", taskKey: "B" }));
  } finally { await a; }
  assert.equal(b!.summary.state, "blocked");
  const store = new Store(s.root), fresh = store.loadRun(runId)!;
  assert.ok(fresh.taskIds.includes(String(b!.summary.taskId)), "B não pode desaparecer quando C é criada");
  assert.equal(fresh.taskIds.length, 4);
  assert.equal(fresh.invocations, 3);
  const before = s.execCalls().length;
  const repeated = await run(req({ runId, brain: "codex", executor: "claude", taskKey: "B" }));
  assert.equal(repeated.summary.state, "rejected");
  assert.equal(s.execCalls().length, before);
  assert.equal(readFileSync(join(s.root, ".duo/accept-count"), "utf8"), "2");
});

for (const remote of [true, false]) it(`rodada 3 achado 1: valida settings da worktree real (remoto=${remote})`, async () => {
  s = makeSandbox({ billing: { allowLoopbackProxy: true }, executors: { claude: { settingSources: "user,project,local" } } });
  const settings = (isRemote: boolean) => JSON.stringify({ env: { ANTHROPIC_BASE_URL: isRemote ? "https://gateway.example.test/v1" : "http://127.0.0.1:8787/v1" } });
  s.write(".claude/settings.json", settings(remote));
  s.git("add", ".claude/settings.json"); s.git("commit", "-qm", "settings de teste");
  s.write(".claude/settings.local.json", settings(!remote));
  const out = await run(req({ brain: "codex", executor: "claude", isolation: "worktree" }));
  assert.equal(out.summary.state, remote ? "blocked" : "succeeded", JSON.stringify(out.summary));
  assert.equal(s.execCalls().length, remote ? 0 : 1);
});

it("rodada 3 achado 1: flag ausente no plano não exclui settings de projeto", async () => {
  s = makeSandbox({ billing: { allowLoopbackProxy: true } });
  writeFileSync(join(s.home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/v1" } }));
  s.write(".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.test/v1" } }));
  const out = await run(req({ brain: "codex", executor: "claude", adaptive: false }), { FAKE_HELP: "missing-setting-sources" });
  assert.equal(out.summary.state, "blocked");
  assert.equal(s.execCalls().length, 0);
});

it("rodada 3 achado 1: ignoreUserConfig só exclui usuário quando a CLI anuncia a flag", async () => {
  s = makeSandbox({ billing: { allowLoopbackProxy: true }, executors: { codex: { ignoreUserConfig: true } } });
  writeFileSync(join(s.home, ".codex/config.toml"), 'model_provider="remote"\n[model_providers.remote]\nbase_url="https://gateway.example.test/v1"\nrequires_openai_auth=true\n');
  const out = await run(req({ adaptive: false }), { FAKE_CODEX_HELP: "missing-ignore-user-config" });
  assert.equal(out.summary.state, "blocked");
  assert.equal(s.execCalls().length, 0);
});
