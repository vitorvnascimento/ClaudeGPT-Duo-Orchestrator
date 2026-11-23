#!/usr/bin/env node
// agy (Antigravity CLI) simulado: `--version`, `--help`, `models` e o modo headless stream-json.
// O headless reproduz uma gravação real de tests/fixtures/agy/ (FAKE_AGY_SCENARIO) ou um relatório válido.
import { symlinkSync, chmodSync, appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log, readStdin, report as fakeReport } from "./fake-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);
// Testes do perfil privado: registra onde e com que perfil cada chamada rodou.
if (process.env.FAKE_AGY_ENV_OUT) {
  const e = process.env;
  appendFileSync(e.FAKE_AGY_ENV_OUT, `${JSON.stringify({ argv: args.slice(0, 1), cwd: process.cwd(), HOME: e.HOME, USERPROFILE: e.USERPROFILE ?? null, APPDATA: e.APPDATA ?? null, LOCALAPPDATA: e.LOCALAPPDATA ?? null, TEMP: e.TEMP ?? null, TMP: e.TMP ?? null })}\n`);
}

if (has("--version")) { process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? "1.5.3"}\n`); process.exit(Number(process.env.FAKE_AGY_VERSION_EXIT ?? 0)); }
if (has("--help")) { process.stdout.write(readFileSync(join(here, "agy", "help-1.5.3.txt"), "utf8")); process.exit(0); }
if (args[0] === "models") {
  log({ cmd: "agy-models", home: process.env.HOME });
  if (process.env.HOME) {
    const d = join(process.env.HOME, ".gemini", "antigravity-cli", "log");
    mkdirSync(d, { recursive: true });
    if (process.env.FAKE_AGY_LOG_SUBDIR) mkdirSync(join(d, "subdir"), { recursive: true });
    if (process.env.FAKE_AGY_LOG_NESTED) { mkdirSync(join(d, "sub"), { recursive: true }); writeFileSync(join(d, "sub", "nested.log"), "authenticated via apikey (effective: apikey)\nauthMethod=api_key\n"); }
    if (process.env.FAKE_AGY_LOG_LINK) { writeFileSync(join(d, "..", "outside.log"), "authenticated via apikey (effective: apikey)\n"); symlinkSync(join(d, "..", "outside.log"), join(d, "link.log")); }
    if (process.env.FAKE_AGY_LOG_UNREADABLE) { writeFileSync(join(d, "locked.log"), "authenticated via apikey (effective: apikey)\n"); chmodSync(join(d, "locked.log"), 0); }
    writeFileSync(join(d, "cli-fake.log"), process.env.FAKE_AGY_AUTH === "partial-apikey"
      ? "I1 auth.go:157] ChainedAuth: authenticated via apikey (effective: apikey)\n"
      : process.env.FAKE_AGY_AUTH === "conflict"
      ? "I1 auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)\nI1 server_oauth.go:221] applyAuthResult: email=x@y.z, authMethod=consumer, quotaProject=\nI1 auth.go:157] ChainedAuth: authenticated via apikey (effective: apikey)\nI1 server_oauth.go:221] applyAuthResult: authMethod=api_key, quotaProject=\n"
      : process.env.FAKE_AGY_AUTH === "apikey"
      ? "I1 auth.go:157] ChainedAuth: authenticated via apikey (effective: apikey)\nI1 server_oauth.go:221] applyAuthResult: email=x@y.z, authMethod=api_key, quotaProject=\n"
      : "I1 auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)\nI1 server_oauth.go:221] applyAuthResult: email=x@y.z, authMethod=consumer, quotaProject=\n");
  }
  if (process.env.FAKE_AGY_NO_MODELS) { process.stderr.write("Error: Please sign in to view available models.\n"); process.exit(1); }
  process.stdout.write("Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n");
  process.exit(0);
}
const stdin = await readStdin();
log({ cmd: "agy-run", args, stdin, home: process.env.HOME, tmpdir: process.env.TMPDIR, cwd: process.cwd() });
// Simula escritas do executor no cwd (worktree), como o write_file real faria.
const writes = JSON.parse(process.env.FAKE_AGY_WRITES ?? "{}");
for (const [rel, content] of Object.entries(writes)) { mkdirSync(dirname(join(process.cwd(), rel)), { recursive: true }); writeFileSync(join(process.cwd(), rel), content); }
const scenario = process.env.FAKE_AGY_SCENARIO;
if (scenario) { process.stdout.write(readFileSync(join(here, "agy", `${scenario}.ndjson`), "utf8")); process.exit(0); }
const model = valueOf("--model") ?? "gemini-x";
const conv = valueOf("--conversation") ?? "00000000-0000-4000-8000-000000000001";
// Simula o hook: registra o modelo em uso no log do gate, como o gate real faria.
// O log é o desta tentativa: o caminho vem do comando do hook (DUO_GATE_LOG) em .agents/hooks.json da worktree.
let gateLog = null;
try { gateLog = /DUO_GATE_LOG='([^']+)'/.exec(readFileSync(join(process.cwd(), ".agents", "hooks.json"), "utf8"))?.[1] ?? null; } catch { gateLog = null; }
if (gateLog && existsSync(dirname(gateLog))) appendFileSync(gateLog, `${JSON.stringify({ tool: "write_file", decision: "allow", modelName: process.env.FAKE_AGY_SERVED_MODEL ?? model })}\n`);
const report = { ...fakeReport(Object.keys(writes)), testsRun: [], ...JSON.parse(process.env.FAKE_REPORT ?? "{}") };
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
emit({ event: "init", conversation_id: conv, init: { model, cwd: process.cwd(), tools: ["write_file"], permission_mode: "request-review" } });
emit({ event: "result", result: { conversation_id: conv, status: "SUCCESS", response: JSON.stringify(report), duration_seconds: 0.5, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
