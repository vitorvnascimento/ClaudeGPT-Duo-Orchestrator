// GeminiAdapter: plano de invocação (tarefa 6) e leitura do stream (tarefa 7). Offline.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

  it("refuses a model outside ^gemini- and a missing model", () => {
    assert.throws(() => adapter.plan(input({ model: "claude-opus-5-5-high" })), /gemini-/);
    assert.throws(() => adapter.plan(input({ model: null })), /modelo/);
  });

  it("refuses to run without the private home extras", () => {
    assert.throws(() => adapter.plan(input({ gemini: undefined })), /HOME privado/);
  });
});
