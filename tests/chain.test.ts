import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { EFFORTS } from "../src/adapters/tiers.js";
import { catalogPath } from "../src/adapters/catalog.js";
import { isPidAlive } from "../src/adapters/process.js";
import { chainPolicy } from "../src/orchestration/chain.js";
import { tierRank, TIERS } from "../src/orchestration/complexity.js";
import { delegate } from "../src/orchestration/delegate.js";
import { Store, writeJsonAtomic } from "../src/state/store.js";
import type { Chain, ChainAttempt, Run } from "../src/state/types.js";
import { baseRequest, makeSandbox, type Sandbox } from "./helpers.js";
import { adaptiveCatalog } from "./adaptive-catalog.js";

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
function setup() {
  s = makeSandbox();
  const store = new Store(s.root), now = new Date().toISOString();
  const run: Run = { runId: "run-chain-test", brain: "claude", policy: "equilibrado", taskIds: [], invocations: 0, cancelled: false, decisions: [], nextStep: null, createdAt: now, updatedAt: now };
  const chain: Chain = { version: 1, chainId: "task-chain-test", runId: run.runId, taskKey: "key", requestHash: "original", originalRequestPath: "/unused", floorTier: "light", minTier: "light", minEffort: null, origin: { model: "auto", effort: "auto" }, attempts: [], status: "blocked", latestTaskId: "task-chain-test", updatedAt: now, owner: null };
  store.saveRun(run);
  writeJsonAtomic(store.chainPath(run.runId, chain.chainId), chain);
  return { store, run, chain };
}
const child = (script: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const p = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  p.stderr.on("data", (b) => { stderr += b; });
  p.on("error", reject);
  p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker ${code}: ${stderr}`)));
});

it("Chain: processos concorrentes não perdem tentativas, taskIds, contadores ou cancelamento", async () => {
  const { store, run, chain } = setup();
  const script = `import { Store } from ${JSON.stringify(new URL("../src/state/store.js", import.meta.url).href)};
    const [root, runId, chainId, worker] = process.argv.slice(1), store = new Store(root);
    for (let i=0;i<12;i++) {
      const taskId = 'task-worker-'+worker+'-'+i;
      store.updateChain(runId, chainId, c => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3);
        c.attempts.push({taskId,attempt:c.attempts.length+1,executor:'codex',model:'gpt-6-astra',effort:'high',tier:'deep',reason:'escalation',state:'planned'});
        c.latestTaskId=taskId;
      });
      store.updateRun(runId, r => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3);r.taskIds.push(taskId);r.invocations++;if(worker==='A')r.cancelled=true; });
    }`;
  await Promise.all([child(script, [s.root, run.runId, chain.chainId, "A"]), child(script, [s.root, run.runId, chain.chainId, "B"])]);
  const fresh = store.loadChain(run.runId, chain.chainId)!;
  assert.equal(fresh.attempts.length, 24);
  assert.equal(new Set(fresh.attempts.map((a) => a.taskId)).size, 24);
  assert.deepEqual(fresh.attempts.map((a) => a.attempt), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(store.loadRun(run.runId)!.taskIds.length, 24);
  assert.equal(store.loadRun(run.runId)!.invocations, 24);
  assert.equal(store.loadRun(run.runId)!.cancelled, true);
  assert.equal(existsSync(`${store.chainPath(run.runId, chain.chainId)}.lock`), false);
});

it("Chain: minTier/minEffort nunca diminuem em sequências de escalada, cota, capacidade e retomada", () => {
  const { store, run, chain } = setup();
  const reasons: ChainAttempt["reason"][] = ["escalation", "quota", "capacity", "resume"];
  // 128 sequências reproduzíveis, incluindo propostas decrescentes em todos os motivos.
  let seed = 7331;
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let sequence = 0; sequence < 128; sequence++) {
    const id = `task-sequence-${sequence}`;
    writeJsonAtomic(store.chainPath(run.runId, id), { ...chain, chainId: id, attempts: [] });
    let expectedTier = "light" as Chain["minTier"], expectedEffort: Chain["minEffort"] = null;
    for (let step = 0; step < 8; step++) {
      const tier = TIERS[next(TIERS.length)]!, effort = EFFORTS[next(EFFORTS.length)]!, reason = reasons[(step + sequence) % reasons.length]!;
      const before = store.loadChain(run.runId, id)!;
      const after = store.updateChain(run.runId, id, (c) => {
        c.minTier = tier; c.minEffort = effort;
        c.attempts.push({ taskId: `task-sequence-${sequence}-${step}`, attempt: c.attempts.length + 1, executor: "codex", model: "test", effort, tier, reason, state: "blocked" });
      });
      if (tierRank(tier) > tierRank(expectedTier)) expectedTier = tier;
      if (EFFORTS.indexOf(effort) > EFFORTS.indexOf(expectedEffort!)) expectedEffort = effort;
      assert.equal(after.minTier, expectedTier);
      assert.equal(after.minEffort, expectedEffort);
      assert.ok(tierRank(after.minTier) >= tierRank(before.minTier));
      assert.ok(EFFORTS.indexOf(after.minEffort!) >= EFFORTS.indexOf(before.minEffort!));
      assert.equal(chainPolicy(after).floor, after.minTier);
    }
  }
});

it("Chain: CAS ignora locks legados e exceção não publica revisão", () => {
  const { store, run, chain } = setup(), path = `${store.chainPath(run.runId, chain.chainId)}.lock`;
  writeFileSync(path, "");
  utimesSync(path, 0, 0);
  const before = store.loadChain(run.runId, chain.chainId);
  assert.throws(() => store.updateChain(run.runId, chain.chainId, () => { throw new Error("simulado"); }), /simulado/);
  assert.deepEqual(store.loadChain(run.runId, chain.chainId), before);
  writeFileSync(path, JSON.stringify({ pid: process.pid, nonce: "vivo" }));
  utimesSync(path, 0, 0);
  store.updateChain(run.runId, chain.chainId, (fresh) => { fresh.minTier = "deep"; });
  assert.equal(store.loadChain(run.runId, chain.chainId)!.minTier, "deep");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).nonce, "vivo");
});

const ok = { criteria: ["verificado"], commands: [{ name: "ok", argv: ["node", "-e", "process.exit(0)"] }] };
const run = (fake: Record<string, string> = {}) => delegate({ cwd: s.root, requestPath: s.request(baseRequest("codex", { adaptive: true, risk: "medium", acceptance: ok })), env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", ...fake }, authPaths: s.authPaths });

it("Chain: retomadas simultâneas reservam uma única nova tentativa", async () => {
  s = makeSandbox();
  const first = await run({ FAKE_REPORT: JSON.stringify({ status: "blocked", blockedReason: "decisão do cérebro" }) });
  const opts = { cwd: s.root, resumeTaskId: String(first.summary.taskId), env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", FAKE_CLAUDE_INIT_DELAY_MS: "300" }, authPaths: s.authPaths };
  const results = await Promise.all([delegate(opts), delegate(opts)]);
  assert.equal(results.filter((r) => r.summary.state === "succeeded").length, 1);
  assert.equal(results.filter((r) => r.summary.state === "rejected").length, 1);
  assert.equal(s.execCalls().length, 2);
  const store = new Store(s.root), chain = store.listChains(String(first.summary.runId))[0]!;
  assert.equal(chain.attempts.length, 2);
  assert.equal(chain.attempts[1]?.reason, "resume");
  assert.equal(chain.status, "succeeded");
  assert.equal(chain.owner, null);
});

it("Chain: task antiga sem registro ganha cadeia unitária sem reescrever a task", async () => {
  s = makeSandbox();
  const first = await run();
  const store = new Store(s.root), original = store.findTask(String(first.summary.taskId))!;
  const old = { ...original, taskId: "task-legacy-copy", selection: undefined };
  old.artifactsDir = store.taskDir(old.runId, old.taskId);
  writeJsonAtomic(join(old.artifactsDir, "task.json"), old);
  const before = readFileSync(join(old.artifactsDir, "task.json"), "utf8");
  const loaded = store.loadTask(old.runId, old.taskId)!;
  const chain = store.chainForTask(loaded);
  assert.equal(chain.chainId, old.taskId);
  assert.equal(chain.attempts.length, 1);
  assert.equal(chain.status, "succeeded");
  assert.equal(readFileSync(join(old.artifactsDir, "task.json"), "utf8"), before);
});

it("Chain: capacidade persiste como motivo/cooldown e só expira no prazo", async () => {
  s = makeSandbox();
  const result = await run({ FAKE_SCENARIO_BY_ATTEMPT: JSON.stringify({ 1: "capacity", 2: "success" }) });
  assert.equal(result.summary.state, "succeeded");
  const store = new Store(s.root), chain = store.listChains(String(result.summary.runId))[0]!;
  assert.equal(chain.attempts[1]?.reason, "capacity");
  assert.notEqual(chain.attempts[0]?.model, chain.attempts[1]?.model);
  const until = Date.parse(chain.attempts[0]!.capacityUntil!);
  assert.equal(chainPolicy(chain, { now: until - 1 }).unavailable.length, 1);
  assert.equal(chainPolicy(chain, { now: until }).unavailable.length, 0);
  assert.equal(chain.minTier, "deep");
});

it("Chain: capacidade de alias impede repetir o mesmo modelo pelo ID canônico", async () => {
  s = makeSandbox();
  const catalog = structuredClone(adaptiveCatalog);
  catalog.discoveredAt = new Date().toISOString();
  catalog.providers.claude.models.find((m) => m.id === "claude-sonnet-5-5")!.aliases = ["sonnet"];
  writeJsonAtomic(catalogPath(new Store(s.root)), catalog);
  const out = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("codex", { adaptive: true, model: "sonnet", risk: "medium", acceptance: ok })),
    env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", FAKE_SCENARIO_BY_ATTEMPT: JSON.stringify({ 1: "capacity", 2: "success" }) }, authPaths: s.authPaths });
  assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  assert.deepEqual(s.execCalls().map((c) => c.model), ["sonnet", "claude-opus-5-5"]);
});

it("Chain: esforço nativo confirmado aumenta o mínimo persistido", async () => {
  s = makeSandbox();
  const out = await delegate({ cwd: s.root, requestPath: s.request(baseRequest("claude", { adaptive: true, risk: "medium", acceptance: ok })),
    env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", FAKE_ROLLOUT_EFFORT: "xhigh" }, authPaths: s.authPaths });
  assert.equal(out.summary.state, "succeeded");
  assert.equal(new Store(s.root).listChains(String(out.summary.runId))[0]!.minEffort, "xhigh");
});

it("Chain: sucesso salvo antes da interrupção é reconciliado sem repetir execução", async () => {
  s = makeSandbox();
  const first = await run(), store = new Store(s.root);
  const task = store.findTask(String(first.summary.taskId))!, chain = store.chainForTask(task);
  store.updateChain(chain.runId, chain.chainId, (fresh) => { fresh.status = "running"; fresh.owner = { pid: 2147483647, nonce: "ponte-morta" }; fresh.attempts.at(-1)!.state = "running"; });
  const reused = await delegate({ cwd: s.root, resumeTaskId: task.taskId, env: s.env, authPaths: s.authPaths });
  assert.equal(reused.summary.state, "succeeded");
  assert.equal(reused.summary.reused, true);
  assert.equal(s.execCalls().length, 1);
  assert.equal(store.loadChain(chain.runId, chain.chainId)!.status, "succeeded");
  assert.equal(store.loadChain(chain.runId, chain.chainId)!.attempts.at(-1)!.state, "succeeded");
});

it("Chain: retomada não repete modelo sem capacidade mesmo sem o cache global; usa alternativa equivalente", async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 1 } } });
  const first = await run({ FAKE_SCENARIO: "capacity" });
  assert.equal(first.summary.state, "blocked");
  const store = new Store(s.root);
  const cooled = store.findTask(String(first.summary.taskId))!.model.requested;
  s.config({ routing: { adaptive: { maxAttempts: 3 } } });
  writeJsonAtomic(join(store.base, "capacity-state.json"), { entries: [] });
  const resume = (taskId: string) => delegate({ cwd: s.root, resumeTaskId: taskId, env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1" }, authPaths: s.authPaths });
  const out = await resume(String(first.summary.taskId));
  assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  const done = store.findTask(String(out.summary.taskId))!;
  assert.ok(cooled && done.model.requested && done.model.requested !== cooled, `não repete ${cooled}`);
  assert.ok(tierRank(done.selection!.tier) >= tierRank(store.findTask(String(first.summary.taskId))!.selection!.tier), "nunca abaixo do nível");
  assert.equal(s.execCalls().length, 2);
});

it("Chain: retomada sem alternativa equivalente continua bloqueada até o fim do cooldown", async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 1 } } });
  const first = await run({ FAKE_SCENARIO: "capacity" });
  assert.equal(first.summary.state, "blocked");
  const store = new Store(s.root);
  const cooled = store.findTask(String(first.summary.taskId))!;
  s.config({ routing: { adaptive: { maxAttempts: 3 }, include: [`${cooled.executor}:${cooled.model.requested}`] } });
  writeJsonAtomic(join(store.base, "capacity-state.json"), { entries: [] });
  const resume = (taskId: string) => delegate({ cwd: s.root, resumeTaskId: taskId, env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1" }, authPaths: s.authPaths });
  const cooling = await resume(String(first.summary.taskId));
  assert.equal(cooling.summary.state, "blocked");
  assert.match(String(cooling.summary.outcome), /sem capacidade|nenhum modelo automático elegível/);
  assert.equal(s.execCalls().length, 1);
  const chain = store.listChains(String(first.summary.runId))[0]!;
  store.updateChain(chain.runId, chain.chainId, (fresh) => { fresh.attempts[0]!.capacityUntil = new Date(Date.now() - 1).toISOString(); });
  const reset = await resume(String(cooling.summary.taskId));
  assert.equal(reset.summary.state, "succeeded");
  assert.equal(s.execCalls().length, 2);
});

it("Chain: reserva abandonada pode ser retomada, preservando sessão e trabalho parcial", async () => {
  s = makeSandbox();
  const first = await run({ FAKE_REPORT: JSON.stringify({ status: "blocked", blockedReason: "decisão do cérebro" }), FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) });
  const store = new Store(s.root), original = store.findTask(String(first.summary.taskId))!, chain = store.chainForTask(original);
  store.updateChain(chain.runId, chain.chainId, (fresh) => { fresh.status = "running"; fresh.owner = { pid: 2147483647, nonce: "ponte-morta" }; });
  const resumed = await delegate({ cwd: s.root, resumeTaskId: original.taskId, env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", FAKE_REPORT: JSON.stringify({ filesChanged: ["src/app.ts"] }) }, authPaths: s.authPaths });
  assert.equal(resumed.summary.state, "succeeded", JSON.stringify(resumed.summary));
  const latest = store.findTask(String(resumed.summary.taskId))!;
  assert.notEqual(latest.taskId, original.taskId);
  assert.equal(latest.native.sessionId, original.native.sessionId);
  assert.deepEqual(latest.base, original.base);
  assert.match(readFileSync(latest.verification!.diffPath!, "utf8"), /app = 1/);
  assert.equal(s.read("src/app.ts"), "export const app = 2;\n");
  assert.equal(store.findTask(original.taskId)!.state, "blocked");
});

for (const reason of ["quota", "escalation"] as const) it(`Chain: interrupção após reservar ${reason} preserva o modelo da próxima tentativa`, async (t) => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 2 } } });
  const update = Store.prototype.updateRun;
  const fault = t.mock.method(Store.prototype, "updateRun", function (this: Store, ...args: Parameters<typeof update>) {
    const result = update.apply(this, args);
    if (result.taskIds.length === 2) throw new Error("interrupção após persistir próxima tentativa");
    return result;
  });
  const acceptance = reason === "quota" ? ok : { criteria: ["aceite reprovado uma vez"], commands: [{ name: "fail", argv: ["node", "-e", 'const fs=require("fs"), p=".duo/accept-count";const seen=fs.existsSync(p);fs.writeFileSync(p,"1");process.exit(seen?0:1)'] }] };
  const request = baseRequest("claude", { adaptive: true, risk: "medium", acceptance, ...(reason === "quota" ? { complexity: "deep" } : {}) });
  await assert.rejects(delegate({ cwd: s.root, requestPath: s.request(request), env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", ...(reason === "quota" ? { FAKE_SCENARIO: "rate-limit" } : {}) }, authPaths: s.authPaths }), /interrupção após persistir/);
  fault.mock.restore();
  const store = new Store(s.root), chain = store.listChains(store.listRuns()[0]!.runId)[0]!;
  const expectedModel = reason === "quota" ? "claude-opus-5-5" : "gpt-6-astra";
  assert.equal(chain.attempts[1]?.reason, reason);
  assert.equal(chain.attempts[1]?.model, expectedModel);
  assert.equal(chain.attempts[1]?.state, "planned");
  assert.equal(chain.minTier, "deep");
  const resumed = await delegate({ cwd: s.root, resumeTaskId: chain.latestTaskId, env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1" }, authPaths: s.authPaths });
  assert.equal(resumed.summary.state, "succeeded", JSON.stringify(resumed.summary));
  assert.equal(resumed.summary.taskId, chain.latestTaskId, "retoma a reserva sem criar uma terceira task");
  assert.equal(store.loadChain(chain.runId, chain.chainId)!.attempts.length, 2);
  assert.deepEqual(s.execCalls().map((c) => c.model), [reason === "quota" ? "gpt-6-astra" : "gpt-6.1-sol", expectedModel]);
});
