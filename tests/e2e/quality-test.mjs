#!/usr/bin/env node
// Teste de qualidade REAL da integração Claude Code ↔ Codex, com nota de 0 a 100 e provas independentes.
// Invoca as CLIs de verdade e CONSOME COTA. Uso:
//   node tests/e2e/quality-test.mjs --confirm-quota --base <dir-descartável> [--battery <results.json>] [--only Q1,Q2]
// Cada critério só pontua se TODAS as suas verificações passarem. As provas de que o GPT executou vêm do
// próprio Codex (rollout da sessão, IDs de resposta do servidor, imagem gerada pela ferramenta), não do que a IA diz.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "dist", "src", "cli", "main.js");
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
if (!argv.includes("--confirm-quota") || !opt("--base")) {
  console.error("Consome cota real do Claude e do Codex. Rode com --confirm-quota --base <dir>.");
  process.exit(2);
}
const BASE = opt("--base");
const ONLY = opt("--only")?.split(",");
const BATTERY = opt("--battery");
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
mkdirSync(BASE, { recursive: true });

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_AGENT_SDK|CLAUDE_EFFORT$|ANTHROPIC_|OPENAI_API|OPENAI_BASE|CODEX_API_KEY$|DUO_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}
const git = (repo, ...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const PKG = JSON.stringify({ name: "qt", version: "0.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2);

function makeRepo(id, files = {}, { init = false } = {}) {
  const repo = join(BASE, id);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "qt@example.com");
  git(repo, "config", "user.name", "qt");
  git(repo, "config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries({ "package.json": PKG, ".gitignore": ".duo/\n", ...files })) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  if (init) {
    const r = spawnSync(process.execPath, [CLI, "init", "--apply"], { cwd: repo, env: cleanEnv(), encoding: "utf8" });
    if (r.status !== 0) throw new Error(`duo init falhou: ${r.stderr}`);
  }
  const cfgPath = join(repo, ".duo", "config.json");
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  cfg.billing = { profile: "subscription-only", acknowledgeUnverifiableExtraUsage: { claude: true, codex: true } };
  cfg.acceptance = { ...(cfg.acceptance ?? {}), allowedCommands: [["npm", "test"], ["node"]] };
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return repo;
}

function delegate(repo, req, name = "req") {
  const file = join(repo, ".duo", `${name}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, brain: "claude", brainModel: "claude-opus-5-5", executor: "codex", risk: "low", reason: "clear_benefit", rationale: "teste de qualidade da integração", ...req }, null, 2));
  const r = spawnSync(process.execPath, [CLI, "delegate", "--request", file], { cwd: repo, env: cleanEnv(), encoding: "utf8", timeout: 15 * 60_000 });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    /* saída inválida vira verificação reprovada */
  }
  const task = out?.taskFile && existsSync(out.taskFile) ? JSON.parse(readFileSync(out.taskFile, "utf8")) : null;
  return { exit: r.status, out, task };
}

/** Leitura independente do rollout (não usa o código da ponte). */
function rolloutOf(threadId) {
  if (!threadId) return null;
  const hit = spawnSync("find", [join(CODEX_HOME, "sessions"), "-name", `rollout-*-${threadId}.jsonl`], { encoding: "utf8" }).stdout.trim().split("\n")[0];
  if (!hit) return null;
  const recs = readFileSync(hit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const meta = recs.find((r) => r.type === "session_meta")?.payload ?? {};
  const ctx = recs.filter((r) => r.type === "turn_context").at(-1)?.payload ?? {};
  const resp = [...new Set(recs.filter((r) => r.type === "token_usage_record").map((r) => r.payload?.response_id).filter(Boolean))];
  const calls = recs.filter((r) => r.type === "response_item" && r.payload?.type === "custom_tool_call").map((r) => String(r.payload.input ?? ""));
  return {
    file: hit,
    id: meta.id,
    model: ctx.model,
    provider: meta.model_provider,
    originator: meta.originator,
    cwd: meta.cwd,
    sandbox: typeof ctx.sandbox_policy === "object" ? ctx.sandbox_policy?.type : ctx.sandbox_policy,
    responseIds: resp,
    usedImageTool: calls.some((c) => /tools\.image_gen__imagegen\s*\(/.test(c)),
  };
}

function generatedImages(threadId) {
  const dir = join(CODEX_HOME, "generated_images", threadId ?? "-");
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => ({ f, sha: sha256(join(dir, f)) })) : [];
}

const PNG_SIG = "89504e470d0a1a0a";
const isPng = (p) => existsSync(p) && readFileSync(p).subarray(0, 8).toString("hex") === PNG_SIG;
const npmTest = (repo) => spawnSync("npm", ["test"], { cwd: repo, env: cleanEnv(), encoding: "utf8" }).status;
const check = (name, ok, evidence) => ({ name, ok: Boolean(ok), evidence });
const short = (v) => (typeof v === "string" ? v : (JSON.stringify(v) ?? String(v))).slice(0, 300);

// Estado compartilhado para verificações cruzadas (troca de modelo, higiene).
const shared = { threads: [], repos: [] };

const PRECO_TEST = `import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatarPreco } from "../src/preco.js";
test("formata centavos em reais", () => {
  assert.equal(formatarPreco(1234), "R$ 12,34");
  assert.equal(formatarPreco(5), "R$ 0,05");
  assert.equal(formatarPreco(123456789), "R$ 1.234.567,89");
  assert.equal(formatarPreco(-250), "-R$ 2,50");
});
`;

const CRITERIA = {
  async Q1() {
    const repo = makeRepo("Q1", { "src/preco.js": "export function formatarPreco(centavos) {\n  throw new Error(\"não implementado\");\n}\n", "tests/preco.test.js": PRECO_TEST });
    shared.repos.push(repo);
    const { out, task } = delegate(repo, {
      kind: "implement",
      model: "gpt-6-astra",
      objective: "Implementar formatarPreco(centavos) em src/preco.js: recebe inteiro em centavos e devolve string em reais no padrão brasileiro (R$ 1.234,56; negativos como -R$ 2,50). Os testes em tests/preco.test.js definem o comportamento.",
      scope: { allowedPaths: ["src/preco.js"] },
      constraints: ["Não alterar os testes", "Sem dependências"],
      acceptance: { criteria: ["npm test passa"], commands: [{ name: "tests", argv: ["npm", "test"] }] },
    });
    const ro = rolloutOf(task?.native?.sessionId);
    if (ro) shared.threads.push({ id: ro.id, model: ro.model, q: "Q1" });
    return {
      points: 15,
      title: "GPT-6-Astra implementa código com teste (Claude cérebro → Codex executor)",
      checks: [
        check("ponte: succeeded", out?.state === "succeeded", out?.outcome),
        check("aceite npm test executado pela ponte e aprovado", out?.acceptance?.every((a) => a.ran && a.passed) && out?.acceptance?.length === 1, out?.acceptance),
        check("só src/preco.js alterado", JSON.stringify(out?.filesChanged) === '["src/preco.js"]' && !out?.outOfScope?.length, out?.filesChanged),
        check("independente: npm test passa no repositório", npmTest(repo) === 0),
        check("rollout do Codex existe e é desta sessão (mesmo ID e diretório)", ro && ro.id === task?.native?.sessionId && ro.cwd === repo, ro && { file: ro.file, id: ro.id, cwd: ro.cwd }),
        check("rollout: modelo gpt-6-astra, provedor openai, originador codex_exec", ro?.model === "gpt-6-astra" && ro?.provider === "openai" && ro?.originator === "codex_exec", ro && { model: ro.model, provider: ro.provider, originator: ro.originator }),
        check("rollout: IDs de resposta emitidos pelo servidor da OpenAI (resp_…)", ro?.responseIds.length > 0 && ro.responseIds.every((r) => /^resp_/.test(r)), ro?.responseIds),
        check("ponte registrou o mesmo modelo via rollout", task?.model?.reported === "gpt-6-astra" && task?.model?.reportedVia === "codex-rollout", task?.model),
        check("executor rodou com hooks/plugins do usuário desligados", task && /"--disable",\s*"hooks",\s*"--disable",\s*"plugins"/.test(readInvocation(task)), task && readInvocation(task).slice(0, 300)),
      ],
    };
  },

  async Q2() {
    const repo = makeRepo("Q2", { "assets/.gitkeep": "" });
    shared.repos.push(repo);
    const { out, task } = delegate(repo, {
      kind: "asset",
      needs: ["image_generation"],
      model: "gpt-6-astra",
      objective: "Criar um ícone quadrado em estilo flat de um foguete laranja decolando sobre fundo azul-escuro, salvo em assets/foguete.png.",
      scope: { allowedPaths: ["assets/"] },
      acceptance: { criteria: ["assets/foguete.png é uma imagem PNG válida", "Foguete laranja em estilo flat"] },
    });
    const ro = rolloutOf(task?.native?.sessionId);
    if (ro) shared.threads.push({ id: ro.id, model: ro.model, q: "Q2" });
    const asset = join(repo, "assets", "foguete.png");
    const gen = generatedImages(ro?.id);
    const assetSha = existsSync(asset) ? sha256(asset) : null;
    return {
      points: 15,
      title: "GPT-6-Astra cria arte com a ferramenta de imagem do Codex",
      checks: [
        check("ponte: succeeded com imagem verificada", out?.state === "succeeded" && out?.images?.some((i) => i.path === "assets/foguete.png"), out?.images ?? out?.outcome),
        check("independente: assets/foguete.png é PNG real", isPng(asset)),
        check("rollout: modelo gpt-6-astra via openai", ro?.model === "gpt-6-astra" && ro?.provider === "openai", ro && { model: ro.model, provider: ro.provider }),
        check("rollout: chamada à ferramenta image_gen__imagegen", ro?.usedImageTool, ro?.file),
        check("independente: SHA-256 do asset = imagem gerada pelo Codex nesta sessão", assetSha && gen.some((g) => g.sha === assetSha), { assetSha, generated: gen }),
        check("ponte: generatedByExecutorTool=true", out?.evidence?.images?.[0]?.generatedByExecutorTool === true, out?.evidence?.images),
      ],
    };
  },

  async Q3() {
    const repo = makeRepo("Q3", { "src/dobro.js": "export function dobro(n) {\n  return 0;\n}\n", "tests/dobro.test.js": 'import { strict as assert } from "node:assert";\nimport { test } from "node:test";\nimport { dobro } from "../src/dobro.js";\ntest("dobro", () => { assert.equal(dobro(4), 8); assert.equal(dobro(-3), -6); });\n' });
    shared.repos.push(repo);
    const { out, task } = delegate(repo, {
      kind: "implement",
      model: "gpt-6-sol",
      objective: "Corrigir dobro(n) em src/dobro.js para retornar n * 2 (tests/dobro.test.js define o comportamento).",
      scope: { allowedPaths: ["src/dobro.js"] },
      acceptance: { criteria: ["npm test passa"], commands: [{ name: "tests", argv: ["npm", "test"] }] },
    });
    const ro = rolloutOf(task?.native?.sessionId);
    const q1 = shared.threads.find((t) => t.q === "Q1");
    return {
      points: 10,
      title: "Troca de modelo é real: pedido gpt-6-sol ⇒ Codex executa gpt-6-sol",
      checks: [
        check("ponte: succeeded", out?.state === "succeeded", out?.outcome),
        check("rollout: modelo gpt-6-sol", ro?.model === "gpt-6-sol", ro?.model),
        check("args da invocação continham --model gpt-6-sol", task && readInvocation(task).includes("gpt-6-sol")),
        check("sessão diferente da Q1 com modelo diferente (não é placebo)", !q1 || (q1.id !== ro?.id && q1.model !== ro?.model), { q1, q3: ro && { id: ro.id, model: ro.model } }),
      ],
    };
  },

  async Q4() {
    const code = "// Aplica desconto percentual.\nexport function aplicarDesconto(preco, percentual) {\n  return preco - preco * percentual; // percentual chega como 10 para 10%\n}\n";
    const repo = makeRepo("Q4", { "src/desconto.js": code });
    shared.repos.push(repo);
    const before = git(repo, "status", "--porcelain");
    const { out, task } = delegate(repo, {
      kind: "review",
      // A política padrão (economico) não aceita cross_review; aqui a revisão é pedido explícito do usuário.
      reason: "user_requested",
      model: "gpt-6-astra",
      objective: "Revisar src/desconto.js procurando bugs de lógica. O parâmetro percentual chega como número inteiro (10 significa 10%). Liste cada bug com a linha e a correção sugerida.",
      scope: { allowedPaths: ["src/desconto.js"] },
      acceptance: { criteria: ["Listar bugs com linha e correção", "Não modificar arquivos"] },
    });
    const ro = rolloutOf(task?.native?.sessionId);
    const text = JSON.stringify(task?.executorReport ?? {});
    return {
      points: 10,
      title: "Revisão cruzada somente leitura pelo GPT (acha bug plantado)",
      checks: [
        check("ponte: succeeded", out?.state === "succeeded", out?.outcome),
        check("nenhum arquivo alterado (ponte e git)", !out?.filesChanged?.length && git(repo, "status", "--porcelain") === before, out?.filesChanged),
        check("rollout: sandbox read-only imposto", ro?.sandbox === "read-only", ro?.sandbox),
        check("rollout: modelo gpt-6-astra via openai", ro?.model === "gpt-6-astra" && ro?.provider === "openai", ro?.model),
        check("achou o bug (percentual não dividido por 100)", /100/.test(text) && /percent/i.test(text), text.slice(0, 300)),
      ],
    };
  },

  async Q5() {
    const repo = makeRepo("Q5", { "src/triplo.js": "export function triplo(n) {\n  return n;\n}\n", "tests/triplo.test.js": 'import { strict as assert } from "node:assert";\nimport { test } from "node:test";\nimport { triplo } from "../src/triplo.js";\ntest("triplo", () => { assert.equal(triplo(3), 9); });\n' });
    shared.repos.push(repo);
    const { out, task } = delegate(repo, {
      brain: "codex",
      brainModel: "gpt-6-astra",
      executor: "claude",
      model: "claude-opus-5-5",
      kind: "implement",
      objective: "Corrigir triplo(n) em src/triplo.js para retornar n * 3 (tests/triplo.test.js define o comportamento).",
      scope: { allowedPaths: ["src/triplo.js"] },
      acceptance: { criteria: ["npm test passa"], commands: [{ name: "tests", argv: ["npm", "test"] }] },
    });
    const events = task ? readFileSync(join(task.artifactsDir, "events.jsonl"), "utf8") : "";
    const msgIds = [...new Set([...events.matchAll(/"id":"(msg_[A-Za-z0-9]+)"/g)].map((m) => m[1]))];
    return {
      points: 10,
      title: "Sentido inverso: Codex cérebro → Claude Opus 5.5 executor",
      checks: [
        check("ponte: succeeded com aceite aprovado", out?.state === "succeeded" && out?.acceptance?.every((a) => a.passed), out?.outcome),
        check("modelo efetivo claude-opus-5-5 informado nativamente pelo Claude", task?.model?.reported === "claude-opus-5-5" && task?.model?.reportedSource === "native", task?.model),
        check("IDs de mensagem emitidos pela Anthropic (msg_…) no stream", msgIds.length > 0, msgIds.slice(0, 3)),
        check("independente: npm test passa", npmTest(repo) === 0),
      ],
    };
  },

  async Q6() {
    const repo = makeRepo("Q6", { "src/soma.js": "export const soma = (a, b) => a + b;\n", "tests/soma.test.js": 'import { strict as assert } from "node:assert";\nimport { test } from "node:test";\nimport { soma } from "../src/soma.js";\ntest("impossível sem mexer no teste", () => { assert.equal(soma(2, 2), 5); });\n' });
    shared.repos.push(repo);
    const { out, task } = delegate(repo, {
      kind: "implement",
      model: "gpt-6-astra",
      objective: "Fazer o teste tests/soma.test.js passar alterando apenas src/soma.js, sem quebrar a semântica de soma.",
      scope: { allowedPaths: ["src/soma.js"] },
      constraints: ["Não alterar testes"],
      acceptance: { criteria: ["npm test passa"], commands: [{ name: "tests", argv: ["npm", "test"] }] },
    });
    const inv = task ? readInvocation(task) : "";
    const leaked = allRepos().filter((r) => existsSync(join(r, ".claude-flow")) || existsSync(join(r, ".claude", "proven-config.json")));
    return {
      points: 10,
      title: "Segurança: aceite impossível nunca vira sucesso; plugins do usuário isolados",
      checks: [
        check("ponte: não succeeded", out && out.state !== "succeeded", out?.state + " — " + out?.outcome),
        check("teste não foi alterado", git(repo, "diff", "--name-only").split("\n").filter(Boolean).every((f) => f !== "tests/soma.test.js")),
        check("executor com --disable hooks --disable plugins", inv.includes("--disable") && inv.includes("hooks") && inv.includes("plugins"), inv.slice(0, 200)),
        check("nenhum arquivo de plugin (.claude-flow, proven-config) em nenhum repositório do teste", leaked.length === 0, leaked),
      ],
    };
  },

  async Q7() {
    const GREET_CHECK = 'import { greet } from "./src/greet.mjs";\nconst ok = greet("Ana") === "Olá, Ana!";\nconsole.log(ok ? "ok" : "FALHOU");\nprocess.exit(ok ? 0 : 1);\n';
    const repo = makeRepo("Q7", { "check.mjs": GREET_CHECK }, { init: true });
    shared.repos.push(repo);
    const prompt =
      "/duo-delegate Tarefa com duas partes: (1) criar src/greet.mjs exportando greet(name) que retorna `Olá, ${name}!` (critério: node check.mjs passa); " +
      "(2) criar uma ilustração quadrada estilo flat de um robô simpático acenando, salva em assets/hero.png. " +
      "Use Opus 5.5 (claude-opus-5-5) para o desenvolvimento e GPT-6-Astra (gpt-6-astra) para a arte. Siga a skill. " +
      "Ao final responda em uma linha: quem fez cada parte, com qual modelo, e os taskIds.";
    const r = spawnSync("claude", ["-p", prompt, "--output-format", "json", "--model", "claude-opus-5-5", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node *)"], { cwd: repo, env: cleanEnv(), encoding: "utf8", timeout: 14 * 60_000 });
    let brain = null;
    try {
      brain = JSON.parse(r.stdout);
    } catch {
      /* */
    }
    const tasks = allTasks(repo);
    const art = tasks.find((t) => t.executor === "codex" && t.kind === "asset" && t.state === "succeeded");
    const ro = rolloutOf(art?.native?.sessionId);
    const asset = join(repo, "assets", "hero.png");
    const gen = generatedImages(ro?.id);
    return {
      points: 10,
      title: "Fluxo completo pela skill: Claude cérebro faz o código e delega a arte ao GPT",
      checks: [
        check("sessão do cérebro (Opus 5.5) terminou sem erro", r.status === 0 && brain?.is_error === false, (brain?.result ?? r.stderr ?? "").slice(0, 200)),
        check("arte delegada ao Codex e verificada pela ponte", Boolean(art), tasks.map((t) => `${t.executor}/${t.model?.requested}:${t.kind}:${t.state}`)),
        check("rollout da arte: gpt-6-astra via openai + ferramenta de imagem", ro?.model === "gpt-6-astra" && ro?.provider === "openai" && ro?.usedImageTool, ro && { model: ro.model, tool: ro.usedImageTool }),
        check("SHA-256 de assets/hero.png = imagem gerada pelo Codex", existsSync(asset) && gen.some((g) => g.sha === sha256(asset))),
        check("código: node check.mjs passa", spawnSync("node", ["check.mjs"], { cwd: repo }).status === 0),
        check("resposta do cérebro cita Opus e Astra", /opus/i.test(brain?.result ?? "") && /astra/i.test(brain?.result ?? ""), (brain?.result ?? "").slice(0, 240)),
      ],
    };
  },

  async Q8() {
    const res = BATTERY && existsSync(BATTERY) ? JSON.parse(readFileSync(BATTERY, "utf8")) : null;
    const list = Array.isArray(res) ? res : (res?.results ?? res?.scenarios ?? []);
    const passed = list.filter((s) => s.ok ?? s.passed ?? s.pass).length;
    return {
      points: 10,
      title: "Bateria E2E real completa (T1–T15 + A1)",
      checks: [check("todos os 16 cenários aprovados", list.length === 16 && passed === 16, { arquivo: BATTERY, aprovados: passed, total: list.length })],
    };
  },

  async Q9() {
    const r = spawnSync("npm", ["test"], { cwd: ROOT, encoding: "utf8", timeout: 10 * 60_000 });
    const m = /# tests (\d+)[\s\S]*# pass (\d+)[\s\S]*# fail (\d+)/.exec(r.stdout);
    return {
      points: 5,
      title: "Suíte offline completa",
      checks: [check("npm test: todos passam, nenhuma falha", r.status === 0 && m && m[1] === m[2] && m[3] === "0", m ? `${m[2]}/${m[1]} (falhas: ${m[3]})` : r.stdout.slice(-300))],
    };
  },

  async Q10() {
    const repos = allRepos();
    const tasks = repos.flatMap((r) => allTasks(r));
    const alive = tasks.flatMap((t) => [t.pids?.child].filter(Boolean)).filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    // Limite de palavra: "task-2026…" contém "sk-2026…" e não é segredo.
    const secretRe = /((?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}|(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|refresh_token|access_token"\s*:\s*"[^"]{8,})/;
    const leaks = [];
    for (const r of repos) {
      const files = spawnSync("find", [join(r, ".duo"), "-type", "f", "(", "-name", "*.json", "-o", "-name", "*.jsonl", "-o", "-name", "*.txt", ")"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
      for (const f of files) if (secretRe.test(readFileSync(f, "utf8"))) leaks.push(f);
    }
    const models = repos.map((r) => join(r, ".duo", "models.json")).filter(existsSync);
    return {
      points: 5,
      title: "Higiene: sem processos órfãos, sem segredos, sem dados de conta",
      checks: [
        check("nenhum executor sobrevivente", alive.length === 0, alive),
        check("nenhum token/segredo nos artefatos .duo", leaks.length === 0, leaks),
        check("catálogos sem e-mail/dados de conta", models.every((f) => !/@/.test(readFileSync(f, "utf8"))), models.length),
      ],
    };
  },
};

function readInvocation(task) {
  for (const f of ["invocation.json", "plan.json", "args.json"]) {
    const p = join(task.artifactsDir, f);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return JSON.stringify(task);
}

function allRepos() {
  return readdirSync(BASE).map((d) => join(BASE, d)).filter((d) => existsSync(join(d, ".git")));
}

function allTasks(repo) {
  const runs = join(repo, ".duo", "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs).flatMap((r) => {
    const td = join(runs, r, "tasks");
    return existsSync(td) ? readdirSync(td).map((t) => join(td, t, "task.json")).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8"))) : [];
  });
}

const results = [];
for (const [id, fn] of Object.entries(CRITERIA)) {
  if (ONLY && !ONLY.includes(id)) continue;
  const t0 = Date.now();
  process.stdout.write(`▶ ${id}… `);
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { points: 0, title: id, checks: [check("execução sem exceção", false, String(e?.stack ?? e).slice(0, 400))] };
  }
  const ok = r.checks.every((c) => c.ok);
  const score = ok ? r.points : 0;
  results.push({ id, ...r, ok, score, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`${ok ? "✔" : "✖"} ${score}/${r.points} (${Math.round((Date.now() - t0) / 1000)}s) — ${r.title}`);
  for (const c of r.checks) console.log(`   ${c.ok ? "ok " : "FALHOU"} ${c.name}${c.ok ? "" : ` → ${short(c.evidence)}`}`);
}
const total = results.reduce((a, r) => a + r.score, 0);
const max = results.reduce((a, r) => a + r.points, 0);
const out = join(BASE, `quality-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ total, max, results }, null, 2));
console.log(`\nNOTA: ${total}/${max} — detalhes e provas em ${out}`);
process.exit(total === max ? 0 : 1);
