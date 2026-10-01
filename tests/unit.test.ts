import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { capabilitiesFromHelp, CLAUDE_FLAGS, compareVersions } from "../src/adapters/capabilities.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { LineSplitter } from "../src/adapters/process.js";
import { sanitizeEventLine } from "../src/adapters/sanitize.js";
import { classifyErrorText, type InvocationInput } from "../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { isAllowlisted } from "../src/orchestration/acceptance.js";
import { policyBlockReason } from "../src/orchestration/policy.js";
import { childEnv, classifyClaudeStatus, classifyCodexStatus } from "../src/permissions/auth.js";
import { globToRegExp, isDenied, normalizeRel } from "../src/permissions/scope.js";
import { redact } from "../src/redact.js";
import { loadSchema, validate } from "../src/schema.js";
import { canTransition, transition, TransitionError } from "../src/state/machine.js";
import { writeJsonAtomic } from "../src/state/store.js";
import type { DelegationRequest, Run, Task } from "../src/state/types.js";
import { baseRequest } from "./helpers.js";

describe("schema", () => {
  it("aceita pedido válido e rejeita campos extras, enum inválido e tipos errados", () => {
    const s = loadSchema("delegation-request");
    assert.deepEqual(validate(s, baseRequest("claude")), []);
    const bad = validate(s, { ...baseRequest("claude"), kind: "deploy", extra: 1, objective: 5 });
    assert.ok(bad.some((e) => e.includes("$.kind")));
    assert.ok(bad.some((e) => e.includes("$.extra")));
    assert.ok(bad.some((e) => e.includes("$.objective")));
  });
  it("valida o relatório do executor com tipos anuláveis", () => {
    const s = loadSchema("executor-report");
    const ok = { status: "completed", summary: "x", filesChanged: [], testsRun: [{ command: "t", exitCode: null, passed: false }], limitations: [], blockedReason: null };
    assert.deepEqual(validate(s, ok), []);
    assert.ok(validate(s, { ...ok, testsRun: [{ command: "t", exitCode: 1.5, passed: true }] }).length > 0);
  });
});

describe("LineSplitter (JSON fragmentado)", () => {
  it("reconstrói linhas partidas e caracteres multibyte divididos entre chunks", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    const buf = Buffer.from(`${JSON.stringify({ t: "ação 🚀" })}\n${JSON.stringify({ t: 2 })}\n`);
    for (let i = 0; i < buf.length; i += 3) s.push(buf.subarray(i, i + 3));
    s.end();
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ t: "ação 🚀" }, { t: 2 }]);
  });
  it("emite a última linha sem quebra final e descarta linhas acima do limite", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l), 50);
    s.push(`${"x".repeat(120)}\n{"ok":1}\n{"tail":`);
    s.push("true}");
    s.end();
    assert.equal(s.oversizeLines, 1);
    assert.deepEqual(lines, ['{"ok":1}', '{"tail":true}']);
  });
});

describe("escopo", () => {
  it("normaliza caminhos e rejeita traversal/absolutos", () => {
    assert.equal(normalizeRel("./src//a.ts"), "src/a.ts");
    assert.equal(normalizeRel("src/"), "src");
    assert.equal(normalizeRel("../etc/passwd"), null);
    assert.equal(normalizeRel("src/../../x"), null);
    assert.equal(normalizeRel("/etc/passwd"), null);
    assert.equal(normalizeRel("C:\\Windows"), null);
    assert.equal(normalizeRel("~/.ssh"), null);
  });
  it("aplica globs de negação, inclusive diretórios e caixa diferente", () => {
    const deny = DEFAULT_CONFIG.scope.deny;
    assert.ok(isDenied(".env", deny));
    assert.ok(isDenied("config/.ENV.local", deny));
    assert.ok(isDenied(".git/config", deny));
    assert.ok(isDenied(".git", deny));
    assert.ok(isDenied("keys/server.pem", deny));
    assert.equal(isDenied("src/env.ts", deny), null);
    assert.ok(globToRegExp("**/*.key").test("a/b/c.key"));
  });
});

describe("capacidades por --help", () => {
  it("detecta ausência de flag obrigatória e divergência versão × recursos", () => {
    const help = "Options:\n  -p, --print\n  --output-format <f>\n  --verbose\n  --tools <t>\n  --disallowedTools, --disallowed-tools <t>\n  --allowedTools <t>\n  --permission-mode <m>\n";
    const caps = capabilitiesFromHelp(help, "2.1.300", CLAUDE_FLAGS);
    assert.deepEqual(caps.missingRequired, ["--json-schema"]);
    assert.ok(caps.divergences.some((d) => d.includes("--permission-prompts")));
    assert.ok(compareVersions("2.1.114", "2.1.259") < 0);
  });
});

describe("autenticação", () => {
  it("classifica o status oficial do Claude sem guardar e-mail/org", () => {
    const sub = classifyClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "a@b.c", orgId: "x", subscriptionType: "max" }));
    assert.equal(sub.method, "subscription");
    assert.ok(!JSON.stringify(sub).includes("a@b.c"));
    assert.equal(classifyClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" })).method, "api_key");
    assert.equal(classifyClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "vertex" })).method, "cloud");
    assert.equal(classifyClaudeStatus("not json").method, "unknown");
    assert.equal(classifyClaudeStatus(JSON.stringify({ loggedIn: false })).method, "none");
  });
  it("classifica o status oficial do Codex sem repetir o trecho da chave", () => {
    assert.equal(classifyCodexStatus("Logged in using ChatGPT").method, "subscription");
    const api = classifyCodexStatus("Logged in using an API key - sk-proj-***ABCD");
    assert.equal(api.method, "api_key");
    assert.ok(!api.detail.includes("ABCD"));
    assert.equal(classifyCodexStatus("Not logged in").method, "none");
    assert.equal(classifyCodexStatus("???").method, "unknown");
  });
  it("remove do ambiente do executor variáveis de API/gateway e da sessão do cérebro", () => {
    const { env, removed } = childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", OPENAI_BASE_URL: "u", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDECODE: "1", CODEX_HOME: "/h" }, { DUO_DEPTH: "1" });
    assert.deepEqual(Object.keys(env).sort(), ["CODEX_HOME", "DUO_DEPTH", "PATH"]);
    assert.deepEqual(removed, ["ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_MESSAGING_TOKEN", "OPENAI_BASE_URL"]);
  });
});

describe("redação de segredos", () => {
  it("remove chaves, bearer tokens e pares chave=valor", () => {
    const out = redact('sk-ant-api03-abcdefghijklmnop Bearer abcdefghijklmnopqrstu {"api_key":"supersecretvalue"} ghp_abcdefghijklmnopqrstuvwxyz');
    assert.ok(!out.includes("abcdefghijklmnop"));
    assert.ok(!out.includes("supersecretvalue"));
    assert.ok(out.includes("<redacted>"));
    assert.doesNotThrow(() => JSON.parse(redact(JSON.stringify({ text: 'password=abc\\"def123' }))));
  });
  it("não persiste raciocínio interno de nenhum dos clientes", () => {
    const c = sanitizeEventLine("codex", JSON.stringify({ type: "item.completed", item: { id: "1", type: "reasoning", text: "pensamento privado" } }));
    assert.ok(!c.includes("pensamento privado"));
    const a = sanitizeEventLine("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "pensamento privado" }] } }));
    assert.ok(!a.includes("pensamento privado"));
  });
});

describe("máquina de estados", () => {
  it("aceita só transições válidas", () => {
    const task = { taskId: "task-x", state: "planned", history: [], outcome: null } as unknown as Task;
    transition(task, "approved", "ok");
    transition(task, "running", "ok");
    transition(task, "blocked", "timeout");
    transition(task, "approved", "retomada");
    assert.throws(() => transition(task, "succeeded", "pulo"), TransitionError);
    assert.equal(canTransition("succeeded", "running"), false);
    assert.equal(canTransition("cancelled", "approved"), false);
    assert.equal(task.history.length, 4);
  });
  it("escreve JSON de forma atômica", () => {
    const dir = mkdtempSync(join(tmpdir(), "duo-atomic-"));
    try {
      writeJsonAtomic(join(dir, "a", "b.json"), { x: 1 });
      writeJsonAtomic(join(dir, "a", "b.json"), { x: 2 });
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "a", "b.json"), "utf8")), { x: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("política", () => {
  const run = (over: Partial<Run> = {}): Run => ({ runId: "run-test01", brain: "claude", policy: "economico", createdAt: "", updatedAt: "", cancelled: false, invocations: 0, taskIds: [], decisions: [], nextStep: null, ...over });
  const req = (over: Record<string, unknown> = {}) => baseRequest("claude", over) as unknown as DelegationRequest;
  it("limita invocações por run e respeita a política econômica", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    assert.equal(policyBlockReason(req(), cfg, run()), null);
    assert.match(policyBlockReason(req(), cfg, run({ invocations: 2 })) ?? "", /limite de 2/);
    assert.match(policyBlockReason(req({ reason: "second_opinion", kind: "review" }), cfg, run()) ?? "", /economico/);
    cfg.policy = "qualidade";
    cfg.limits.qualityBudgetAuthorized = true;
    assert.equal(policyBlockReason(req({ reason: "cross_review", kind: "review" }), cfg, run({ invocations: 3 })), null);
  });
  it("mantém o cérebro fixo no run e preserva a cota escolhida", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    assert.match(policyBlockReason(req(), cfg, run({ brain: "codex" })) ?? "", /cérebro/);
    cfg.quotaPreference = "preserve-codex";
    assert.match(policyBlockReason(req(), cfg, run()) ?? "", /preserve-codex/);
    assert.equal(policyBlockReason(req({ reason: "user_requested" }), cfg, run()), null);
  });
  it("allowlist de aceite por prefixo exato de argv", () => {
    assert.ok(isAllowlisted(["npm", "test", "--", "-u"], [["npm", "test"]]));
    assert.ok(!isAllowlisted(["npm", "run", "deploy"], [["npm", "test"]]));
    assert.ok(!isAllowlisted(["npm"], [["npm", "test"]]));
  });
});

describe("adaptadores (argumentos, sem executar)", () => {
  const input = (kind: InvocationInput["kind"]): InvocationInput => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "duo-art-"));
    return ({
    resolved: { ok: true, command: "/bin/x", prefixArgs: [], source: "path" },
    caps: { version: "1.0.0", flags: Object.fromEntries(["settingSources", "strictMcpConfig", "disableSlashCommands", "appendSystemPrompt", "resume", "model", "outputLastMessage", "config"].map((k) => [k, true])), missingRequired: [], divergences: [] },
    cfg: structuredClone(DEFAULT_CONFIG),
    cwd: "/proj",
    kind,
    prompt: "p",
    writableAbs: kind === "implement" ? [{ abs: "/proj/src", isDir: true }] : [],
    denyGlobs: [".env"],
    acceptanceArgv: [["npm", "test"]],
    needs: [],
    model: null,
    resumeSessionId: null,
    artifactsDir,
    env: { HOME: artifactsDir, CODEX_HOME: join(artifactsDir, ".codex") },
  });
  };
  it("Claude: leitura sem Edit/Bash; escrita limitada ao escopo; recursão negada; prompt por stdin", () => {
    const review = new ClaudeAdapter().plan(input("review"));
    assert.equal(review.args[review.args.indexOf("--tools") + 1], "Read,Grep,Glob");
    assert.ok(!review.args.includes("--allowedTools"));
    assert.ok(review.args.includes("Bash(codex *)") && review.args.includes("Bash(duo *)"));
    assert.ok(review.args.includes("--disable-slash-commands") && review.args.includes("--strict-mcp-config"));
    assert.ok(!review.args.includes("--bare"));
    assert.ok(!review.args.includes("--dangerously-skip-permissions"));
    assert.equal(review.stdin, "p");
    assert.ok(!review.args.includes("--permission-prompts"));
    const withPrompts = new ClaudeAdapter().plan({ ...input("review"), caps: { ...input("review").caps, flags: { ...input("review").caps.flags, permissionPrompts: true } } });
    assert.equal(withPrompts.args[withPrompts.args.indexOf("--permission-prompts") + 1], "none");
    const impl = new ClaudeAdapter().plan(input("implement"));
    assert.ok(impl.args.includes("Edit(//proj/src/**)"));
    assert.ok(impl.args.includes("Bash(npm test)") && impl.args.includes("Bash(npm test *)"));
    assert.ok(impl.args.includes("Read(//proj/.env)"));
  });
  it("Codex: sandbox read-only em revisão, workspace-write sem rede em implementação, prompt por stdin", () => {
    const review = new CodexAdapter().plan(input("review"));
    assert.equal(review.args[review.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(review.args.at(-1), "-");
    const impl = new CodexAdapter().plan(input("implement"));
    assert.equal(impl.args[impl.args.indexOf("--sandbox") + 1], "workspace-write");
    assert.ok(impl.args.includes("sandbox_workspace_write.network_access=false"));
    assert.ok(!impl.args.includes("danger-full-access"));
    // formato real de `codex exec resume` 0.157.1: sem --sandbox/--cd; sandbox via -c depois do subcomando
    const resumed = new CodexAdapter().plan({ ...input("implement"), resumeSessionId: "abc" });
    assert.deepEqual(resumed.args.slice(0, 3), ["exec", "resume", "--json"]);
    assert.ok(resumed.args.includes('sandbox_mode="workspace-write"'));
    assert.ok(!resumed.args.includes("--sandbox") && !resumed.args.includes("--cd"));
    assert.deepEqual(resumed.args.slice(-2), ["abc", "-"]);
  });
  it("classifica textos de erro de cota, autenticação e modelo", () => {
    assert.equal(classifyErrorText("You've hit your usage limit. Try again at 3:05 PM."), "quota");
    assert.equal(classifyErrorText("Login expired · Please run /login"), "auth");
    assert.equal(classifyErrorText("Selected model is at capacity. Please try a different model."), "capacity");
    assert.equal(classifyErrorText('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), "capacity");
    assert.equal(classifyErrorText("You've hit your usage limit. Try again at 3:05 PM."), "quota", "cota continua sendo cota");
    assert.equal(classifyErrorText("The 'gpt-x' model is not supported when using Codex"), "model_unavailable");
  });
});

describe("comparação de modelos", () => {
  it("alias casa por família; ID completo exige o mesmo modelo", async () => {
    const { modelMatches } = await import("../src/orchestration/delegate.js");
    assert.ok(modelMatches("opus", "claude-opus-5-5"));
    assert.ok(modelMatches("claude-opus-5-5", "claude-opus-5-5"));
    assert.ok(!modelMatches("claude-opus-5-5", "claude-opus-5-5[1m]"), "variante [1m] tem cobrança própria: não é o mesmo modelo");
    assert.ok(modelMatches("claude-haiku-4-5", "claude-haiku-4-5-20251001"), "sufixo de data é o mesmo modelo");
    assert.ok(!modelMatches("claude-opus-5-5", "claude-opus-4-7"));
    assert.ok(!modelMatches("sonnet", "claude-opus-4-7"));
  });
});

describe("redação não corrompe identificadores", () => {
  it("IDs de task/run e caminhos permanecem intactos", () => {
    const id = "task-20260926134653-cc6bdb";
    assert.equal(redact(`/repo/.duo/runs/run-20260926134653-e6722d/tasks/${id}/task.json`), `/repo/.duo/runs/run-20260926134653-e6722d/tasks/${id}/task.json`);
    assert.equal(redact("sk-proj-abcdefghijklmnopqrstuv"), "<redacted>");
  });
});

describe("exemplos da documentação", () => {
  it("os pedidos em examples/ passam no schema", async () => {
    const { readdirSync } = await import("node:fs");
    const { packageRoot } = await import("../src/paths.js");
    const dir = join(packageRoot(), "examples");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 2);
    for (const f of files) assert.deepEqual(validate(loadSchema("delegation-request"), JSON.parse(readFileSync(join(dir, f), "utf8"))), [], f);
  });
});

describe("duo init: comando gravado nas skills", () => {
  it("usa `duo` quando o PATH aponta para esta instalação; senão, o caminho absoluto", async () => {
    const { symlinkSync } = await import("node:fs");
    const { duoCliCommand } = await import("../src/cli/init.js");
    const { cliEntry } = await import("../src/paths.js");
    const bin = mkdtempSync(join(tmpdir(), "duo-bin-"));
    try {
      assert.equal(duoCliCommand({ PATH: bin }), `node "${cliEntry()}"`);
      symlinkSync(cliEntry(), join(bin, "duo"));
      assert.equal(duoCliCommand({ PATH: bin }), "duo");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
