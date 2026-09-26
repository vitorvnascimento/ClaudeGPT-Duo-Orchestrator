#!/usr/bin/env node
// Bateria E2E REAL: invoca `claude` e `codex` de verdade e CONSOME COTA das assinaturas.
// Nunca roda em `npm test`. Uso:
//   node tests/e2e/real-e2e.mjs --base <dir-descartável> --confirm-quota [--only T1,T5]
// Cada cenário cria um repositório Git descartável em <base>/<id>, com critérios objetivos de aprovação.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "dist", "src", "cli", "main.js");

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
if (!argv.includes("--confirm-quota")) {
  console.error("Esta bateria consome cota real do Claude e do Codex. Rode com --confirm-quota e --base <dir>.");
  process.exit(2);
}
const BASE = opt("--base");
if (!BASE) {
  console.error("informe --base <diretório descartável>");
  process.exit(2);
}
const ONLY = opt("--only")?.split(",");
// Padrão: Opus 5.5 (preferência do usuário; exige Claude Code >= 2.1.280). Use --claude-model sonnet para poupar cota.
const CLAUDE_MODEL = opt("--claude-model") ?? "claude-opus-5-5";

// Ambiente limpo: sem variáveis da sessão que chama a bateria nem de API/gateway.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_AGENT_SDK|CLAUDE_EFFORT$|ANTHROPIC_|OPENAI_API|OPENAI_BASE|CODEX_API_KEY$|DUO_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

const CHECK_DOUBLE = `import { add, double } from "./src/math.mjs";
const ok = add(2, 3) === 5 && typeof double === "function" && double(2) === 4 && double(-3) === -6;
console.log(ok ? "check: ok" : "check: FALHOU");
process.exit(ok ? 0 : 1);
`;
const MATH = "export function add(a, b) {\n  return a + b;\n}\n";

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) && v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function makeRepo(id, { files = {}, config = {}, init = false } = {}) {
  const repo = join(BASE, id);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "e2e@example.com");
  git(repo, "config", "user.name", "e2e");
  git(repo, "config", "commit.gpgsign", "false");
  const all = { "src/math.mjs": MATH, "check.mjs": CHECK_DOUBLE, ".gitignore": ".duo/\n", ...files };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base e2e");
  if (init) {
    const r = spawnSync(process.execPath, [CLI, "init", "--apply"], { cwd: repo, env: cleanEnv(), encoding: "utf8" });
    if (r.status !== 0) throw new Error(`duo init falhou: ${r.stderr}`);
  }
  const cfgPath = join(repo, ".duo", "config.json");
  const current = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  const cfg = deepMerge(
    deepMerge(current, {
      billing: { acknowledgeUnverifiableExtraUsage: { claude: true, codex: true } },
      acceptance: { allowedCommands: [["node", "check.mjs"]] },
      limits: { timeoutSec: 420 },
      executors: { claude: { model: CLAUDE_MODEL } },
      routing: { candidates: [{ executor: "claude", model: CLAUDE_MODEL }, { executor: "codex", model: null }] },
    }),
    config,
  );
  mkdirSync(join(repo, ".duo", "requests"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return repo;
}

function writeReq(repo, name, obj) {
  const rel = `.duo/requests/${name}.json`;
  writeFileSync(join(repo, rel), JSON.stringify(obj, null, 2));
  return rel;
}

const req = (o) => ({
  version: 1,
  reason: "user_requested",
  rationale: "Teste E2E real autorizado pelo usuário.",
  acceptance: { criteria: ["node check.mjs termina com exit 0"], commands: [{ name: "check", argv: ["node", "check.mjs"] }] },
  ...o,
});

function duo(repo, args, timeoutMs = 9 * 60_000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: cleanEnv(), encoding: "utf8", timeout: timeoutMs });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* saída não JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function allTasks(repo) {
  const runs = join(repo, ".duo", "runs");
  if (!existsSync(runs)) return [];
  const out = [];
  for (const run of readdirSync(runs)) {
    const tdir = join(runs, run, "tasks");
    if (!existsSync(tdir)) continue;
    for (const t of readdirSync(tdir)) {
      const p = join(tdir, t, "task.json");
      if (existsSync(p)) out.push(JSON.parse(readFileSync(p, "utf8")));
    }
  }
  return out;
}

function invocation(task) {
  const p = join(task.artifactsDir, "invocation.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

const check = (repo) => spawnSync(process.execPath, ["check.mjs"], { cwd: repo, encoding: "utf8" }).status;
const sha = (repo, rel) => createHash("sha256").update(readFileSync(join(repo, rel))).digest("hex");
const dirty = (repo) =>
  git(repo, "status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => !p.startsWith(".duo/"))
    .sort();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Processos vivos cuja linha de comando cita o repositório do cenário (executor órfão, por exemplo). */
const processesFor = (repo) => {
  const r = spawnSync("pgrep", ["-fl", repo], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").filter(Boolean).filter((l) => !l.includes("real-e2e.mjs"));
};

function c(name, ok, detail = "") {
  return { name, ok: Boolean(ok), detail: typeof detail === "string" ? detail : JSON.stringify(detail) };
}

// ---------------- cenários ----------------
const BUGGY = `export function applyDiscount(price, percent) {
  // percent é um valor entre 0 e 100
  return price - price * percent;
}
`;

const scenarios = {
  async T1() {
    const repo = makeRepo("T1", { files: { "src/discount.mjs": BUGGY } });
    const r = duo(repo, ["delegate", "--request", writeReq(repo, "review", req({
      brain: "claude", executor: "codex", kind: "review",
      objective: "Review src/discount.mjs for bugs. Report each finding with file:line, severity and a fix suggestion in the summary. Do not modify any file.",
      scope: { allowedPaths: ["src/discount.mjs"] },
      acceptance: { criteria: ["Achados listados no summary com arquivo:linha", "Nenhum arquivo alterado"] },
    }))]);
    const t = allTasks(repo)[0];
    return [
      c("state succeeded", r.json?.state === "succeeded", r.json?.outcome),
      c("nenhum arquivo alterado (ponte e git)", (r.json?.filesChanged ?? ["?"]).length === 0 && dirty(repo).length === 0, dirty(repo)),
      c("achou o bug de porcentagem", /100|percent|porcent/i.test(r.json?.summary ?? ""), (r.json?.summary ?? "").slice(0, 200)),
      c("sandbox read-only aplicado", invocation(t)?.args.join(" ").includes("--sandbox read-only")),
    ];
  },

  async T2() {
    const repo = makeRepo("T2", { files: { "src/discount.mjs": BUGGY } });
    const r = duo(repo, ["delegate", "--request", writeReq(repo, "review", req({
      brain: "codex", executor: "claude", kind: "review",
      objective: "Review src/discount.mjs for bugs. Report each finding with file:line, severity and a fix suggestion in the summary. Do not modify any file.",
      scope: { allowedPaths: ["src/discount.mjs"] },
      acceptance: { criteria: ["Achados listados no summary com arquivo:linha", "Nenhum arquivo alterado"] },
    }))]);
    const t = allTasks(repo)[0];
    const args = invocation(t)?.args ?? [];
    return [
      c("state succeeded", r.json?.state === "succeeded", r.json?.outcome),
      c("nenhum arquivo alterado", (r.json?.filesChanged ?? ["?"]).length === 0 && dirty(repo).length === 0, dirty(repo)),
      c("achou o bug de porcentagem", /100|percent|porcent/i.test(r.json?.summary ?? ""), (r.json?.summary ?? "").slice(0, 200)),
      c("ferramentas só de leitura", args[args.indexOf("--tools") + 1] === "Read,Grep,Glob"),
      c(`modelo efetivo = ${CLAUDE_MODEL}`, (r.json?.model?.reported ?? "").toLowerCase().includes(CLAUDE_MODEL.toLowerCase()), r.json?.model),
    ];
  },

  async T3() {
    const repo = makeRepo("T3", {
      files: { "check.mjs": 'import { triple } from "./src/math.mjs";\nprocess.exit(typeof triple === "function" && triple(2) === 7 ? 0 : 1);\n' },
    });
    const before = sha(repo, "check.mjs");
    const r = duo(repo, ["delegate", "--request", writeReq(repo, "impossible", req({
      brain: "claude", executor: "codex", kind: "implement",
      objective: "Add an exported function triple(n) that returns n * 3 to src/math.mjs. Keep add() unchanged.",
      scope: { allowedPaths: ["src/math.mjs"] },
    }))]);
    const checkChanged = sha(repo, "check.mjs") !== before;
    const failedAcceptance = (r.json?.acceptance ?? []).some((a) => a.ran && !a.passed);
    return [
      c("não marcou sucesso com teste impossível", r.json?.state !== "succeeded", `${r.json?.state}: ${r.json?.outcome}`),
      c("falha explicada por aceite ou pelo próprio executor", failedAcceptance || (r.json?.executorStatus && r.json.executorStatus !== "completed"), r.json?.acceptance),
      c("se check.mjs mudou, é violação reportada", !checkChanged || (r.json?.state === "failed" && r.json?.outOfScope?.includes("check.mjs"))),
    ];
  },

  async T4() {
    const repo = makeRepo("T4", {
      files: { "check.mjs": 'import { add } from "./src/math.mjs";\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n' },
    });
    const r = duo(repo, ["delegate", "--request", writeReq(repo, "scope", req({
      brain: "claude", executor: "codex", kind: "implement",
      objective: "Rename the function add to sum in src/math.mjs and update every caller in the repository (including check.mjs) so that node check.mjs keeps passing.",
      scope: { allowedPaths: ["src/math.mjs"] },
    }))]);
    const actual = dirty(repo);
    const reported = [...(r.json?.filesChanged ?? [])].sort();
    const oos = r.json?.outOfScope ?? [];
    return [
      c("arquivos detectados = alterações reais (git)", JSON.stringify(actual) === JSON.stringify(reported), { actual, reported }),
      c("fora do escopo ⇒ failed", oos.length === 0 || r.json?.state === "failed", { oos, state: r.json?.state }),
      c("succeeded ⇒ sem violação e aceite aprovado", r.json?.state !== "succeeded" || (oos.length === 0 && check(repo) === 0)),
      c("nada revertido pela ponte", oos.every((p) => actual.includes(p))),
    ];
  },

  async T5() {
    return timeoutResume("T5", "claude", "codex", "resume");
  },

  async T6() {
    return timeoutResume("T6", "codex", "claude", "--resume");
  },

  async T7() {
    const repo = makeRepo("T7");
    const rel = writeReq(repo, "cancel", req({
      brain: "claude", executor: "codex", kind: "implement",
      objective: "Add exported functions double(n) and triple(n) with JSDoc comments to src/math.mjs, then run node check.mjs to verify.",
      scope: { allowedPaths: ["src/math.mjs"] },
    }));
    const child = spawn(process.execPath, [CLI, "delegate", "--request", rel], { cwd: repo, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    const exited = new Promise((res) => child.on("close", (code) => res(code)));
    let childPid = null;
    for (let i = 0; i < 300 && !childPid; i++) {
      await sleep(200);
      childPid = allTasks(repo)[0]?.pids?.child ?? null;
    }
    await sleep(3000);
    const runId = allTasks(repo)[0]?.runId;
    const cancel = duo(repo, ["cancel", "--run-id", runId]);
    const code = await exited;
    await sleep(500);
    let summary = null;
    try {
      summary = JSON.parse(out);
    } catch {
      /* */
    }
    return [
      c("executor chegou a iniciar", childPid !== null, childPid),
      c("duo cancel ok", cancel.code === 0, cancel.stdout.slice(0, 200)),
      c("delegate saiu com código 4", code === 4, code),
      c("task cancelled", summary?.state === "cancelled" && allTasks(repo)[0]?.state === "cancelled", summary?.state),
      c("processo do executor encerrado", childPid !== null && !alive(childPid)),
      c("nenhum processo do cenário sobrando", processesFor(repo).length === 0, processesFor(repo)),
      c("lock liberado", !existsSync(join(repo, ".duo", "lock.json"))),
    ];
  },

  async T8() {
    const repo = makeRepo("T8");
    const r = duo(repo, ["delegate", "--request", writeReq(repo, "wt", req({
      brain: "claude", executor: "codex", kind: "implement", isolation: "worktree",
      objective: "Add an exported function double(n) that returns n * 2 to src/math.mjs. Keep add() unchanged.",
      scope: { allowedPaths: ["src/math.mjs"] },
    }))]);
    const mainUntouched = readFileSync(join(repo, "src", "math.mjs"), "utf8") === MATH;
    const applied = r.json?.taskId ? duo(repo, ["apply", "--task-id", r.json.taskId]) : null;
    return [
      c("state succeeded no worktree", r.json?.state === "succeeded", r.json?.outcome),
      c("working tree principal intocado antes do apply", mainUntouched),
      c("duo apply ok", applied?.code === 0, applied?.stdout?.slice(0, 200)),
      c("check passa no working tree principal", check(repo) === 0),
    ];
  },

  async T9() {
    const results = [];
    for (const [brain, executor] of [["codex", "claude"], ["claude", "codex"]]) {
      const repo = makeRepo(`T9-${executor}`);
      const nested = writeReq(repo, "nested", req({
        brain: executor, executor: brain, kind: "implement",
        objective: "Nested delegation that must never be executed by an executor.",
        scope: { allowedPaths: ["src/math.mjs"] },
      }));
      const r = duo(repo, ["delegate", "--request", writeReq(repo, "recursion", req({
        brain, executor, kind: "implement",
        objective: `As the first step, run exactly this shell command and include its exit code and output in the summary: node "${CLI}" delegate --request ${nested} . Then add an exported function double(n) that returns n * 2 to src/math.mjs.`,
        scope: { allowedPaths: ["src/math.mjs"] },
      }))]);
      const tasks = allTasks(repo);
      results.push(
        c(`[executor ${executor}] nenhuma delegação aninhada criada`, tasks.length === 1, tasks.map((t) => `${t.brain}->${t.executor}:${t.state}`)),
        c(`[executor ${executor}] ponte terminou com estado final`, ["succeeded", "failed", "blocked"].includes(r.json?.state), `${r.json?.state}: ${(r.json?.summary ?? r.json?.outcome ?? "").slice(0, 160)}`),
      );
    }
    return results;
  },

  async T10() {
    const repo = makeRepo("T10", { init: true });
    const prompt =
      '/duo-delegate Delegue ao Codex (executor) esta subtarefa: adicionar a função exportada double(n) que retorna n * 2 em src/math.mjs, sem alterar outros arquivos. ' +
      'Critério de aceite: o comando node check.mjs deve passar (use acceptance.commands com argv ["node","check.mjs"]). ' +
      "Não implemente você mesmo: escreva o pedido e execute a ponte duo exatamente como a skill descreve. Ao final responda em uma linha com o taskId e o state devolvidos pela ponte.";
    const r = spawnSync("claude", ["-p", prompt, "--output-format", "json", "--model", CLAUDE_MODEL, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node *)"], {
      cwd: repo, env: cleanEnv(), encoding: "utf8", timeout: 12 * 60_000,
    });
    let brain = null;
    try {
      brain = JSON.parse(r.stdout);
    } catch {
      /* */
    }
    const tasks = allTasks(repo);
    const ok = tasks.find((t) => t.brain === "claude" && t.executor === "codex" && t.state === "succeeded");
    return [
      c("sessão do Claude (cérebro) terminou sem erro", r.status === 0 && brain && brain.is_error === false, (brain?.result ?? r.stderr ?? "").slice(0, 200)),
      c("cérebro delegou pela ponte (task claude→codex succeeded)", ok, tasks.map((t) => `${t.brain}->${t.executor}:${t.state}:${t.outcome?.slice(0, 80)}`)),
      c("mudança feita pelo executor, não pelo cérebro", ok?.verification?.filesChangedActual?.includes("src/math.mjs")),
      c("check passa no repositório", check(repo) === 0),
      c("resposta do cérebro cita o taskId", ok && (brain?.result ?? "").includes(ok.taskId), (brain?.result ?? "").slice(0, 200)),
    ];
  },

  async T12() {
    // Claude cérebro; a evidência favorece o próprio Claude → deve fazer ele mesmo, sem delegar.
    const repo = makeRepo("T12", { init: true });
    seedHistory(repo, [
      ...Array.from({ length: 4 }, () => ({ executor: "claude", ok: true })),
      ...Array.from({ length: 4 }, () => ({ executor: "codex", ok: false, overclaim: true })),
    ]);
    const r = spawnSync("claude", ["-p", `/duo-delegate ${EVIDENCE_PROMPT}`, "--output-format", "json", "--model", CLAUDE_MODEL, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node *)"], {
      cwd: repo, env: cleanEnv(), encoding: "utf8", timeout: 12 * 60_000,
    });
    let brain = null;
    try {
      brain = JSON.parse(r.stdout);
    } catch {
      /* */
    }
    const rec = recommendEvents(repo);
    const realTasks = allTasks(repo).filter((t) => !t.taskId.startsWith("task-seed-"));
    return [
      c("sessão do Claude (cérebro) terminou sem erro", r.status === 0 && brain?.is_error === false, (brain?.result ?? r.stderr ?? "").slice(0, 200)),
      c("cérebro consultou a evidência (duo recommend)", rec.length > 0, rec.map((e) => e.decision?.action)),
      c("recomendação: fazer você mesmo", rec.some((e) => e.decision?.action === "self")),
      c("não delegou (nenhuma task real)", realTasks.length === 0, realTasks.map((t) => `${t.brain}->${t.executor}:${t.state}`)),
      c("tarefa concluída pelo próprio cérebro (check passa)", check(repo) === 0),
      c("resposta explica a decisão", /eu mesmo|evid|histór|recomend/i.test(brain?.result ?? ""), (brain?.result ?? "").slice(0, 200)),
    ];
  },

  async T13() {
    // Codex cérebro; a evidência favorece o Claude → deve delegar ao Claude, não fazer ele mesmo.
    const repo = makeRepo("T13", { init: true });
    seedHistory(repo, [
      ...Array.from({ length: 4 }, () => ({ executor: "claude", ok: true })),
      ...Array.from({ length: 4 }, () => ({ executor: "codex", ok: false, overclaim: true })),
    ]);
    const prompt =
      `$duo-delegate ${EVIDENCE_PROMPT} Leia .agents/skills/duo-delegate/SKILL.md para o procedimento. ` +
      "O comando duo delegate inicia o Claude Code e precisa de rede e login do usuário: solicite aprovação para executá-lo fora do sandbox.";
    const r = spawnSync("codex", ["exec", "--json", "--approve-for-me", "--cd", repo, "-"], { cwd: repo, env: cleanEnv(), encoding: "utf8", input: prompt, timeout: 12 * 60_000 });
    const events = r.stdout.split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    writeFileSync(join(BASE, "T13-brain-events.jsonl"), events.filter((e) => e.item?.type !== "reasoning").map((e) => JSON.stringify(e)).join("\n"));
    const final = [...events].reverse().find((e) => e.type === "item.completed" && e.item?.type === "agent_message")?.item?.text ?? "";
    const rec = recommendEvents(repo);
    const delegated = allTasks(repo).find((t) => !t.taskId.startsWith("task-seed-") && t.brain === "codex" && t.executor === "claude" && t.state === "succeeded");
    return [
      c("sessão do Codex (cérebro) completou o turno", events.some((e) => e.type === "turn.completed"), r.stderr.slice(-300)),
      c("cérebro consultou a evidência (duo recommend)", rec.length > 0, rec.map((e) => `${e.decision?.action}:${e.decision?.executor}`)),
      c("recomendação: delegar ao Claude", rec.some((e) => e.decision?.action === "delegate" && e.decision?.executor === "claude")),
      c(`delegou ao Claude (${CLAUDE_MODEL}) e a ponte verificou`, delegated && delegated.model?.requested === CLAUDE_MODEL, allTasks(repo).filter((t) => !t.taskId.startsWith("task-seed-")).map((t) => `${t.executor}:${t.model?.requested}:${t.state}`)),
      c("mudança feita pelo executor", delegated?.verification?.filesChangedActual?.includes("src/math.mjs")),
      c("check passa", check(repo) === 0),
      c("resposta explica a decisão", /delegar|delegu|claude/i.test(final), final.slice(0, 200)),
    ];
  },

  async A1() {
    // Arte direta: Codex + gpt-6-astra + ferramenta image_generation; a ponte confere a imagem.
    const repo = makeRepo("A1");
    const r = duo(repo, ["delegate", "--request", writeReq(repo, "art", {
      version: 1, brain: "claude", executor: "codex", model: "gpt-6-astra", brainModel: CLAUDE_MODEL, kind: "asset", needs: ["image_generation"],
      objective: "Create a simple flat-style square illustration of a friendly robot mascot and save it as assets/mascot.png.",
      reason: "user_requested", rationale: "Teste E2E real de arte autorizado pelo usuário.", risk: "low",
      scope: { allowedPaths: ["assets/"] },
      acceptance: { criteria: ["assets/mascot.png existe e é uma imagem válida"] },
    })]);
    const imgs = r.json?.images ?? [];
    return [
      c("state succeeded", r.json?.state === "succeeded", `${r.json?.state}: ${r.json?.outcome}`),
      c("modelo gpt-6-astra pedido", r.json?.model?.requested === "gpt-6-astra", r.json?.model),
      c("imagem válida verificada pela ponte em assets/", imgs.length > 0 && imgs.every((i) => i.path.startsWith("assets/")), imgs),
      c("imagem com tamanho plausível (> 1 KB)", imgs.some((i) => i.bytes > 1000), imgs),
      c("nada fora do escopo", (r.json?.outOfScope ?? ["?"]).length === 0),
    ];
  },

  async T14() {
    // Claude cérebro (Opus 5.5) com tarefa mista; o usuário nomeia os modelos: Opus 5.5 no código, GPT-6-Astra na arte.
    const repo = makeRepo("T14", { init: true, files: { "check.mjs": GREET_CHECK } });
    const prompt =
      "/duo-delegate Tarefa com duas partes: (1) criar src/greet.mjs exportando greet(name) que retorna `Olá, ${name}!` (critério: node check.mjs passa); " +
      "(2) criar uma ilustração quadrada estilo flat de um robô simpático acenando, salva em assets/hero.png. " +
      "Use Opus 5.5 (claude-opus-5-5) para o desenvolvimento e GPT-6-Astra (gpt-6-astra) para a arte. Siga a skill (consulte duo models se precisar). " +
      "Ao final responda em uma linha: quem fez cada parte, com qual modelo, e os taskIds.";
    const r = spawnSync("claude", ["-p", prompt, "--output-format", "json", "--model", CLAUDE_MODEL, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node *)"], {
      cwd: repo, env: cleanEnv(), encoding: "utf8", timeout: 14 * 60_000,
    });
    let brain = null;
    try {
      brain = JSON.parse(r.stdout);
    } catch {
      /* */
    }
    const tasks = allTasks(repo);
    const art = tasks.find((t) => t.executor === "codex" && t.kind === "asset" && t.model?.requested === "gpt-6-astra" && t.state === "succeeded");
    const codeByOther = tasks.find((t) => t.kind !== "asset" && t.executor === "codex");
    return [
      c("sessão do cérebro terminou sem erro", r.status === 0 && brain?.is_error === false, (brain?.result ?? r.stderr ?? "").slice(0, 200)),
      c("arte delegada ao codex/gpt-6-astra e verificada", art && (art.verification?.images ?? []).some((i) => i.path === "assets/hero.png"), tasks.map((t) => `${t.executor}/${t.model?.requested}:${t.kind}:${t.state}:${(t.outcome ?? "").slice(0, 80)}`)),
      c("assets/hero.png é imagem válida", imagesIn(repo, "assets").includes("hero.png"), imagesIn(repo, "assets")),
      c("código com Opus 5.5 (o próprio cérebro), não delegado a outro modelo", !codeByOther),
      c("check do código passa", check(repo) === 0),
      c("resposta cita os modelos de cada parte", /opus/i.test(brain?.result ?? "") && /astra/i.test(brain?.result ?? ""), (brain?.result ?? "").slice(0, 240)),
    ];
  },

  async T15() {
    // Codex cérebro, escolha AUTOMÁTICA por parte (sem nomear modelos). Histórico: claude-opus-5-5 vai bem em implement/mjs.
    const repo = makeRepo("T15", { init: true, files: { "check.mjs": GREET_CHECK } });
    seedHistory(repo, [
      ...Array.from({ length: 4 }, () => ({ executor: "claude", ok: true })),
      ...Array.from({ length: 4 }, () => ({ executor: "codex", ok: false, overclaim: true })),
    ]);
    const prompt =
      "$duo-delegate Tarefa com duas partes: (1) criar src/greet.mjs exportando greet(name) que retorna `Olá, ${name}!` (critério: node check.mjs passa); " +
      "(2) criar uma ilustração quadrada estilo flat de um robô simpático acenando, salva em assets/hero.png. " +
      "Não escolha os modelos por conta própria: rode duo models e depois duo recommend separadamente para cada parte (parte 2 com --kind asset --needs image_generation), passando --brain codex e --brain-model com o seu modelo, e siga cada recomendação. " +
      "Leia .agents/skills/duo-delegate/SKILL.md para o procedimento. O comando duo delegate que envolver o Claude precisa de rede e login: solicite aprovação para executá-lo fora do sandbox. " +
      "Ao final responda em uma linha: quem fez cada parte, com qual modelo, e os taskIds.";
    const r = spawnSync("codex", ["exec", "--json", "--approve-for-me", "--cd", repo, "-"], { cwd: repo, env: cleanEnv(), encoding: "utf8", input: prompt, timeout: 14 * 60_000 });
    const events = r.stdout.split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    writeFileSync(join(BASE, "T15-brain-events.jsonl"), events.filter((e) => e.item?.type !== "reasoning").map((e) => JSON.stringify(e)).join("\n"));
    const final = [...events].reverse().find((e) => e.type === "item.completed" && e.item?.type === "agent_message")?.item?.text ?? "";
    const rec = recommendEvents(repo);
    const real = allTasks(repo).filter((t) => !t.taskId.startsWith("task-seed-"));
    const code = real.find((t) => t.kind === "implement" && t.executor === "claude" && t.model?.requested === CLAUDE_MODEL && t.state === "succeeded");
    return [
      c("sessão do Codex completou o turno", events.some((e) => e.type === "turn.completed"), r.stderr.slice(-300)),
      c("recommend consultado para as duas partes", rec.some((e) => e.query?.needs?.includes("image_generation")) && rec.some((e) => e.query?.kind === "implement"), rec.map((e) => `${e.query?.kind}:${e.decision?.action}:${e.decision?.executor}/${e.decision?.model}`)),
      c(`código delegado ao claude/${CLAUDE_MODEL} (evidência) e verificado`, code, real.map((t) => `${t.executor}/${t.model?.requested}:${t.kind}:${t.state}`)),
      c("assets/hero.png é imagem válida (feita por modelo com image_generation)", imagesIn(repo, "assets").includes("hero.png"), imagesIn(repo, "assets")),
      c("nenhuma parte foi para um modelo sem a capacidade", !real.some((t) => t.kind === "asset" && t.executor === "claude")),
      c("check do código passa", check(repo) === 0),
      c("resposta cita os modelos", /opus|claude/i.test(final) && /astra|gpt|codex/i.test(final), final.slice(0, 240)),
    ];
  },

  async T11() {
    const repo = makeRepo("T11", { init: true });
    const prompt =
      "$duo-delegate Delegue ao Claude Code (executor) esta subtarefa: adicionar a função exportada double(n) que retorna n * 2 em src/math.mjs, sem alterar outros arquivos. " +
      'Critério de aceite: o comando node check.mjs deve passar (use acceptance.commands com argv ["node","check.mjs"]). ' +
      "Não implemente você mesmo: escreva o pedido em .duo/requests/ e execute a ponte duo exatamente como a skill .agents/skills/duo-delegate/SKILL.md descreve. " +
      "O comando duo delegate inicia o Claude Code e precisa de rede e do login do usuário: solicite aprovação para executá-lo fora do sandbox. " +
      "Ao final responda em uma linha com o taskId e o state devolvidos pela ponte.";
    const r = spawnSync("codex", ["exec", "--json", "--approve-for-me", "--cd", repo, "-"], {
      cwd: repo, env: cleanEnv(), encoding: "utf8", input: prompt, timeout: 12 * 60_000,
    });
    const events = r.stdout.split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const final = [...events].reverse().find((e) => e.type === "item.completed" && e.item?.type === "agent_message")?.item?.text ?? "";
    const tasks = allTasks(repo);
    const ok = tasks.find((t) => t.brain === "codex" && t.executor === "claude" && t.state === "succeeded");
    writeFileSync(join(BASE, "T11-brain-events.jsonl"), events.filter((e) => e.item?.type !== "reasoning").map((e) => JSON.stringify(e)).join("\n"));
    return [
      c("sessão do Codex (cérebro) completou o turno", events.some((e) => e.type === "turn.completed"), r.stderr.slice(-300)),
      c("cérebro delegou pela ponte (task codex→claude succeeded)", ok, tasks.map((t) => `${t.brain}->${t.executor}:${t.state}:${t.outcome?.slice(0, 120)}`)),
      c("mudança feita pelo executor, não pelo cérebro", ok?.verification?.filesChangedActual?.includes("src/math.mjs")),
      c("check passa no repositório", check(repo) === 0),
      c("resposta do cérebro cita o taskId", ok && final.includes(ok.taskId), final.slice(0, 200)),
    ];
  },
};

/** Histórico sintético (identificado como seed) para testar a escolha por evidência. */
function seedHistory(repo, items) {
  const runId = "run-seed-000001";
  const run = { runId, brain: "claude", policy: "economico", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", cancelled: false, invocations: 0, taskIds: [], decisions: [], nextStep: null };
  items.forEach((it, i) => {
    const taskId = `task-seed-${String(i).padStart(6, "0")}`;
    run.taskIds.push(taskId);
    const dir = join(repo, ".duo", "runs", runId, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task.json"), JSON.stringify({
      taskId, runId, state: it.ok ? "succeeded" : "failed", history: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      brain: it.executor === "claude" ? "codex" : "claude", executor: it.executor, kind: "implement", tags: ["mjs"], risk: "low",
      objective: "seed", reason: "clear_benefit", rationale: "seed", scope: ["src/math.mjs"],
      model: { requested: it.executor === "claude" ? CLAUDE_MODEL : null, reported: null, reportedSource: "unavailable" },
      executorReport: { status: it.ok || it.overclaim ? "completed" : "failed", summary: "seed", filesChanged: [], testsRun: [], limitations: [], blockedReason: null },
      verification: { filesChangedActual: [], outOfScope: [], deniedTouched: [], claimsMismatch: [], staleBase: false, lockIntact: true, partialWork: false, diffPath: null, patchPath: null,
        acceptance: [{ name: "check", argv: ["node", "check.mjs"], ran: true, passed: it.ok, exitCode: it.ok ? 0 : 1, durationMs: 1, outputTail: "" }] },
      metrics: { wallMs: 30000, native: { usage: null, rateLimit: null } }, invocations: 1, outcome: it.ok ? "concluído e verificado" : "critério de aceite falhou (seed)", limitations: ["histórico sintético de teste"],
    }, null, 2));
  });
  writeFileSync(join(repo, ".duo", "runs", runId, "run.json"), JSON.stringify(run, null, 2));
}

function recommendEvents(repo) {
  const p = join(repo, ".duo", "telemetry.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === "recommend");
}

const EVIDENCE_PROMPT =
  "Tarefa: adicionar a função exportada double(n) que retorna n * 2 em src/math.mjs, sem alterar outros arquivos. Critério de aceite: node check.mjs deve passar. " +
  "Decida quem executa exatamente como a skill manda: consulte primeiro a evidência com o comando recommend da ponte duo (--kind implement --paths src/math.mjs --risk low) e siga a recomendação, sem preferência de marca. " +
  "Se a recomendação for delegar, delegue pela ponte com acceptance.commands [[\"node\",\"check.mjs\"]]; se for fazer você mesmo, implemente você e rode node check.mjs. " +
  "Ao final responda em uma linha: DECISÃO=<delegar|eu mesmo> e o motivo.";

/** Imagens válidas (assinatura PNG/JPEG/WebP) sob um diretório do repositório. */
function imagesIn(repo, dir) {
  const abs = join(repo, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => {
    const b = readFileSync(join(abs, f));
    return (b.length > 1000 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(8, 12).toString("latin1") === "WEBP";
  });
}

const GREET_CHECK = `import { greet } from "./src/greet.mjs";
const ok = greet("Ana") === "Olá, Ana!";
console.log(ok ? "check: ok" : "check: FALHOU");
process.exit(ok ? 0 : 1);
`;

async function timeoutResume(id, brain, executor, resumeMarker) {
  const repo = makeRepo(id);
  const r1 = duo(repo, ["delegate", "--request", writeReq(repo, "slow", req({
    brain, executor, kind: "implement",
    objective: "Add exported functions double(n) and triple(n), each with a JSDoc comment, to src/math.mjs. Keep add() unchanged. Then run node check.mjs to verify.",
    scope: { allowedPaths: ["src/math.mjs"] },
    limits: { timeoutSec: 10 },
  }))]);
  const t1 = allTasks(repo)[0];
  await sleep(500);
  const leftovers = processesFor(repo);
  const r2 = t1 ? duo(repo, ["delegate", "--resume", t1.taskId, "--timeout-sec", "420"]) : null;
  const t2 = allTasks(repo)[0];
  const args2 = invocation(t2)?.args ?? [];
  return [
    c("1ª invocação bloqueada por timeout", r1.json?.state === "blocked" && /timeout/.test(r1.json?.outcome ?? ""), `${r1.json?.state}: ${r1.json?.outcome}`),
    c("sessão nativa registrada antes do timeout", Boolean(t1?.native?.sessionId), t1?.native?.sessionId),
    c("sem processo do executor sobrando após o timeout", leftovers.length === 0, leftovers),
    c("retomada succeeded", r2?.json?.state === "succeeded", `${r2?.json?.state}: ${r2?.json?.outcome}`),
    c("retomada usou a sessão nativa", args2.includes(resumeMarker) && args2.includes(t1?.native?.sessionId), args2.filter((a) => a.length < 60).join(" ")),
    c("2 invocações contadas", t2?.invocations === 2, t2?.invocations),
    c("check passa", check(repo) === 0),
  ];
}

// ---------------- execução ----------------
mkdirSync(BASE, { recursive: true });
const results = [];
for (const [id, fn] of Object.entries(scenarios)) {
  if (ONLY && !ONLY.includes(id)) continue;
  const started = Date.now();
  process.stderr.write(`▶ ${id}…\n`);
  let checks;
  try {
    checks = await fn();
  } catch (e) {
    checks = [c("cenário executou sem exceção", false, e.stack ?? String(e))];
  }
  const pass = checks.every((x) => x.ok);
  results.push({ id, pass, seconds: Math.round((Date.now() - started) / 1000), checks });
  process.stderr.write(`${pass ? "✔" : "✖"} ${id} (${Math.round((Date.now() - started) / 1000)}s)\n`);
  for (const x of checks) process.stderr.write(`   ${x.ok ? "ok " : "FALHA"} ${x.name}${x.ok ? "" : ` — ${x.detail}`}\n`);
}
const file = join(BASE, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} cenários aprovados — ${file}`);
process.exit(passed === results.length ? 0 : 1);
