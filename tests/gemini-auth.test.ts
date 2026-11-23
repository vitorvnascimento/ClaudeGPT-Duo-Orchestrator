// Login do executor Gemini: sinal sem segredo do log do agy, colhido num `agy models` (sem inferência).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { packageRoot } from "../src/paths.js";
import { authBlockReason } from "../src/permissions/auth.js";
import { geminiAuthPreflight, geminiParentEnvProblem } from "../src/permissions/gemini-auth.js";

const FAKE = join(packageRoot(), "tests", "fixtures", "fake-agy.mjs");
// Pelo node (no Windows o shebang do fixture não roda).
const resolved = { ok: true as const, command: process.execPath, prefixArgs: [FAKE], source: "config" as const };
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
function home(): string { const d = realpathSync(mkdtempSync(join(tmpdir(), "duo-gem-auth-"))); dirs.push(d); return d; }
const env = (h: string, extra: Record<string, string> = {}) => ({ PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: h, ...extra });
const ack = (v: boolean) => { const c = structuredClone(DEFAULT_CONFIG); c.billing.acknowledgeUnverifiableExtraUsage.gemini = v; return c; };

describe("preflight de login do gemini", () => {
  it("passes with the keyring consumer signal and acknowledgment", () => {
    const h = home();
    const a = geminiAuthPreflight(resolved, env(h), ack(true), null);
    assert.equal(a.method, "subscription");
    assert.equal(a.ok, true);
    assert.equal(authBlockReason(a), null);
    assert.doesNotMatch(a.detail, /@/);
  });
  it("blocks without acknowledgment", () => {
    const a = geminiAuthPreflight(resolved, env(home()), ack(false), null);
    assert.match(String(authBlockReason(a)), /acknowledgeUnverifiableExtraUsage\.gemini/);
  });
  it("blocks when the signal is an API key", () => {
    const a = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_AUTH: "apikey" }), ack(true), null);
    assert.equal(a.method, "api_key");
    assert.notEqual(authBlockReason(a), null);
  });
  it("conflicting login signals in one log are unknown, never subscription", () => {
    const a = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_AUTH: "conflict" }), ack(true), null);
    assert.equal(a.method, "unknown");
    assert.equal(a.ok, false);
    assert.match(a.detail, /conflitantes/);
  });
  it("a partial log with only the effective API-key signal is api_key, even when agy models fails", () => {
    const a = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_AUTH: "partial-apikey", FAKE_AGY_NO_MODELS: "1" }), ack(true), null);
    assert.equal(a.method, "api_key");
  });
  it("a directory among fresh log entries is skipped and the login is still classified", () => {
    const a = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_LOG_SUBDIR: "1" }), ack(true), null);
    assert.equal(a.method, "subscription");
    assert.equal(a.ok, true);
  });
  it("an unreadable regular log blocks: unknown with a consumer log, api_key evidence kept", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    const a = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_LOG_UNREADABLE: "1" }), ack(true), null);
    assert.equal(a.ok, false);
    assert.equal(a.method, "unknown");
    const b = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_LOG_UNREADABLE: "1", FAKE_AGY_AUTH: "apikey" }), ack(true), null);
    assert.equal(b.method, "api_key");
  });
  it("a non-empty subdirectory in the log dir makes the login inconclusive (a nested log could hold api_key)", () => {
    const a = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_LOG_NESTED: "1" }), ack(true), null);
    assert.equal(a.ok, false);
    assert.equal(a.method, "unknown");
  });
  it("a log symlink is not silently skipped: the login becomes inconclusive", { skip: process.platform === "win32" }, () => {
    const a = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_LOG_LINK: "1" }), ack(true), null);
    assert.equal(a.ok, false);
    assert.equal(a.method, "unknown");
  });
  it("a stale consumer line from an earlier run does not count", () => {
    const h = home();
    const logDir = join(h, ".gemini", "antigravity-cli", "log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "old.log"), "authenticated via keyring (effective: keyring)\nauthMethod=consumer\n");
    const a = geminiAuthPreflight(resolved, env(h, { FAKE_AGY_AUTH: "apikey" }), ack(true), null);
    assert.equal(a.method, "api_key");
  });
  it("blocks when agy models fails, without echoing raw stderr", () => {
    const a = geminiAuthPreflight(resolved, env(home(), { FAKE_AGY_NO_MODELS: "1" }), ack(true), null);
    assert.equal(a.ok, false);
    assert.notEqual(authBlockReason(a), null);
    assert.doesNotMatch(a.detail, /Please sign in/);
    assert.match(a.detail, /agy models falhou \(/);
  });
  it("parent env with Google credentials is a problem before sanitizing", () => {
    assert.match(String(geminiParentEnvProblem({ GEMINI_API_KEY: "x", PATH: "/bin" })), /GEMINI_API_KEY/);
    assert.equal(geminiParentEnvProblem({ PATH: "/bin" }), null);
  });
});
