// GeminiAdapter: plano de invocação (tarefa 6) e leitura do stream (tarefa 7). Offline.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AGY_FLAGS, capabilitiesFromHelp } from "../src/adapters/capabilities.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { validateGeminiArgv } from "../src/adapters/gemini-argv.js";
import type { InvocationInput } from "../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { packageRoot } from "../src/paths.js";

const HELP = readFileSync(join(packageRoot(), "tests", "fixtures", "agy", "help-1.5.3.txt"), "utf8");
const VERIFIED = [{ version: "1.5.3", platform: process.platform }];
const PROMPT = "SEGREDO-DO-PROMPT objetivo confidencial";
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function input(over: Partial<InvocationInput> = {}, help = HELP, version: string | null = "1.5.3"): InvocationInput {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-ad-")));
  dirs.push(base);
  const home = join(base, "home");
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(join(base, "art"));
  return {
    resolved: { ok: true, command: "/opt/agy/bin/agy", prefixArgs: [], source: "path" },
    caps: capabilitiesFromHelp(help, version, AGY_FLAGS),
    cfg: structuredClone(DEFAULT_CONFIG),
    cwd: join(base, "wt"),
    kind: "implement",
    prompt: PROMPT,
    writableAbs: [{ abs: join(base, "wt", "ok.txt"), isDir: false }],
    denyGlobs: [],
    acceptanceArgv: [],
    needs: [],
    model: "gemini-4-argon-high",
    effort: null,
    resumeSessionId: null,
    artifactsDir: join(base, "art"),
    env: { PATH: "/usr/bin:/bin" },
    gemini: { privateHome: home, tmpDir: join(home, "tmp"), profilePath: join(home, "profile.sb") },
    ...over,
  };
}

describe("GeminiAdapter.plan", () => {
  const adapter = new GeminiAdapter({ verified: VERIFIED });

  it("plan wraps agy in sandbox-exec when a profile is given", () => {
    const i = input();
    const p = adapter.plan(i);
    assert.equal(p.command, "/usr/bin/sandbox-exec");
    assert.deepEqual(p.args.slice(0, 3), ["-f", i.gemini?.profilePath, "/opt/agy/bin/agy"]);
    assert.equal(validateGeminiArgv(p.args.slice(3)), null);
  });

  it("prompt is absent from argv and stdin carries one NDJSON message", () => {
    const p = adapter.plan(input());
    assert.ok(!p.args.join(" ").includes("SEGREDO-DO-PROMPT"));
    const lines = p.stdin.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string), { event: "user", message: { role: "user", content: PROMPT } });
    assert.ok(p.args.includes("-p="));
  });

  it("resume adds --conversation", () => {
    const p = adapter.plan(input({ resumeSessionId: "16c44696-87ee-40f5-8825-0d3ae2152189" }));
    const i = p.args.indexOf("--conversation");
    assert.equal(p.args[i + 1], "16c44696-87ee-40f5-8825-0d3ae2152189");
  });

  it("env has private HOME and TMPDIR and no Google keys", () => {
    const i = input({ env: { PATH: "/bin", GEMINI_API_KEY: "x", HOME: "/Users/real" } });
    const p = adapter.plan(i);
    assert.equal(p.env.HOME, i.gemini?.privateHome);
    assert.equal(p.env.TMPDIR, i.gemini?.tmpDir);
    assert.equal(p.env.GEMINI_API_KEY, undefined);
  });

  it("settings keep the guard and enforced lists both layers", () => {
    const p = adapter.plan(input());
    const s = JSON.parse(p.args[p.args.indexOf("--settings") + 1] as string) as Record<string, unknown>;
    assert.deepEqual(s, { allowNonWorkspaceAccess: false, permissions: { deny: ["command(*)"] } });
    assert.ok(p.enforced.some((e) => /gate/.test(e)));
    assert.ok(p.enforced.some((e) => /sandbox-exec/.test(e)));
  });

  it("refuses agy without stdin stream-json flag", () => {
    const help = HELP.split("\n").filter((l) => !l.includes("--input-format")).join("\n");
    assert.throws(() => adapter.plan(input({}, help)), /--input-format/);
  });

  it("refuses unverified agy version with identical help (and 1.5.3 itself by default)", () => {
    assert.throws(() => adapter.plan(input({}, HELP, "1.6.0")), /não verificada/);
    assert.throws(() => new GeminiAdapter().plan(input()), /não verificada/);
  });

  it("accepts any agy model id, refuses a malformed one and a missing model", () => {
    assert.ok(adapter.plan(input({ model: "claude-opus-5-5-high" })).args.includes("claude-opus-5-5-high"));
    assert.throws(() => adapter.plan(input({ model: "--dangerously-skip-permissions" })), /inválido/);
    assert.throws(() => adapter.plan(input({ model: null })), /modelo/);
  });

  it("refuses to run without the private home extras", () => {
    assert.throws(() => adapter.plan(input({ gemini: undefined })), /HOME privado/);
  });
});

describe("GeminiAdapter.parser", () => {
  const fx = (name: string) => readFileSync(join(packageRoot(), "tests", "fixtures", "agy", name), "utf8");
  function parse(name: string, stderr = "", gateLog?: string) {
    const p = new GeminiAdapter({ verified: VERIFIED }).parser(gateLog);
    for (const l of fx(name).split("\n")) if (l.trim()) p.onLine(l);
    return p.finish(null, stderr);
  }

  it("plain-response → invalid report (not an ExecutorReport), session id kept", () => {
    const o = parse("plain-response.ndjson");
    assert.equal(o.errorKind, "invalid_report");
    assert.match(String(o.sessionId), /^[0-9a-f-]{36}$/);
    assert.ok((o.usage?.total_tokens ?? 0) > 0);
  });

  it("deny-wins-over-allow → 4 denials although result has no denied_actions", () => {
    assert.equal(parse("deny-wins-over-allow.ndjson").permissionDenials, 4);
  });

  it("write-and-denied-command → 1 denial (deduplicated)", () => {
    assert.equal(parse("write-and-denied-command.ndjson").permissionDenials, 1);
  });

  it("hook gate fixture counts the three hook denials", () => {
    assert.equal(parse("hook-gate-allows-only-target.ndjson").permissionDenials, 3);
  });

  it("missing-event-field → errorMessage is the result.error text", () => {
    const o = parse("missing-event-field.ndjson");
    assert.equal(o.errorKind, "error_envelope");
    assert.match(String(o.errorMessage), /missing the "event" field/);
  });

  it("prose response after denied tools → invalid_report, denials still counted", () => {
    const o = parse("deny-wins-over-allow.ndjson");
    assert.equal(o.errorKind, "invalid_report");
    assert.equal(o.permissionDenials, 4);
  });

  it("synthetic: SUCCESS with empty response and one hook denial → permission_denied", () => {
    const p = new GeminiAdapter({ verified: VERIFIED }).parser();
    p.onLine(JSON.stringify({ event: "init", conversation_id: "c1", init: { model: "gemini-x" } }));
    p.onLine(JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state: "ERROR", tool_name: "write_file", tool_info: { parameters: { Path: "/W/b.txt" }, error: { message: "tool call denied by pre-tool hook: duo-gate" } } } }));
    p.onLine(JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "", num_turns: 1, duration_seconds: 1.5, usage: { total_tokens: 3 } } }));
    const o = p.finish(null, "");
    assert.equal(o.errorKind, "permission_denied");
    assert.match(String(o.errorMessage), /write_file/);
    assert.equal(o.durationMs, 1500);
  });

  it("quota only on stderr with empty stdout → quota", () => {
    const p = new GeminiAdapter({ verified: VERIFIED }).parser();
    const o = p.finish(null, "Error: You have exhausted your capacity on this model. Your quota will reset after 3h. (429)");
    assert.equal(o.errorKind, "quota");
  });

  it("reportedModel comes from the gate log modelName (and stays null without it)", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-log-")));
    dirs.push(base);
    const log = join(base, "gate-log.jsonl");
    writeFileSync(log, `${JSON.stringify({ tool: "write_file", decision: "allow", modelName: "gemini-4-argon-high" })}\n`);
    assert.equal(parse("plain-response.ndjson", "", log).reportedModel, "gemini-4-argon-high");
    assert.equal(parse("plain-response.ndjson").reportedModel, null);
  });

  it("schema-valid report capture", { todo: "pending-capture: gravar uma execução real com --json-schema antes de habilitar" }, () => {});
});
