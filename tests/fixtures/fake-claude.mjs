#!/usr/bin/env node
// Claude Code simulado: imita `--version`, `--help`, `auth status` e `-p --output-format stream-json`.
import { existsSync, readFileSync } from "node:fs";
import {
  applyWrites, emit, emitPrivateKey, log, readStdin, removeLock, report, scenario, sensitiveEnvSeen, sleep, spawnGrandchild, tryRecursiveDelegate, writeFragmented,
} from "./fake-common.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);

const FLAGS = [
  "-p, --print", "--output-format <format>", "--verbose", "--json-schema <schema>", "--tools <tools...>",
  "--disallowedTools, --disallowed-tools <tools...>", "--allowedTools, --allowed-tools <tools...>",
  "--effort <level>", "--permission-mode <mode>", "--model <model>", "-r, --resume [value]", "--setting-sources <sources>",
  "--strict-mcp-config", "--disable-slash-commands", "--append-system-prompt <prompt>", "--bare",
];

if (has("--version")) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? process.env.FAKE_VERSION ?? "2.1.114"} (Claude Code)\n`);
  process.exit(0);
}
if (has("--help")) {
  let flags = FLAGS;
  if (process.env.FAKE_HELP === "missing-schema") flags = flags.filter((f) => !f.startsWith("--json-schema"));
  if (process.env.FAKE_HELP === "missing-effort") flags = flags.filter((f) => !f.startsWith("--effort"));
  process.stdout.write(`Usage: claude [options]\n\nOptions:\n${flags.map((f) => `  ${f}   desc`).join("\n")}\n`);
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  log({ cmd: "auth-status", env: sensitiveEnvSeen() });
  const blockedCall = process.env.FAKE_AUTH_BLOCK_CALL && process.env.FAKE_LOG && existsSync(process.env.FAKE_LOG)
    && readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter(Boolean).filter((line) => JSON.parse(line).cmd === "auth-status").length === Number(process.env.FAKE_AUTH_BLOCK_CALL);
  const mode = blockedCall ? "none" : process.env.FAKE_AUTH ?? "subscription";
  const out = {
    subscription: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "user@example.com", orgId: "org-1234567890abcdef", subscriptionType: "pro" },
    api_key: { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" },
    none: { loggedIn: false },
    unknown: { loggedIn: true, authMethod: "mystery", apiProvider: "firstParty" },
    cloud: { loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" },
  }[mode];
  if (mode === "garbage") process.stdout.write("Logged in (maybe)\n");
  else process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

if (!has("-p")) {
  process.stderr.write("fake-claude: modo não suportado\n");
  process.exit(9);
}

// Handshake initialize (supportedModels do Agent SDK): como a CLI real, responde em streaming
// assim que a linha chega (a entrada continua aberta) e sai quando a entrada fecha, sem inferência.
if (valueOf("--input-format") === "stream-json") {
  log({ cmd: "initialize", env: sensitiveEnvSeen() });
  if (process.env.FAKE_NO_CATALOG) process.exit(1);
  let pending = "";
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type !== "control_request" || msg.request?.subtype !== "initialize") continue;
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            account: { email: "user@example.com" },
            models: process.env.FAKE_ADAPTIVE_CATALOG ? [
              { value: "default", resolvedModel: "claude-opus-5-5" },
              ...["claude-opus-5-5", "claude-fable-5-1[1m]", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"].map((id) => ({ value: id, resolvedModel: id, displayName: id, description: id.includes("[1m]") ? "usage credits" : "", supportedEffortLevels: id.includes("haiku") ? [] : ["low", "medium", "high", "xhigh"] })),
            ] : [
              { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportedEffortLevels: ["low", "high"] },
              { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable for ambitious work", supportedEffortLevels: ["low", "high"] },
              { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Most efficient for everyday tasks" },
              { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Older model, kept for compatibility" },
            ],
          },
        },
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  await new Promise(() => {});
}

const prompt = readStdin();
log({ cmd: "print", model: valueOf("--model") ?? null, effort: valueOf("--effort") ?? null, attempt: process.env.DUO_ATTEMPT ?? null, args, env: sensitiveEnvSeen(), depth: process.env.DUO_DEPTH ?? null, promptBytes: prompt.length, resume: valueOf("--resume") ?? null });

const session = "sess-claude-123";
const init = {
  type: "system", subtype: "init", session_id: session,
  model: scenario === "model-fallback" ? "claude-opus-4-7" : valueOf("--model") ?? "claude-opus-5-5", tools: ["Read"], mcp_servers: [],
};
const assistant = { type: "assistant", session_id: session, message: { content: [{ type: "thinking", thinking: "segredo do raciocínio interno" }, { type: "text", text: "ok" }] } };
const usage = { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 100, cache_read_input_tokens: 800 };
const result = (structured) => ({
  type: "result", subtype: "success", is_error: false, session_id: session, result: "done", structured_output: structured,
  total_cost_usd: 0.0421, usage, modelUsage: { "claude-opus-5-5": {} }, num_turns: 3, duration_ms: 4200, permission_denials: [],
});

switch (scenario) {
  case "version-too-old":
    // Envelope real observado com a CLI 2.1.114 pedindo claude-opus-5-5 (exit 0, is_error true).
    emit({
      type: "result", subtype: "success", is_error: true, api_error_status: 400, session_id: session,
      result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.114 does not support this model; version 2.1.280 or newer is required. Run \'claude update\', or update the Claude desktop app, then try again.","details":{"error_code":"claude_code_version_too_old"}}}',
    });
    process.exit(0);
  case "private-key":
    emitPrivateKey();
  case "success":
  case "model-fallback":
  case "overage": {
    const files = applyWrites();
    emit(init);
    emit({
      type: "rate_limit_event",
      rate_limit_info: JSON.parse(process.env.FAKE_CLAUDE_RATE_LIMIT ?? "null") ?? { status: "allowed", resetsAt: 4102444800, rateLimitType: "five_hour", overageStatus: scenario === "overage" ? "allowed" : "rejected", overageDisabledReason: scenario === "overage" ? null : "out_of_credits", isUsingOverage: scenario === "overage" },
      session_id: session,
    });
    emit(assistant);
    emit(result(report(files)));
    break;
  }
  case "unknown-events": {
    const files = applyWrites();
    emit({ type: "system", subtype: "hook_started" });
    emit(init);
    emit({ type: "brand_new_event", payload: 1 });
    process.stdout.write("isto não é json\n");
    emit(result(report(files)));
    break;
  }
  case "fragmented": {
    const files = applyWrites();
    await writeFragmented([init, { type: "assistant", message: { content: [{ type: "text", text: "ação 🚀 çãõ" }] } }, result(report(files))]);
    break;
  }
  case "no-trailing-newline": {
    const files = applyWrites();
    emit(init);
    process.stdout.write(JSON.stringify(result(report(files))));
    break;
  }
  case "error-envelope":
    emit(init);
    emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session, result: "Tool execution crashed", usage });
    process.exit(0);
  case "auth-error":
    emit(init);
    emit({ type: "system", subtype: "api_retry", error: "authentication_failed", session_id: session });
    process.exit(1);
  case "rate-limit":
    applyWrites();
    emit(init);
    if (process.env.FAKE_CLAUDE_RATE_LIMIT) emit({ type: "rate_limit_event", rate_limit_info: JSON.parse(process.env.FAKE_CLAUDE_RATE_LIMIT), session_id: session });
    emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 1, error: "rate_limit", session_id: session });
    emit({ type: "result", subtype: "success", is_error: true, session_id: session, result: "Claude usage limit reached. Your limit will reset at 5pm." });
    process.exit(1);
  case "model-unavailable":
    emit({ type: "result", subtype: "success", is_error: true, session_id: session, result: `model: ${valueOf("--model")} not found or not available for your account` });
    process.exit(1);
  case "incomplete":
    emit(init);
    emit(assistant);
    process.exit(0);
  case "invalid-report":
    emit(init);
    emit(result({ status: "done-ish" }));
    break;
  case "huge-output":
    emit(init);
    for (let i = 0; i < 5000; i++) emit({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(200) }] } });
    emit(result(report([])));
    break;
  case "timeout":
    spawnGrandchild();
    emit(init);
    await sleep(60_000);
    break;
  case "partial": {
    const files = applyWrites();
    emit(init);
    emit(result({ ...report(files), status: "partial", blockedReason: "precisa de decisão sobre formato de data" }));
    break;
  }
  case "recursive": {
    const code = tryRecursiveDelegate();
    emit(init);
    emit(result({ ...report([]), summary: `tentativa recursiva terminou com ${code}` }));
    break;
  }
  case "remove-lock": {
    removeLock();
    emit(init);
    emit(result(report([])));
    break;
  }
  case "leak-secret": {
    emit(init);
    emit({ type: "assistant", message: { content: [{ type: "text", text: "token=sk-ant-api03-SECRETSECRETSECRET e Bearer abcdefghijklmnop123" }] } });
    emit(result(report([])));
    break;
  }
  default:
    process.stderr.write(`cenário desconhecido ${scenario}\n`);
    process.exit(9);
}
