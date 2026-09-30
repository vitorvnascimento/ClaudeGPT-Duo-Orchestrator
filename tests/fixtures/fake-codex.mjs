#!/usr/bin/env node
// Codex CLI simulado: imita `--version`, `exec --help`, `login status`, `exec --json` (JSONL), `app-server` (JSON-RPC) e `debug models`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyWrites, emit, emitPrivateKey, log, readStdin, removeLock, report, scenario, sensitiveEnvSeen, sleep, spawnGrandchild, tryRecursiveDelegate, writeFragmented,
} from "./fake-common.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);

const FLAGS = [
  "--json", "-s, --sandbox <SANDBOX_MODE>", "--output-schema <FILE>", "-o, --output-last-message <FILE>", "-C, --cd <DIR>",
  "-m, --model <MODEL>", "-c, --config <key=value>", "--enable <FEATURE>", "--disable <FEATURE>", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
];

if (has("--version")) {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? process.env.FAKE_VERSION ?? "0.155.0"}\n`);
  process.exit(0);
}
if (args[0] === "exec" && has("--help")) {
  let flags = FLAGS;
  const help = process.env.FAKE_CODEX_HELP ?? process.env.FAKE_HELP;
  if (help === "missing-schema") flags = flags.filter((f) => !f.startsWith("--output-schema"));
  if (help === "missing-config") flags = flags.filter((f) => !f.includes("--config"));
  process.stdout.write(`Run Codex non-interactively\n\nUsage: codex exec [OPTIONS] [PROMPT]\n\nOptions:\n${flags.map((f) => `  ${f}  desc`).join("\n")}\n`);
  process.exit(0);
}
if (args[0] === "debug" && args[1] === "models") {
  log({ cmd: "debug-models" });
  if (process.env.FAKE_NO_CATALOG) process.exit(1);
  const m = (slug, display_name, description, priority, visibility = "list") => ({ slug, display_name, description, priority, visibility, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], context_window: 272000 });
  process.stdout.write(JSON.stringify({ models: [
    m("gpt-6-astra", "GPT-6-Astra", "Frontier intelligence for the most demanding work.", 1),
    m("gpt-6-sol", "GPT-6-Sol", "Workhorse model for coding and everyday work.", 2),
    m("gpt-5.6-sol", "GPT-5.6-Sol", "Older coding model for complex work.", 4),
    m("codex-auto-review", "Codex Auto Review", "Automatic approval review model for Codex.", 43, "hide"),
  ] }));
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "generate-json-schema") {
  // Subconjunto do schema real (0.157.1). FAKE_SCHEMA=drift simula model/list saindo da superfície estável.
  const out = valueOf("--out") ?? valueOf("-o");
  const methods = ["initialize", "model/list", "modelProvider/capabilities/read", "thread/start"].filter((m) => !(process.env.FAKE_SCHEMA === "drift" && m === "model/list"));
  const required = ["defaultReasoningEffort", "description", "displayName", "hidden", "id", "isDefault", "model", "supportedReasoningEfforts"];
  mkdirSync(join(out, "v2"), { recursive: true });
  writeFileSync(join(out, "ClientRequest.json"), JSON.stringify({ oneOf: methods.map((m) => ({ properties: { method: { enum: [m] } } })) }));
  writeFileSync(join(out, "v2", "ModelListResponse.json"), JSON.stringify({ required: ["data"], definitions: { Model: { required, properties: Object.fromEntries([...required, "upgrade", "upgradeInfo"].map((k) => [k, {}])) } } }));
  writeFileSync(join(out, "v2", "ModelProviderCapabilitiesReadResponse.json"), JSON.stringify({ required: ["imageGeneration", "namespaceTools", "webSearch"] }));
  process.exit(0);
}
if (args[0] === "app-server") {
  // JSON-RPC por stdio, uma mensagem por linha, lida em streaming (sem esperar o fim da entrada).
  // FAKE_APPSERVER: off (subcomando inexistente) | badshape | nocaps | hang. FAKE_NO_CATALOG desliga todas as fontes.
  log({ cmd: "app-server", pid: process.pid, args, env: sensitiveEnvSeen() });
  const mode = process.env.FAKE_NO_CATALOG ? "off" : (process.env.FAKE_APPSERVER ?? "ok");
  if (mode === "off") {
    process.stderr.write("error: unrecognized subcommand 'app-server'\n");
    process.exit(2);
  }
  const efforts = process.env.FAKE_CODEX_EFFORTS
    ? JSON.parse(process.env.FAKE_CODEX_EFFORTS).map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }))
    : process.env.FAKE_ADAPTIVE_CATALOG ? ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) : [{ reasoningEffort: "low", description: "l" }, { reasoningEffort: "high", description: "h" }];
  const model = (id, displayName, description, extra = {}) => ({ id, model: id, displayName, description, hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: efforts, upgrade: null, upgradeInfo: null, inputModalities: ["text", "image"], ...extra });
  const models = process.env.FAKE_ADAPTIVE_CATALOG ? [
    model("gpt-6-astra", "GPT-6-Astra", "Deep"),
    model("gpt-6.1-sol", "GPT-6.1-Sol", "Workhorse", { isDefault: true }),
    model("gpt-6-sol", "GPT-6-Sol", "Workhorse"),
    model("gpt-6-luna", "GPT-6-Luna", "Light"),
    model("gpt-5.6-sol", "GPT-5.6-Sol", "Older model"),
    model("gpt-5.5", "GPT-5.5", "Older model"),
  ] : [
    model("gpt-6-astra", "GPT-6-Astra", "Frontier intelligence for the most demanding work.", { isDefault: true }),
    model("gpt-6-sol", "GPT-6-Sol", "Workhorse model for coding and everyday work."),
    model("gpt-5.6-sol", "GPT-5.6-Sol", "Older coding model for complex work."),
    model("gpt-5.5", "GPT-5.5", "Coding model.", { upgrade: "gpt-5.6-sol", upgradeInfo: { model: "gpt-5.6-sol", retirementAt: 1792004400 } }),
    model("codex-auto-review", "Codex Auto Review", "Automatic approval review model for Codex.", { hidden: true }),
  ];
  for (const extra of JSON.parse(process.env.FAKE_CODEX_EXTRA_MODELS ?? "[]")) models.push(model(extra.id, extra.id, "test", extra));
  const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  let initialized = false;
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || mode === "hang") continue;
      const m = JSON.parse(line);
      log({ cmd: "app-server-method", method: m.method, hasParams: "params" in m, env: sensitiveEnvSeen() });
      if (m.method.startsWith("account/") && m.method !== "account/rateLimits/read") throw new Error("forbidden account method");
      if (m.method === "account/rateLimits/read") {
        if (process.env.FAKE_QUOTA === "close") process.exit(1);
        if (process.env.FAKE_QUOTA === "hang") continue;
        if (process.env.FAKE_QUOTA === "error") send({ id: m.id, error: { code: -32601, message: "Method not found" } });
        else {
          const afterExec = process.env.FAKE_QUOTA_AFTER_EXEC && process.env.FAKE_LOG && existsSync(process.env.FAKE_LOG) && readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter(Boolean).some((l) => JSON.parse(l).cmd === "exec");
          send({ id: m.id, result: JSON.parse((afterExec ? process.env.FAKE_QUOTA_AFTER_EXEC : process.env.FAKE_QUOTA) ?? "null") });
        }
      } else if (m.method === "initialize") {
        send({ id: m.id, result: { userAgent: "fake/0.157.1", codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "macos" } });
        send({ method: "account/updated", params: { email: "pessoa-secreta@example.com", planType: "pro" } });
      } else if (m.method === "initialized") initialized = true;
      else if (!initialized) send({ id: m.id, error: { code: -32002, message: "Not initialized" } });
      else if (m.method === "model/list") {
        if (mode === "badshape") send({ id: m.id, result: { items: [{ slug: "gpt-6-astra" }] } });
        else {
          // Paginação forçada: 3 modelos por página.
          const start = m.params?.cursor ? Number(m.params.cursor) : 0;
          const page = models.slice(start, start + 3);
          send({ id: m.id, result: { data: m.params?.includeHidden ? page : page.filter((x) => !x.hidden), nextCursor: start + 3 < models.length ? String(start + 3) : null } });
        }
      } else if (m.method === "modelProvider/capabilities/read") {
        if (mode === "nocaps") send({ id: m.id, error: { code: -32601, message: "Method not found" } });
        else send({ id: m.id, result: { imageGeneration: !process.env.FAKE_NO_IMAGE_GEN, namespaceTools: true, webSearch: true } });
      } else send({ id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  await new Promise(() => {});
}
if (args[0] === "features" && args[1] === "list") {
  process.stdout.write(`apps                  stable   true\nimage_generation      stable   ${process.env.FAKE_NO_IMAGE_GEN ? "false" : "true"}\nview_image            stable   true\n`);
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  log({ cmd: "login-status", env: sensitiveEnvSeen() });
  const mode = process.env.FAKE_AUTH ?? "subscription";
  const text = { subscription: "Logged in using ChatGPT", api_key: "Logged in using an API key - sk-proj-***ABCD", none: "Not logged in", unknown: "Status: ???" }[mode];
  process.stderr.write(text + "\n");
  process.exit(mode === "none" ? 1 : 0);
}
if (args[0] !== "exec") {
  process.stderr.write("fake-codex: modo não suportado\n");
  process.exit(9);
}

const prompt = has("-") ? readStdin() : "";
// `codex exec resume [OPTIONS] <SESSION_ID> -`: o id é o penúltimo argumento; o sandbox vem de -c sandbox_mode=...
const resuming = args[1] === "resume";
const sandboxFromConfig = args.map((a, i) => (args[i - 1] === "--config" ? /^sandbox_mode="(.+)"$/.exec(a)?.[1] : undefined)).find(Boolean);
const schemaPath = valueOf("--output-schema");
log({
  cmd: "exec", model: valueOf("--model") ?? null, effort: args.find((a) => a.startsWith("model_reasoning_effort=")) ?? null, attempt: process.env.DUO_ATTEMPT ?? null, args, env: sensitiveEnvSeen(), depth: process.env.DUO_DEPTH ?? null, promptBytes: prompt.length,
  resume: resuming ? args.at(-2) : null, schemaExists: schemaPath ? existsSync(schemaPath) : false, sandbox: valueOf("--sandbox") ?? sandboxFromConfig,
});

const thread = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const lastMsgPath = valueOf("--output-last-message");
const usage = { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 0, output_tokens: 122, reasoning_output_tokens: 64 };
// Rollout da sessão, como o Codex real grava em $CODEX_HOME/sessions/AAAA/MM/DD/ (FAKE_NO_ROLLOUT desliga).
const writeRollout = (tools = []) => {
  if (process.env.FAKE_NO_ROLLOUT || !process.env.CODEX_HOME) return;
  const d = new Date();
  const dir = join(process.env.CODEX_HOME, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const recs = [
    { type: "session_meta", payload: { id: thread, cwd: process.cwd(), originator: "codex_exec", cli_version: "0.157.1", source: "exec", model_provider: "openai" } },
    { type: "turn_context", payload: { model: process.env.FAKE_ROLLOUT_MODEL ?? valueOf("--model") ?? "gpt-6-astra", cwd: process.cwd(), sandbox_policy: { type: valueOf("--sandbox") ?? sandboxFromConfig ?? "read-only" }, effort: process.env.FAKE_ROLLOUT_EFFORT ?? JSON.parse(args.find((a) => a.startsWith("model_reasoning_effort="))?.slice("model_reasoning_effort=".length) ?? '"high"') } },
    ...tools.map((t) => ({ type: "response_item", payload: { type: "custom_tool_call", input: `const r = await tools.${t}({prompt:"segredo do prompt"});` } })),
    { type: "token_usage_record", payload: { thread_id: thread, response_id: "resp_fake_1", usage: usage } },
    { type: "token_usage_record", payload: { thread_id: thread, response_id: "resp_fake_2", usage: usage } },
  ];
  writeFileSync(join(dir, `rollout-2026-09-26T18-13-01-${thread}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const finish = (rep) => {
  const text = JSON.stringify(rep);
  emit({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: "raciocínio privado que não deve ser salvo" } });
  emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text } });
  if (lastMsgPath) writeFileSync(lastMsgPath, text);
  emit({ type: "turn.completed", usage });
};

switch (scenario) {
  case "private-key":
    emitPrivateKey();
  case "success": {
    emit({ type: "thread.started", thread_id: thread });
    writeRollout(["exec_command"]);
    emit({ type: "turn.started" });
    emit({ type: "item.completed", item: { id: "item_e", type: "error", message: "Exceeded skills context budget. All skill descriptions were removed and 347 additional skills were not included in the model-visible skills list." } });
    const files = applyWrites();
    emit({ type: "item.completed", item: { id: "item_0", type: "file_change", changes: files.map((path) => ({ path, kind: "update" })), status: "completed" } });
    finish(report(files));
    break;
  }
  case "fragmented": {
    const files = applyWrites();
    await writeFragmented([
      { type: "thread.started", thread_id: thread },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i", type: "agent_message", text: JSON.stringify(report(files)) } },
      { type: "turn.completed", usage },
    ]);
    break;
  }
  case "unknown-events": {
    const files = applyWrites();
    emit({ type: "thread.started", thread_id: thread });
    emit({ type: "session.configured.v9" });
    emit({ type: "item.completed", item: { id: "z", type: "hologram" } });
    finish(report(files));
    break;
  }
  case "error-envelope":
    emit({ type: "thread.started", thread_id: thread });
    emit({ type: "error", message: "stream disconnected before completion" });
    process.exit(0);
  case "rate-limit":
    applyWrites();
    emit({ type: "thread.started", thread_id: thread });
    emit({ type: "turn.started" });
    emit({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again at 3:05 PM." } });
    process.exit(1);
  case "model-unavailable":
    emit({ type: "thread.started", thread_id: thread });
    emit({ type: "turn.failed", error: { message: `The '${valueOf("--model")}' model is not supported when using Codex with a ChatGPT account.` } });
    process.exit(1);
  case "incomplete":
    emit({ type: "thread.started", thread_id: thread });
    emit({ type: "turn.started" });
    process.exit(0);
  case "image":
  case "image-missing": {
    emit({ type: "thread.started", thread_id: thread });
    emit({ type: "turn.started" });
    const target = process.env.FAKE_IMAGE_PATH ?? "assets/art.png";
    const imageToolOn = args.includes("--enable") && args[args.indexOf("--enable") + 1] === "image_generation";
    if (scenario === "image" && imageToolOn) {
      // PNG 1x1 válido (assinatura + IHDR), como a ferramenta de imagem gravaria.
      const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
      mkdirSync(dirname(join(process.cwd(), target)), { recursive: true });
      writeFileSync(join(process.cwd(), target), png);
      if (process.env.CODEX_HOME && !process.env.FAKE_IMAGE_NOT_FROM_TOOL) {
        mkdirSync(join(process.env.CODEX_HOME, "generated_images", thread), { recursive: true });
        writeFileSync(join(process.env.CODEX_HOME, "generated_images", thread, "exec-1.png"), png);
      }
    }
    writeRollout(imageToolOn ? ["image_gen__imagegen", "exec_command"] : ["exec_command"]);
    finish(report(scenario === "image" && imageToolOn ? [target] : []));
    break;
  }
  case "timeout":
    spawnGrandchild();
    emit({ type: "thread.started", thread_id: thread });
    await sleep(60_000);
    break;
  case "events-unwritable":
    // Simula falha ao gravar o log de eventos (como disco cheio): events.jsonl vira diretório.
    spawnGrandchild();
    mkdirSync(join(process.cwd(), ".duo", "runs", process.env.DUO_RUN_ID, "tasks", process.env.DUO_TASK_ID, "events.jsonl"), { recursive: true });
    emit({ type: "thread.started", thread_id: thread });
    await sleep(60_000);
    break;
  case "recursive": {
    emit({ type: "thread.started", thread_id: thread });
    const code = tryRecursiveDelegate();
    finish({ ...report([]), summary: `tentativa recursiva terminou com ${code}` });
    break;
  }
  case "remove-lock":
    removeLock();
    emit({ type: "thread.started", thread_id: thread });
    finish(report([]));
    break;
  default:
    process.stderr.write(`cenário desconhecido ${scenario}\n`);
    process.exit(9);
}
