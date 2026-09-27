// CLI como processo real: cancelamento, init (preview/backup), doctor e report. CLIs de IA simuladas.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { isPidAlive } from "../src/adapters/process.js";
import { cancelRun } from "../src/orchestration/control.js";
import { duoCliCommand } from "../src/cli/init.js";
import { Store } from "../src/state/store.js";
import { baseRequest, CLI, makeSandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | null = null;
afterEach(() => {
  sb?.cleanup();
  sb = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cli(s: Sandbox, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: s.root, env: { ...s.env, ...env }, encoding: "utf8" });
}

describe("cancelamento", () => {
  it("duo cancel interrompe a ponte e o executor sem deixar processos órfãos", async () => {
    sb = makeSandbox({ limits: { timeoutSec: 120 } });
    const s = sb;
    const pidfile = join(s.tmp, "pids.json");
    const req = s.request(baseRequest("codex"));
    const child = spawn(process.execPath, [CLI, "delegate", "--request", req], {
      cwd: s.root,
      env: { ...s.env, FAKE_SCENARIO: "timeout", FAKE_PIDFILE: pidfile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
    for (let i = 0; i < 100 && !existsSync(pidfile); i++) await sleep(100);
    assert.ok(existsSync(pidfile), "executor simulado deveria ter iniciado");
    const pids = JSON.parse(readFileSync(pidfile, "utf8")) as { self: number; grandchild: number };
    const runId = new Store(s.root).listRuns()[0]?.runId as string;
    const res = await cancelRun(s.root, runId);
    assert.equal(res.ok, true);
    const code = await exited;
    assert.equal(code, 4, stdout);
    const summary = JSON.parse(stdout) as { state: string };
    assert.equal(summary.state, "cancelled");
    await sleep(300);
    assert.equal(isPidAlive(pids.self), false);
    assert.equal(isPidAlive(pids.grandchild), false);
    const second = cli(s, ["delegate", "--request", s.request(baseRequest("codex", { runId }))]);
    assert.equal(second.status, 3);
    assert.match(second.stdout, /cancelado/);
  });
});

describe("duo init", () => {
  it("mostra preview sem escrever, cria com --apply e não sobrescreve sem --overwrite", () => {
    sb = makeSandbox();
    const s = sb;
    writeFileSync(join(s.root, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
    writeFileSync(join(s.root, ".duo", "config.json"), '{"policy":"equilibrado"}\n');
    const preview = cli(s, ["init"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /CONFLITO/);
    assert.match(preview.stdout, /\+ \.claude\/skills\/duo-delegate\/SKILL\.md/);
    assert.ok(!existsSync(join(s.root, ".claude", "skills")));

    const applied = cli(s, ["init", "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(join(s.root, ".duo", "config.json"), "utf8"), '{"policy":"equilibrado"}\n');
    const skill = readFileSync(join(s.root, ".claude", "skills", "duo-delegate", "SKILL.md"), "utf8");
    // `duo` quando o PATH aponta para esta instalação (npm link), senão o caminho absoluto: não depende da máquina.
    assert.ok(skill.includes(`${duoCliCommand(s.env)} models`), "skill deve chamar o duo desta instalação");
    assert.ok(!skill.includes("{{DUO_CLI}}"));
    assert.ok(existsSync(join(s.root, ".agents", "skills", "duo-delegate", "references", "request-format.md")));
    assert.match(readFileSync(join(s.root, ".agents", "skills", "duo-delegate", "references", "request-format.md"), "utf8"), /"brain": "codex"/);

    const over = cli(s, ["init", "--apply", "--overwrite"]);
    assert.equal(over.status, 0, over.stderr);
    const cfg = JSON.parse(readFileSync(join(s.root, ".duo", "config.json"), "utf8")) as { acceptance: { allowedCommands: string[][] } };
    assert.deepEqual(cfg.acceptance.allowedCommands, [["npm", "test"]]);
    const backups = readdirSync(join(s.root, ".duo", "backups"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(s.root, ".duo", "backups", backups[0] as string, ".duo", "config.json"), "utf8"), '{"policy":"equilibrado"}\n');
  });
});

describe("doctor e report", () => {
  it("doctor diagnostica os dois executores sem invocar inferência", () => {
    sb = makeSandbox();
    const s = sb;
    const r = cli(s, ["doctor", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout) as { ready: Record<string, boolean>; providers: Record<string, { version: string; auth: { method: string } }> };
    assert.deepEqual(report.ready, { claude: true, codex: true });
    assert.equal(report.providers.claude?.auth.method, "subscription");
    assert.equal(report.providers.codex?.version, "0.155.0");
    assert.equal(s.execCalls().length, 0);
  });

  it("report é determinístico e separa origem das métricas; quota manual expira", () => {
    sb = makeSandbox();
    const s = sb;
    const d = cli(s, ["delegate", "--request", s.request(baseRequest("claude"))], { FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const nova = 1;\n" }) });
    assert.equal(d.status, 0, d.stdout + d.stderr);
    const q = cli(s, ["quota", "set", "--provider", "codex", "--used-percent", "40", "--resets-at", "2020-01-01T00:00:00Z"]);
    assert.equal(q.status, 0, q.stderr);
    const text = cli(s, ["report"]);
    assert.match(text.stdout, /\[codex\] tasks=1 ok=1/);
    assert.match(text.stdout, /codex: expirada/);
    assert.match(text.stdout, /claude: não disponível/);
    const json = JSON.parse(cli(s, ["report", "--json"]).stdout) as { byExecutor: { codex: { nativeUsageTotals: Record<string, number> } } };
    assert.equal(json.byExecutor.codex.nativeUsageTotals.input_tokens, 24763);
    const status = cli(s, ["status"]);
    assert.match(status.stdout, /succeeded/);
    const handoff = cli(s, ["handoff", "--to", "codex", "--next", "revisar o diff"]);
    assert.equal(handoff.status, 0);
    assert.match(handoff.stdout, /Handoff para Codex/);
    assert.match(handoff.stdout, /revisar o diff/);
  });
});

describe("duo recommend", () => {
  it("usa o histórico real do projeto, marca indisponibilidade e registra a consulta", () => {
    sb = makeSandbox();
    const s = sb;
    const edit = JSON.stringify({ "src/app.ts": "export const app = 2;\n" });
    for (let i = 0; i < 3; i++) {
      const d = cli(s, ["delegate", "--request", s.request(baseRequest("claude", { objective: `Tarefa comparável número ${i} em src/app.ts.` }))], { FAKE_WRITE: edit });
      assert.equal(d.status, 0, d.stdout);
      s.git("checkout", "--", "src/app.ts");
    }
    const tasks = new Store(s.root).listRuns().flatMap((r) => new Store(s.root).listTasks(r));
    assert.ok(tasks.every((t) => t.tags.includes("ts")));
    const rec = cli(s, ["recommend", "--kind", "implement", "--paths", "src/app.ts", "--brain", "claude", "--json"]);
    assert.equal(rec.status, 0, rec.stderr);
    const r = JSON.parse(rec.stdout) as { decision: { action: string; executor: string }; candidates: { executor: string; evidence: { n: number } }[] };
    assert.equal(r.decision.action, "delegate");
    assert.equal(r.decision.executor, "codex");
    assert.equal(r.candidates.find((c) => c.executor === "codex")?.evidence.n, 3);
    const down = cli(s, ["recommend", "--kind", "implement", "--brain", "claude", "--json"], { FAKE_AUTH: "none" });
    const rd = JSON.parse(down.stdout) as { candidates: { available: boolean }[] };
    assert.ok(rd.candidates.every((c) => !c.available));
    const telemetry = readFileSync(join(s.root, ".duo", "telemetry.jsonl"), "utf8");
    assert.match(telemetry, /"event":"recommend"/);
    const text = cli(s, ["recommend", "--kind", "review", "--paths", "src/", "--risk", "high"]);
    assert.match(text.stdout, /Recomendação:/);
  });
});
