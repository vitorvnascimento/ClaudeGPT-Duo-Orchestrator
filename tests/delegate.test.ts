// Integração offline: a ponte real contra CLIs simuladas (nenhum modelo é invocado).
import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { isPidAlive } from "../src/adapters/process.js";
import { applyTask, refreshInterrupted } from "../src/orchestration/control.js";
import { ADAPTERS, delegate } from "../src/orchestration/delegate.js";
import { Store } from "../src/state/store.js";
import type { InvocationInput } from "../src/adapters/types.js";
import { loadConfig } from "../src/config.js";
import { loadSchema, validate } from "../src/schema.js";
import type { Task } from "../src/state/types.js";
import { buildReport } from "../src/telemetry/report.js";
import { baseRequest, CLI, makeSandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | null = null;
afterEach(() => {
  sb?.cleanup();
  sb = null;
});

function setup(patch: Record<string, unknown> = {}): Sandbox {
  sb = makeSandbox(patch);
  return sb;
}

async function run(s: Sandbox, req: Record<string, unknown>, fake: Record<string, string> = {}, envExtra: Record<string, string> = {}) {
  return delegate({ cwd: s.root, requestPath: s.request(req), env: { ...s.env, ...fake, ...envExtra }, authPaths: s.authPaths });
}

function task(s: Sandbox, taskId: unknown): Task {
  const t = new Store(s.root).findTask(String(taskId));
  assert.ok(t, "task deve existir");
  return t;
}

const APP_EDIT = JSON.stringify({ "src/app.ts": "export const app = 1;\nexport const nova = 2;\n" });

describe("esforço explícito nos executores", () => {
  it("sem effort, argv idênticos ao contrato 0.2.0 dos dois adaptadores", () => {
    const s = setup();
    const input: InvocationInput = {
      resolved: { ok: true, command: "/bin/cli", prefixArgs: [], source: "path" },
      caps: { version: "1.0.0", flags: { model: true, effort: true, config: true }, missingRequired: [], divergences: [] },
      cfg: loadConfig(s.root), cwd: s.root, kind: "review", prompt: "p", writableAbs: [], denyGlobs: [], acceptanceArgv: [], needs: [],
      model: "fixed-model", resumeSessionId: null, artifactsDir: new Store(s.root).base, env: {},
    };
    // Captura do argv da 0.2.0; apenas caminhos e JSON do schema são normalizados.
    const expected = {
      claude: ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", "<schema>", "--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob", "--disallowedTools",
        "Bash(claude *)", "Bash(codex *)", "Bash(duo *)", "Bash(npx duo*)", "Bash(npm exec duo*)", "Bash(node *duo-orchestrator*)",
        "Bash(git reset *)", "Bash(git clean *)", "Bash(git stash *)", "Bash(git checkout *)", "Bash(git push *)", "Bash(git commit *)", "--model", "fixed-model"],
      codex: ["exec", "--json", "--sandbox", "read-only", "--cd", "<cwd>", "--output-schema", "<schema>", "--model", "fixed-model", "-"],
    };
    for (const p of ["claude", "codex"] as const) {
      for (const patch of [{}, { effort: null }]) {
        const args = ADAPTERS[p].plan({ ...input, ...patch }).args;
        args[args.indexOf(p === "claude" ? "--json-schema" : "--output-schema") + 1] = "<schema>";
        if (p === "codex") args[args.indexOf("--cd") + 1] = "<cwd>";
        assert.deepEqual(args, expected[p]);
      }
      const caps = { ...input.caps, flags: { model: true } };
      assert.throws(() => ADAPTERS[p].plan({ ...input, caps, effort: "high" }), /esforço solicitado.*não anuncia/);
    }
  });
  for (const brain of ["claude", "codex"] as const) {
    it(`${brain}: registra effort e passa a sintaxe do executor`, async () => {
      const s = setup();
      const out = await run(s, baseRequest(brain, { effort: "xhigh" }), { FAKE_WRITE: APP_EDIT });
      assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
      assert.deepEqual(task(s, out.summary.taskId).effort, { requested: "xhigh" });
      assert.deepEqual(out.summary.effort, { requested: "xhigh" });
      const args = s.execCalls()[0]?.args as string[];
      const flag = brain === "codex" ? "--effort" : "--config";
      const value = brain === "codex" ? "xhigh" : 'model_reasoning_effort="xhigh"';
      assert.ok(args.some((arg, i) => arg === flag && args[i + 1] === value));
    });
    it(`${brain}: flag ausente bloqueia antes da execução`, async () => {
      const s = setup();
      const out = await run(s, baseRequest(brain, { effort: "high" }), {}, { FAKE_HELP: brain === "codex" ? "missing-effort" : "missing-config" });
      assert.equal(out.summary.state, "blocked");
      assert.match(String(out.summary.outcome), /esforço solicitado.*não anuncia --(effort|config)/);
      assert.equal(s.execCalls().length, 0);
      assert.equal(task(s, out.summary.taskId).invocations, 0);
    });
  }
  it("schema aceita os cinco níveis e rejeita esforço inválido", async () => {
    const s = setup();
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) assert.deepEqual(validate(loadSchema("delegation-request"), baseRequest("claude", { effort })), []);
    for (const effort of ["ultra", "HIGH", "", null, 3]) {
      const out = await run(s, baseRequest("claude", { effort }));
      assert.equal(out.exitCode, 2);
      assert.match(JSON.stringify(out.summary), /\$\.effort/);
    }
    assert.equal(s.execCalls().length, 0);
  });
  it("retomada mantém o esforço do pedido", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex", { effort: "max" }), { FAKE_SCENARIO: "partial", FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "blocked");
    const resumed = await delegate({ cwd: s.root, resumeTaskId: String(out.summary.taskId), env: s.env, authPaths: s.authPaths });
    assert.equal(resumed.summary.state, "succeeded", JSON.stringify(resumed.summary));
    for (const call of s.execCalls()) {
      const args = call.args as string[];
      assert.equal(args[args.indexOf("--effort") + 1], "max");
    }
  });
});

describe("direções de delegação e cérebro explícito", () => {
  it("Claude cérebro → Codex executor: sucesso verificado, diff, uso nativo, sem raciocínio salvo", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude"), { FAKE_SCENARIO: "success", FAKE_WRITE: APP_EDIT });
    assert.equal(out.exitCode, 0, JSON.stringify(out.summary));
    assert.equal(out.summary.state, "succeeded");
    assert.deepEqual(out.summary.filesChanged, ["src/app.ts"]);
    const t = task(s, out.summary.taskId);
    assert.equal(t.brain, "claude");
    assert.equal(t.executor, "codex");
    assert.equal(t.native.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    assert.equal(t.metrics?.native.source, "native");
    assert.equal(t.metrics?.native.usage?.cached_input_tokens, 24448);
    assert.equal(t.metrics?.native.usage?.cache_write_input_tokens, 0);
    assert.ok(t.limitations.some((l) => l.includes("aviso do codex: Exceeded skills context budget")));
    assert.equal(t.model.reportedSource, "native");
    assert.equal(t.model.reportedVia, "codex-rollout");
    const diff = readFileSync(t.verification?.diffPath as string, "utf8");
    assert.match(diff, /\+export const nova = 2;/);
    assert.ok(!readFileSync(join(t.artifactsDir, "events.jsonl"), "utf8").includes("raciocínio privado"));
    const call = s.execCalls()[0] as Record<string, unknown>;
    assert.equal(call.sandbox, "workspace-write");
    assert.equal(call.schemaExists, true);
    assert.equal(call.depth, "1");
    assert.deepEqual(call.env, []);
  });

  it("Codex cérebro → Claude executor: sucesso, modelo informado e thinking não persistido", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex", { model: "claude-opus-5-5" }), { FAKE_SCENARIO: "success", FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const t = task(s, out.summary.taskId);
    assert.equal(t.executor, "claude");
    assert.equal(t.model.requested, "claude-opus-5-5");
    assert.equal(t.model.reported, "claude-opus-5-5");
    assert.equal(t.metrics?.native.usage?.cache_read_input_tokens, 800);
    assert.ok(!readFileSync(join(t.artifactsDir, "events.jsonl"), "utf8").includes("segredo do raciocínio"));
    const call = s.execCalls()[0] as { args: string[] };
    assert.ok(call.args.includes("--disable-slash-commands"));
    assert.ok(!call.args.includes("--bare"));
  });

  it("rejeita brain igual ao executor e pedido sem brain", async () => {
    const s = setup();
    const same = await run(s, { ...baseRequest("claude"), executor: "claude" });
    assert.equal(same.exitCode, 2);
    const { brain: _b, ...noBrain } = baseRequest("claude");
    const missing = await run(s, noBrain);
    assert.equal(missing.exitCode, 2);
    assert.equal(s.execCalls().length, 0);
  });
});

describe("autenticação e cobrança (subscription-only)", () => {
  it("sem login: bloqueia e não invoca nada (nenhum fallback)", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude"), { FAKE_AUTH: "none" });
    assert.equal(out.exitCode, 3);
    assert.match(String(out.summary.outcome), /none/);
    assert.equal(s.execCalls().length, 0);
  });

  it("chave de API no ambiente não chega ao executor nem ao comando de status", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_WRITE: APP_EDIT }, { ANTHROPIC_API_KEY: "sk-ant-api03-conflictingkey000000", OPENAI_API_KEY: "sk-proj-otherkey0000000000000" });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    for (const entry of s.log()) assert.deepEqual(entry.env, [], JSON.stringify(entry));
  });

  it("apiKeyHelper em settings bloqueia a execução", async () => {
    const s = setup();
    writeFileSync(join(s.home, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "/usr/local/bin/get-key" }));
    const out = await run(s, baseRequest("codex"));
    assert.equal(out.exitCode, 3);
    assert.match(String(out.summary.outcome), /apiKeyHelper/);
    assert.equal(s.execCalls().length, 0);
  });

  it("Codex autenticado por API key e provedor customizado são bloqueados", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude"), { FAKE_AUTH: "api_key" });
    assert.equal(out.exitCode, 3);
    assert.ok(!String(out.summary.outcome).includes("ABCD"));
    writeFileSync(join(s.home, ".codex", "config.toml"), 'model_provider = "omniroute"\n');
    const out2 = await run(s, baseRequest("claude"));
    assert.match(String(out2.summary.outcome), /model_provider/);
    assert.equal(s.execCalls().length, 0);
  });

  it("método desconhecido ou status ilegível bloqueia", async () => {
    const s = setup();
    assert.equal((await run(s, baseRequest("codex"), { FAKE_AUTH: "unknown" })).exitCode, 3);
    assert.equal((await run(s, baseRequest("codex"), { FAKE_AUTH: "garbage" })).exitCode, 3);
    assert.equal((await run(s, baseRequest("codex"), { FAKE_AUTH: "cloud" })).exitCode, 3);
    assert.equal(s.execCalls().length, 0);
  });

  it("sem ciência registrada sobre uso extra/créditos, bloqueia", async () => {
    const s = setup({ billing: { acknowledgeUnverifiableExtraUsage: { codex: false } } });
    const out = await run(s, baseRequest("claude"));
    assert.equal(out.exitCode, 3);
    assert.match(String(out.summary.outcome), /acknowledgeUnverifiableExtraUsage/);
  });
});

describe("compatibilidade de versão, modelo e envelope de erro", () => {
  it("flag obrigatória ausente no --help bloqueia com explicação", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude"), { FAKE_HELP: "missing-schema" });
    assert.equal(out.exitCode, 3);
    assert.match(String(out.summary.outcome), /--output-schema/);
  });

  for (const brain of ["claude", "codex"] as const) {
    it(`modelo indisponível (${brain === "claude" ? "Codex" : "Claude"}) → failed model_unavailable`, async () => {
      const s = setup();
      // Modelo presente no catálogo, recusado em tempo de execução (caminho de erro da CLI).
      const out = await run(s, baseRequest(brain, { model: brain === "claude" ? "gpt-6-sol" : "claude-sonnet-5" }), { FAKE_SCENARIO: "model-unavailable" });
      assert.equal(out.summary.state, "failed");
      assert.match(String(out.summary.outcome), /modelo indisponível/);
    });

    it(`erro em envelope com exit 0 (${brain === "claude" ? "Codex" : "Claude"}) não conta como sucesso`, async () => {
      const s = setup();
      const out = await run(s, baseRequest(brain), { FAKE_SCENARIO: "error-envelope" });
      assert.equal(out.summary.state, "failed");
      assert.match(String(out.summary.outcome), /error_envelope/);
    });

    it(`JSON fragmentado (${brain === "claude" ? "Codex" : "Claude"}) é reconstruído`, async () => {
      const s = setup();
      const out = await run(s, baseRequest(brain), { FAKE_SCENARIO: "fragmented", FAKE_WRITE: APP_EDIT });
      assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    });

    it(`stream incompleto (${brain === "claude" ? "Codex" : "Claude"}) → failed`, async () => {
      const s = setup();
      const out = await run(s, baseRequest(brain), { FAKE_SCENARIO: "incomplete" });
      assert.equal(out.summary.state, "failed");
      assert.match(String(out.summary.outcome), /incomplete_stream/);
    });

    it(`eventos desconhecidos (${brain === "claude" ? "Codex" : "Claude"}) são ignorados e registrados`, async () => {
      const s = setup();
      const out = await run(s, baseRequest(brain), { FAKE_SCENARIO: "unknown-events", FAKE_WRITE: APP_EDIT });
      assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
      assert.ok((out.summary.limitations as string[]).some((l) => l.includes("eventos desconhecidos")));
    });

    it(`cota esgotada (${brain === "claude" ? "Codex" : "Claude"}) → blocked sem nova tentativa`, async () => {
      const s = setup();
      const out = await run(s, baseRequest(brain), { FAKE_SCENARIO: "rate-limit" });
      assert.equal(out.summary.state, "blocked");
      assert.match(String(out.summary.outcome), /cota/);
      assert.equal(s.execCalls().length, 1);
    });
  }

  it("última linha sem quebra final ainda é lida", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "no-trailing-newline", FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  });

  it("relatório fora do schema → failed", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "invalid-report" });
    assert.equal(out.summary.state, "failed");
    assert.match(String(out.summary.outcome), /invalid_report/);
  });

  it("saída acima do limite encerra o executor → failed", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "huge-output" });
    assert.equal(out.summary.state, "failed");
    assert.match(String(out.summary.outcome), /maxOutputBytes/);
  });
});

describe("orçamento, cota e informação ausente", () => {
  it("terceira invocação no mesmo run é bloqueada sem chamar o executor", async () => {
    const s = setup();
    const first = await run(s, baseRequest("claude"), { FAKE_WRITE: APP_EDIT });
    const runId = first.summary.runId as string;
    await run(s, baseRequest("claude", { runId, objective: "Segunda subtarefa delimitada em src/app.ts." }), { FAKE_WRITE: APP_EDIT });
    const third = await run(s, baseRequest("claude", { runId, objective: "Terceira subtarefa delimitada em src/app.ts." }), { FAKE_WRITE: APP_EDIT });
    assert.equal(third.exitCode, 3);
    assert.match(String(third.summary.outcome), /limite de 2/);
    assert.equal(s.execCalls().length, 2);
  });

  it("relatório mostra cota como não disponível sem registro manual", async () => {
    const s = setup();
    await run(s, baseRequest("claude"), { FAKE_WRITE: APP_EDIT });
    const r = buildReport(new Store(s.root)) as { quota: Record<string, { status: string }> };
    assert.equal(r.quota.codex?.status, "não disponível");
    assert.equal(r.quota.claude?.status, "não disponível");
  });
});

describe("timeout, interrupção, retomada e idempotência", () => {
  it("timeout encerra a árvore de processos e deixa a task retomável", async () => {
    const s = setup({ limits: { timeoutSec: 2 } });
    const pidfile = join(s.tmp, "pids.json");
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "timeout", FAKE_PIDFILE: pidfile });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /timeout/);
    const pids = JSON.parse(readFileSync(pidfile, "utf8")) as { self: number; grandchild: number };
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(isPidAlive(pids.self), false);
    assert.equal(isPidAlive(pids.grandchild), false);
  });

  it("falha ao registrar eventos encerra o executor e deixa a task retomável, não running", async () => {
    const s = setup({ limits: { timeoutSec: 30 } });
    const pidfile = join(s.tmp, "pids.json");
    const started = Date.now();
    const out = await run(s, baseRequest("claude"), { FAKE_SCENARIO: "events-unwritable", FAKE_PIDFILE: pidfile });
    assert.ok(Date.now() - started < 10_000, "não deve esperar o timeout");
    assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
    assert.match(String(out.summary.outcome), /falha ao registrar o andamento/);
    assert.equal(task(s, out.summary.taskId).state, "blocked");
    const pids = JSON.parse(readFileSync(pidfile, "utf8")) as { self: number; grandchild: number };
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(isPidAlive(pids.self), false);
    assert.equal(isPidAlive(pids.grandchild), false);
  });

  it("retomada usa a sessão nativa, informa arquivos já alterados e não repete a base", async () => {
    const s = setup({ limits: { timeoutSec: 2 } });
    const partial = JSON.stringify({ "src/app.ts": "export const app = 1;\nexport const parcial = true;\n" });
    const first = await run(s, baseRequest("claude"), { FAKE_SCENARIO: "timeout", FAKE_PIDFILE: join(s.tmp, "p.json"), FAKE_WRITE: partial });
    assert.equal(first.summary.state, "blocked");
    // o cenário de timeout do fake não escreve; simulamos o trabalho parcial deixado pelo executor interrompido
    s.write("src/app.ts", "export const app = 1;\nexport const parcial = true;\n");
    s.config({ limits: { timeoutSec: 20 } });
    const resumed = await delegate({ cwd: s.root, resumeTaskId: String(first.summary.taskId), env: { ...s.env, FAKE_SCENARIO: "success", FAKE_WRITE: APP_EDIT }, authPaths: s.authPaths });
    assert.equal(resumed.summary.state, "succeeded", JSON.stringify(resumed.summary));
    const calls = s.execCalls() as { resume: string | null; sandbox: string }[];
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.resume, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    assert.equal(calls[1]?.sandbox, "workspace-write");
    const t = task(s, first.summary.taskId);
    assert.equal(t.invocations, 2);
    assert.match(readFileSync(join(t.artifactsDir, "prompt.txt"), "utf8"), /RESUME[\s\S]*src\/app\.ts/);
    const diff = readFileSync(t.verification?.diffPath as string, "utf8");
    assert.match(diff, /-export const app = 1;|\+export const nova = 2;/);
  });

  it("task running com ponte morta é marcada como interrompida e pode ser retomada", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude"), { FAKE_AUTH: "none" });
    const store = new Store(s.root);
    const t = task(s, out.summary.taskId);
    t.state = "running";
    t.pids = { bridge: 999_999, child: null };
    store.saveTask(t);
    const found = refreshInterrupted(store);
    assert.deepEqual(found.map((f) => f.taskId), [t.taskId]);
    assert.equal(task(s, t.taskId).state, "blocked");
    const resumed = await delegate({ cwd: s.root, resumeTaskId: t.taskId, env: { ...s.env, FAKE_WRITE: APP_EDIT }, authPaths: s.authPaths });
    assert.equal(resumed.summary.state, "succeeded", JSON.stringify(resumed.summary));
  });

  it("taskKey repetido e já concluído devolve o resultado sem nova invocação", async () => {
    const s = setup();
    const req = baseRequest("claude", { taskKey: "add-nova" });
    const first = await run(s, req, { FAKE_WRITE: APP_EDIT });
    const again = await run(s, { ...req, runId: first.summary.runId }, { FAKE_WRITE: APP_EDIT });
    assert.equal(again.exitCode, 0);
    assert.equal(again.summary.reused, true);
    assert.equal(s.execCalls().length, 1);
  });
});

describe("recursão e escopo", () => {
  it("a ponte recusa rodar dentro de um executor (DUO_DEPTH=1)", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude"), {}, { DUO_DEPTH: "1" });
    assert.equal(out.exitCode, 3);
    assert.match(String(out.summary.error), /recursiva/);
  });

  it("executor que tenta chamar a ponte de novo é barrado", async () => {
    const s = setup();
    const nested = s.request(baseRequest("codex"), "nested.json");
    const out = await run(s, baseRequest("claude"), { FAKE_SCENARIO: "recursive", FAKE_DUO_CLI: CLI, FAKE_RECURSIVE_REQUEST: nested });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const attempt = s.log().find((e) => e.recursiveAttempt) as { exitCode: number };
    assert.equal(attempt.exitCode, 3);
    assert.equal(s.execCalls().length, 1);
  });

  it("traversal, caminho absoluto, .env e symlink para fora são rejeitados antes da execução", async () => {
    const s = setup();
    symlinkSync(s.tmp, join(s.root, "escape"));
    for (const p of ["../outside.ts", "/etc/passwd", ".env", "escape/x.ts", ".git/config"]) {
      const out = await run(s, baseRequest("claude", { scope: { allowedPaths: [p] } }));
      assert.equal(out.exitCode, 3, p);
      assert.match(String(out.summary.outcome), /escopo inválido/, p);
    }
    assert.equal(s.execCalls().length, 0);
  });

  it("escrita fora do escopo → failed e nada é revertido", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude"), { FAKE_WRITE: JSON.stringify({ "src/app.ts": "x\n", "src/util.ts": "hackeado\n" }) });
    assert.equal(out.summary.state, "failed");
    assert.deepEqual(out.summary.outOfScope, ["src/util.ts"]);
    assert.equal(s.read("src/util.ts"), "hackeado\n");
  });

  it("escrita em arquivo protegido (.env) é detectada", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude"), { FAKE_WRITE: JSON.stringify({ ".env": "TOKEN=x\n" }) });
    assert.equal(out.summary.state, "failed");
    assert.deepEqual(out.summary.deniedTouched, [".env"]);
  });

  it("tarefa de revisão que altera arquivo → failed", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { kind: "review", reason: "user_requested", scope: { allowedPaths: ["src/"] } }), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "failed");
    assert.deepEqual(out.summary.outOfScope, ["src/app.ts"]);
    const call = s.execCalls()[0] as { sandbox: string };
    assert.equal(call.sandbox, "read-only");
  });

  it("executor que remove o lock de executor único → failed", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "remove-lock" });
    assert.equal(out.summary.state, "failed");
    assert.match(String(out.summary.outcome), /lock/);
  });

  it("lock mantido por outro processo vivo bloqueia um segundo executor", async () => {
    const s = setup();
    writeFileSync(join(s.root, ".duo", "lock.json"), JSON.stringify({ pid: process.pid, taskId: "task-outra-000000", runId: "run-outro-000000", nonce: "n", startedAt: "" }));
    const out = await run(s, baseRequest("claude"), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.exitCode, 3);
    assert.match(String(out.summary.outcome), /outro executor/);
    assert.equal(s.execCalls().length, 0);
  });
});

describe("preservação, verificação real e segredos", () => {
  it("alterações prévias do usuário são preservadas e o diff mostra só o delta do executor", async () => {
    const s = setup();
    s.write("src/app.ts", "export const app = 1;\n// nota do usuário\n");
    s.write("README.md", "# demo\nrascunho do usuário\n");
    const out = await run(s, baseRequest("claude"), { FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 1;\n// nota do usuário\nexport const nova = 2;\n" }) });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const t = task(s, out.summary.taskId);
    assert.deepEqual(t.base?.dirtyInScope, ["src/app.ts"]);
    const diff = readFileSync(t.verification?.diffPath as string, "utf8");
    assert.match(diff, /\+export const nova = 2;/);
    assert.ok(!diff.includes("+// nota do usuário"));
    assert.equal(s.read("README.md"), "# demo\nrascunho do usuário\n");
  });

  it("teste real falhando derruba o 'completed' declarado pelo modelo", async () => {
    const s = setup();
    const req = baseRequest("claude", { acceptance: { criteria: ["testes passam"], commands: [{ name: "tests", argv: ["node", "-e", "process.exit(1)"] }] } });
    const out = await run(s, req, { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "failed");
    assert.equal(out.summary.executorStatus, "completed");
    assert.match(String(out.summary.outcome), /critério de aceite falhou/);
    const r = buildReport(new Store(s.root)) as { byExecutor: { codex: { claimedSuccessButFailed: number } } };
    assert.equal(r.byExecutor.codex.claimedSuccessButFailed, 1);
  });

  it("teste real passando confirma o sucesso", async () => {
    const s = setup();
    const req = baseRequest("claude", { acceptance: { criteria: ["testes passam"], commands: [{ name: "tests", argv: ["node", "-e", "process.exit(0)"] }] } });
    const out = await run(s, req, { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.deepEqual(out.summary.acceptance, [{ name: "tests", ran: true, passed: true, exitCode: 0 }]);
  });

  it("comando de aceite fora da allowlist bloqueia antes de invocar", async () => {
    const s = setup();
    const req = baseRequest("claude", { acceptance: { criteria: ["limpeza feita"], commands: [{ name: "rm", argv: ["rm", "-rf", "/"] }] } });
    const out = await run(s, req);
    assert.equal(out.exitCode, 3);
    assert.match(String(out.summary.outcome), /allowedCommands/);
    assert.equal(s.execCalls().length, 0);
  });

  it("segredos emitidos pelo executor não chegam aos logs", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "leak-secret" });
    const t = task(s, out.summary.taskId);
    const events = readFileSync(join(t.artifactsDir, "events.jsonl"), "utf8");
    assert.ok(!events.includes("SECRETSECRETSECRET"));
    assert.ok(!events.includes("abcdefghijklmnop123"));
  });

  for (const brain of ["claude", "codex"] as const) {
    for (const format of ["plain", "json"]) {
      it(`PEM Ed25519 multilinha (${brain}, ${format}) não chega aos artefatos`, async () => {
        const s = setup();
        const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const out = await run(s, baseRequest(brain), {
          FAKE_SCENARIO: "private-key", FAKE_PRIVATE_KEY: pem, FAKE_KEY_FORMAT: format, FAKE_WRITE: APP_EDIT,
        });
        assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
        const current = task(s, out.summary.taskId);
        const events = readFileSync(join(current.artifactsDir, "events.jsonl"), "utf8");
        const stderr = readFileSync(join(current.artifactsDir, "stderr.txt"), "utf8");
        for (const line of pem.trim().split("\n")) {
          assert.ok(!events.includes(line), "nenhuma linha do PEM pode ser persistida em stdout");
          assert.ok(!stderr.includes(line), "cauda de stderr deve falhar fechado");
        }
        if (format === "json") {
          for (const line of events.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
        }
        assert.ok(events.includes('"<redacted>"') || events.includes("<redacted>"));
        assert.ok(events.includes("completed"), "eventos após END devem continuar registrados");
        assert.equal(current.pids.child, null);
        assert.equal(existsSync(join(s.root, ".duo", "lock.json")), false);
      });
    }
  }

  it("status parcial do executor → blocked com trabalho parcial preservado", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "partial", FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "blocked");
    assert.match(String(out.summary.outcome), /formato de data/);
    assert.match(s.read("src/app.ts"), /nova/);
  });
});

describe("worktree e base desatualizada", () => {
  it("patch de worktree é aplicado quando a base não mudou", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { isolation: "worktree" }), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.equal(s.read("src/app.ts"), "export const app = 1;\n");
    const applied = applyTask(s.root, String(out.summary.taskId));
    assert.equal(applied.ok, true, applied.message);
    assert.match(s.read("src/app.ts"), /nova = 2/);
    assert.equal(applyTask(s.root, String(out.summary.taskId)).message, "patch já aplicado anteriormente; nada a fazer");
  });

  it("patch sobre base desatualizada é rejeitado", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { isolation: "worktree" }), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    s.write("README.md", "# mudou\n");
    s.git("commit", "-qam", "outra mudança");
    const applied = applyTask(s.root, String(out.summary.taskId));
    assert.equal(applied.ok, false);
    assert.match(applied.message, /base desatualizada/);
    assert.equal(s.read("src/app.ts"), "export const app = 1;\n");
  });

  it("arquivo do escopo alterado pelo usuário após a base impede a integração", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { isolation: "worktree" }), { FAKE_WRITE: APP_EDIT });
    s.write("src/app.ts", "export const app = 99;\n");
    const applied = applyTask(s.root, String(out.summary.taskId));
    assert.equal(applied.ok, false);
    assert.match(applied.message, /mudaram desde a base/);
    assert.equal(s.read("src/app.ts"), "export const app = 99;\n");
    assert.ok(existsSync(join(s.root, "src", "app.ts")));
  });
});

describe("modelo do executor Claude (preferência Opus 5.5)", () => {
  it("usa claude-opus-5-5 por padrão e registra o modelo efetivo", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const call = s.execCalls()[0] as { args: string[] };
    assert.equal(call.args[call.args.indexOf("--model") + 1], "claude-opus-5-5");
    assert.deepEqual(out.summary.model, { requested: "claude-opus-5-5", reported: "claude-opus-5-5", reportedSource: "native" });
  });

  it("CLI antiga demais para o modelo → failed com instrução de atualizar (envelope real, exit 0)", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "version-too-old" });
    assert.equal(out.summary.state, "failed");
    assert.match(String(out.summary.outcome), /modelo indisponível[\s\S]*claude update/);
  });

  it("modelo efetivo diferente do pedido vira alerta explícito", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "model-fallback", FAKE_WRITE: APP_EDIT });
    assert.ok((out.summary.limitations as string[]).some((l) => l.includes("modelo solicitado claude-opus-5-5, mas o cliente informou claude-opus-4-7")));
  });
});

describe("observação nativa de limite (rate_limit_event do Claude Code)", () => {
  it("registra janela, reset e estado de uso extra, e o relatório mostra como nativo", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.equal(out.summary.outcome, "concluído e verificado");
    const t = task(s, out.summary.taskId);
    assert.deepEqual(t.metrics?.native.rateLimit, {
      status: "allowed", rateLimitType: "five_hour", resetsAt: "2100-01-01T00:00:00.000Z", overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false,
    });
    const r = buildReport(new Store(s.root)) as { quota: Record<string, Record<string, unknown>> };
    assert.equal(r.quota.claude?.source, "native");
    assert.match(String(r.quota.claude?.status), /observada nativamente: allowed/);
    assert.equal(r.quota.codex?.status, "não disponível");
  });

  it("uso extra informado pelo cliente vira alerta explícito na task", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex"), { FAKE_SCENARIO: "overage", FAKE_WRITE: APP_EDIT });
    assert.ok((out.summary.limitations as string[]).some((l) => l.includes("uso extra (overage) ativo")));
  });
});

describe("catálogo das contas, mesmo fornecedor e arte", () => {
  it("modelo fora do catálogo da conta é bloqueado antes de invocar, listando os disponíveis", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { model: "gpt-9-imaginario" }));
    assert.equal(out.exitCode, 3);
    assert.match(String(out.summary.outcome), /não está disponível na conta do codex; disponíveis: gpt-6-astra, gpt-6-sol, gpt-5\.6-sol/);
    assert.equal(s.execCalls().length, 0);
  });

  it("alias do fornecedor (opus) é aceito pelo catálogo", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex", { model: "opus" }), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  });

  it("delegar ao MESMO fornecedor com outro modelo funciona (ex.: cérebro Claude → Claude Sonnet 5)", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { executor: "claude", model: "claude-sonnet-5", brainModel: "claude-opus-5-5" }), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const call = s.execCalls()[0] as { args: string[] };
    assert.equal(call.args[call.args.indexOf("--model") + 1], "claude-sonnet-5");
  });

  it("mesmo fornecedor sem model, ou com o próprio modelo do cérebro, é recusado", async () => {
    const s = setup();
    assert.equal((await run(s, baseRequest("claude", { executor: "claude" }))).exitCode, 2);
    const same = await run(s, baseRequest("codex", { executor: "codex", model: "gpt-6-astra", brainModel: "gpt-6-astra" }));
    assert.equal(same.exitCode, 2);
    assert.match(String(same.summary.error), /próprio cérebro/);
  });

  const ART = { kind: "asset", needs: ["image_generation"], objective: "Criar uma ilustração quadrada do mascote em assets/art.png.", scope: { allowedPaths: ["assets/"] }, acceptance: { criteria: ["assets/art.png é uma imagem válida"] } };

  it("arte: Codex com gpt-6-astra gera a imagem, a ponte confere a assinatura PNG", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { ...ART, model: "gpt-6-astra" }), { FAKE_SCENARIO: "image" });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.deepEqual(out.summary.images, [{ path: "assets/art.png", format: "png", bytes: 69, width: 1, height: 1 }]);
    const call = s.execCalls()[0] as { args: string[] };
    assert.ok(call.args.includes("--enable") && call.args.includes("image_generation"));
    assert.equal(call.args[call.args.indexOf("--model") + 1], "gpt-6-astra");
  });

  it("arte: relatório completed sem imagem válida no escopo → failed", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { ...ART, model: "gpt-6-astra" }), { FAKE_SCENARIO: "image-missing" });
    assert.equal(out.summary.state, "failed");
    assert.match(String(out.summary.outcome), /nenhuma imagem válida/);
  });

  it("arte pedida ao Claude, ou a um Codex sem a ferramenta, é bloqueada antes de invocar", async () => {
    const s = setup();
    const toClaude = await run(s, baseRequest("codex", { ...ART }));
    assert.equal(toClaude.exitCode, 3);
    assert.match(String(toClaude.summary.outcome), /não oferece geração de imagem|não gera imagens/);
    const s2 = setup();
    const noTool = await run(s2, baseRequest("claude", { ...ART }), {}, { FAKE_NO_IMAGE_GEN: "1" });
    assert.equal(noTool.exitCode, 3);
    assert.equal(s2.execCalls().length, 0);
  });

  it("executor Codex roda sem hooks e plugins do usuário por padrão; configurável", async () => {
    const s = setup();
    await run(s, baseRequest("claude"), { FAKE_WRITE: APP_EDIT });
    const args = (s.execCalls()[0] as { args: string[] }).args.join(" ");
    assert.match(args, /--disable hooks --disable plugins/);
    const s2 = setup({ executors: { codex: { disableUserExtensions: false } } });
    await run(s2, baseRequest("claude"), { FAKE_WRITE: APP_EDIT });
    assert.doesNotMatch((s2.execCalls()[0] as { args: string[] }).args.join(" "), /--disable/);
  });

  it("provas do rollout do Codex: modelo efetivo, IDs de resposta do servidor e ferramentas, sem copiar o conteúdo", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { model: "gpt-6-astra" }), { FAKE_WRITE: APP_EDIT });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    const ev = (out.summary.evidence as { codexSession: Record<string, unknown> }).codexSession;
    assert.equal(ev.model, "gpt-6-astra");
    assert.equal(ev.modelProvider, "openai");
    assert.equal(ev.originator, "codex_exec");
    assert.equal(ev.sandbox, "workspace-write");
    assert.equal(ev.serverResponseIds, 2);
    assert.deepEqual(ev.tools, ["exec_command"]);
    const t = task(s, out.summary.taskId);
    assert.equal(t.model.reported, "gpt-6-astra");
    assert.ok(!readFileSync(join(t.artifactsDir, "task.json"), "utf8").includes("segredo do prompt"));
  });

  it("modelo efetivo diferente do pedido vira alerta; sem rollout, o modelo fica não disponível", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { model: "gpt-6-astra" }), { FAKE_WRITE: APP_EDIT, FAKE_ROLLOUT_MODEL: "gpt-6-sol" });
    assert.ok((out.summary.limitations as string[]).some((l) => l === "modelo solicitado gpt-6-astra, mas o cliente informou gpt-6-sol"));
    const s2 = setup();
    const none = await run(s2, baseRequest("claude"), { FAKE_WRITE: APP_EDIT, FAKE_NO_ROLLOUT: "1" });
    assert.equal(none.summary.state, "succeeded");
    assert.match(String((none.summary.evidence as { codexSession: unknown }).codexSession), /rollout não encontrado/);
    assert.equal((none.summary.model as { reportedSource: string }).reportedSource, "unavailable");
  });

  it("arte: a imagem entregue é a mesma (SHA-256) que a ferramenta de imagem do Codex gerou", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { ...ART, model: "gpt-6-astra" }), { FAKE_SCENARIO: "image" });
    const ev = out.summary.evidence as { codexSession: { tools: string[] }; images: { path: string; sha256: string; generatedByExecutorTool: boolean }[] };
    assert.ok(ev.codexSession.tools.includes("image_gen__imagegen"));
    assert.equal(ev.images[0]?.generatedByExecutorTool, true);
    assert.match(ev.images[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    const s2 = setup();
    const copied = await run(s2, baseRequest("claude", { ...ART, model: "gpt-6-astra" }), { FAKE_SCENARIO: "image", FAKE_IMAGE_NOT_FROM_TOOL: "1" });
    assert.equal((copied.summary.evidence as { images: { generatedByExecutorTool: boolean }[] }).images[0]?.generatedByExecutorTool, false);
  });

  it("needs=image_generation exige kind=asset", async () => {
    const s = setup();
    const out = await run(s, baseRequest("claude", { needs: ["image_generation"] }));
    assert.equal(out.exitCode, 2);
  });

  it("sem catálogo descobrível, a delegação segue e o modelo é confirmado na execução", async () => {
    const s = setup();
    const out = await run(s, baseRequest("codex", { model: "claude-sonnet-5" }), { FAKE_WRITE: APP_EDIT }, { FAKE_NO_CATALOG: "1" });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
  });
});
