import { test, type TestContext } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as zlib from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findRollout, readBoundedRollout, readRolloutEvidence } from "../src/adapters/codex-rollout.js";
import { canonicalAppId, ComputerUseCollector, sanitizeComputerUseLine } from "../src/adapters/computer-use-evidence.js";

const before = "2026-11-05T19:00:00.000Z";
const at = "2026-11-05T20:00:00.000Z";
const sinceMs = Date.parse(at);
const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
function setup(t: { after: (fn: () => void) => void }, apps?: readonly string[]) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "cu-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, collector: new ComputerUseCollector({ apps, artifactsDir: dir, sinceMs }) };
}
function event(id: string, args?: unknown, result?: unknown, type = "item.completed", timestamp: string | undefined = at): string {
  return JSON.stringify({ type, timestamp, item: { id, type: "mcp_tool_call", server: "cua_repl", tool: "js", ...(args === undefined ? {} : { arguments: args }), ...(result === undefined ? {} : { result }) } });
}
function rolloutRecord(type: string, payload: unknown, timestamp = at): string { return JSON.stringify({ type, timestamp, payload }); }
function call(id: string, code: string, timestamp = at): string {
  return rolloutRecord("response_item", { type: "function_call", name: "mcp__cua_repl__js", arguments: JSON.stringify({ code }), call_id: id }, timestamp);
}
function output(id: string, content: unknown, timestamp = at): string {
  return rolloutRecord("response_item", { type: "function_call_output", call_id: id, output: JSON.stringify({ content }) }, timestamp);
}
function writeRollout(dir: string, records: string[], session = "thread-1"): string {
  const file = join(dir, "rollout.jsonl");
  writeFileSync(file, [rolloutRecord("session_meta", { id: session }, before), ...records].join("\n"));
  return file;
}
// Keep the native rollout separate from the directory whose image files the test counts.
function attribute(t: TestContext, collector: ComputerUseCollector, records: string[]) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "cu-rollout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  collector.readRollout(writeRollout(dir, records), "thread-1");
}
function png(seed = 0, padding = 0): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const b of body) { crc ^= b; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, seed, 30, 40, 255]))), ...(padding ? [chunk("tEXt", Buffer.alloc(padding))] : []), chunk("IEND", Buffer.alloc(0))]);
}
const image = (bytes = png()) => ({ type: "image", mimeType: "image/png", data: bytes.toString("base64"), path: "../../must-not-be-used.png" });

test("native observed items: literal app actions, lifecycle dedup and metadata privacy", t => {
  const { collector } = setup(t, ["Finder"]);
  const code = 'let app = await cua.getApp("Finder");';
  collector.onLine(event("item_0", { code, title: "PRIVATE TITLE" }, undefined, "item.started"));
  collector.onLine(event("item_0", { code, title: "PRIVATE TITLE" }, undefined, "item.updated"));
  collector.onLine(event("item_0", { code, title: "PRIVATE TITLE" }, { content: [{ type: "text", text: "PRIVATE SCREEN" }] }));
  const input = '"PRIVATE TYPED VALUE"';
  collector.onLine(event("item_1", { code: `await app.getAXState(); await app.click([1, 2]); await app.typeText(${input}); await app.pressKey("CMD+A"); await app.scroll([1, 2], "down", 1); await app.getScreenshot();` }));
  const evidence = collector.finish(["com.apple.finder"]);
  assert.deepEqual(evidence.appsUsed, ["finder"]);
  assert.deepEqual(evidence.actions.map(action => action.kind), ["view", "view", "click", "type", "shortcut", "scroll", "view"]);
  assert.equal(evidence.actions[3]!.inputBytes, Buffer.byteLength(input));
  assert.equal(evidence.actions[3]!.inputSha256, sha(input));
  assert.ok(evidence.actions.every(action => action.at === at));
  assert.deepEqual(evidence.violations, []);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|CMD\+A|await|direction|pixels/);
});

test("sanitizer never retains messages, malformed lines, stderr, outputs, IDs or unknown keys", () => {
  const lines = [
    event("PRIVATE ID", { code: 'await cua.getApp("PRIVATE APP");', title: "PRIVATE TITLE" }, { content: [{ type: "text", text: "PRIVATE SCREEN" }, image()] }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "PRIVATE PROSE", id: "PRIVATE ID" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ text: "PRIVATE SUMMARY" }] } }),
    JSON.stringify({ type: "PRIVATE TYPE", item: { type: "PRIVATE SUBTYPE" }, private: "PRIVATE" }),
    '{"PRIVATE malformed', "stderr: PRIVATE error", '"PRIVATE"', "null", "[]", "",
  ];
  for (const line of lines) {
    const sanitized = sanitizeComputerUseLine(line);
    assert.doesNotMatch(sanitized, /PRIVATE|base64|mimeType|Computer Use was/);
    const metadata = JSON.parse(sanitized);
    assert.equal(metadata.sha256, sha(line));
    assert.equal(metadata.bytes, Buffer.byteLength(line));
    assert.equal(metadata.omitted, true);
    assert.deepEqual(Object.keys(metadata).sort(), ["bytes", "event", "itemType", "omitted", "sha256", "type"]);
  }
});

test("actual tool permission denial is structured without any final report", t => {
  const { collector } = setup(t, ["Finder"]);
  collector.onLine(event("denied", { code: 'let app = await cua.getApp("Finder");' }, { error: { message: "Computer Use was not approved to use Finder\nPRIVATE STACK" } }));
  const result = collector.finish();
  assert.deepEqual(result.permission, { kind: "app_permission", app: "Finder" });
  assert.ok(result.violations.includes("app_permission_denied"));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Error|approved/);
});

test("screen text in JSON-encoded rollout and agent claims cannot grant a permission checkpoint", t => {
  const { collector, dir } = setup(t);
  collector.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Computer Use was not approved to use Mail" } }));
  assert.equal(collector.finish().permission, null);
  const file = writeRollout(dir, [call("a", 'let app = await cua.getApp("Finder");'), output("a", [{ type: "text", text: "Computer Use was not approved to use Finder" }])]);
  collector.readRollout(file, "thread-1");
  assert.equal(collector.finish().permission, null);
});

test("aliases, unlisted apps, optional declarations, sensitive apps and report mismatch", t => {
  assert.equal(canonicalAppId("System Preferences.app"), "systemsettings");
  assert.equal(canonicalAppId("com.1password.1password8"), "1password");
  assert.equal(canonicalAppId("/Applications/Mail.app"), "");
  const { collector } = setup(t, ["Finder"]);
  collector.onLine(event("a", { code: 'const m = await cua.getApp("com.apple.mail"); await m.getAXState();' }));
  const result = collector.finish(["Finder"]);
  assert.deepEqual(result.appsUsed, ["mail"]);
  assert.ok(result.violations.includes("unlisted_app:mail"));
  assert.ok(result.violations.includes("denied_app:mail"));
  assert.ok(result.violations.includes("reported_apps_mismatch"));
  const allowed = setup(t, ["Mail"]).collector;
  allowed.onLine(event("a", { code: 'const m = await cua.getApp("com.apple.mail");' }));
  assert.ok(allowed.finish(["Mail"]).violations.includes("denied_app:mail"));
  const optional = setup(t).collector;
  optional.onLine(event("a", { code: 'const m = await cua.getApp("Terminal");' }));
  assert.ok(optional.finish().violations.includes("denied_app:terminal"));
});

test("completion_summary never becomes an interaction or app identity", t => {
  const { collector } = setup(t);
  collector.onLine(event("done", { completion_summary: "I typed PRIVATE into Mail and Finder" }, { content: [{ type: "text", text: "PRIVATE RESULT" }] }));
  assert.deepEqual(collector.finish(), { actions: [], appsUsed: [], screenshots: [], permission: null, violations: [], warnings: [] });
  assert.ok(collector.finish(["Mail"]).violations.includes("reported_apps_mismatch"));
});

test("unknown/dynamic code and targets fail visibly, with no raw code leakage", t => {
  const samples = [
    'let app = await cua.getApp(dynamicName);', 'await unknown.getState();',
    'const app = await cua.getApp(`Finder`);', 'const app = await cua.getApp("Finder"); await app["click"](1);',
    'await app.type(PRIVATE_VARIABLE);', 'if (true) { await cua.getApp("Mail"); }',
    'eval("PRIVATE");', 'const app = await cua.getApp("Finder"); console.log("PRIVATE");',
    'await cua.getApp("Finder"); await cua.getApp("Mail" + "PRIVATE");',
    'let cua = await cua.getApp("Finder");', 'await cua.getApp("../../PRIVATE");',
    'await app.type({get text() { return "PRIVATE"; }});',
  ];
  for (const code of samples) {
    const { collector } = setup(t);
    collector.onLine(event("bad", { code }));
    const result = collector.finish();
    assert.ok(result.violations.includes("unparseable_call"), code);
    assert.equal(result.actions[0]!.app, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|eval|console\.log/);
  }
});

test("bindings across calls, literal escapes, reassignment and unknown-code invalidation", t => {
  const { collector } = setup(t, ["Finder", "Safari"]);
  collector.onLine(event("a", { code: "const app = await cua.getApp('Find\\u0065r'); // ignored PRIVATE\n await app.typeText('PRIVATE\\'S');" }));
  collector.onLine(event("b", { code: 'app = await cua.getApp("Safari"); await app.getAXState();' }));
  assert.deepEqual(collector.finish(["Finder", "Safari"]).appsUsed, ["finder", "safari"]);
  collector.onLine(event("c", { code: 'await app.unknown("PRIVATE");' }));
  collector.onLine(event("d", { code: 'await app.getAXState();' }));
  assert.equal(collector.finish().actions.at(-1)!.app, null);
  assert.doesNotMatch(JSON.stringify(collector.finish()), /PRIVATE/);
});

test("nested custom tool calls, malformed arguments and lifecycle argument changes fail closed", t => {
  const { collector, dir } = setup(t);
  collector.onLine(JSON.stringify({ type: "item.completed", item: { type: "custom_tool_call", input: 'await tools.mcp__cua_repl__js({code:"PRIVATE"})' } }));
  collector.onLine(event("a", "{PRIVATE"));
  collector.onLine(event("b", { code: 'const a = await cua.getApp("Finder");' }, undefined, "item.started"));
  collector.onLine(event("b", { code: 'const b = await cua.getApp("Mail");' }));
  collector.readRollout(writeRollout(dir, [rolloutRecord("response_item", { type: "custom_tool_call", name: "functions.exec", input: "PRIVATE" })]), "thread-1");
  const result = collector.finish();
  assert.ok(result.violations.includes("unauditable_nested_tool_call"));
  assert.ok(result.violations.includes("unparseable_call"));
  assert.ok(result.violations.includes("tool_arguments_changed"));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("images are validated, hashed, safely named and deduplicated across lifecycle and calls", t => {
  const { collector, dir } = setup(t, ["Finder"]);
  const bytes = png(); const result = { content: [image(bytes), image(bytes)] };
  collector.onLine(event("a", { code: 'const app = await cua.getApp("Finder"); await app.getScreenshot();' }, result, "item.updated"));
  collector.onLine(event("a", undefined, result));
  collector.onLine(event("b", { code: 'await app.getScreenshot();' }, result));
  attribute(t, collector, [call("a", 'const app = await cua.getApp("Finder"); await app.getScreenshot();'), call("b", 'await app.getScreenshot();')]);
  const evidence = collector.finish(["Finder"]);
  assert.equal(evidence.screenshots.length, 1);
  const screenshot = evidence.screenshots[0]!;
  assert.equal(screenshot.sha256, sha(bytes)); assert.equal(screenshot.bytes, bytes.length);
  assert.equal(basename(screenshot.path), `computer-use-${sha(bytes)}.png`);
  assert.ok(readFileSync(screenshot.path).equals(bytes));
  assert.deepEqual(readdirSync(dir), [basename(screenshot.path)]);
  assert.deepEqual(evidence.violations, []);
});

test("reject invalid base64, noncanonical encoding, MIME mismatch, corrupt images and paths", t => {
  const samples = [
    { type: "image", mimeType: "image/png", data: "%%%=" },
    { type: "image", mimeType: "image/png", data: "AB==" },
    { ...image(), mimeType: "image/jpeg" }, image(Buffer.from("PRIVATE")),
    { type: "image", image_url: "file:///PRIVATE/screen.png", path: "../../PRIVATE" },
    image(Buffer.concat([png(), Buffer.from("trailing")])),
    image(Buffer.alloc(2 * 1024 * 1024 + 1)),
  ];
  for (const block of samples) {
    const { collector, dir } = setup(t);
    collector.onLine(event("a", { code: 'await cua.getApp("Finder");' }, { content: [block] }));
    const result = collector.finish();
    assert.equal(result.screenshots.length, 0);
    assert.ok(result.violations.some(v => v.startsWith("screenshot_")));
    assert.deepEqual(readdirSync(dir), []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test("image data URL supported; unique screenshot count bounded to 20", t => {
  const { collector, dir } = setup(t);
  for (let i = 0; i < 21; i++) {
    collector.onLine(event(String(i), { code: 'await cua.getApp("Finder");' }, { content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png(i).toString("base64")}` } }] }));
  }
  attribute(t, collector, Array.from({ length: 21 }, (_, i) => call(String(i), 'await cua.getApp("Finder");')));
  assert.equal(collector.finish().screenshots.length, 20);
  assert.equal(readdirSync(dir).length, 20);
  assert.ok(collector.finish().violations.includes("screenshot_count_limit_exceeded"));
});

test("existing artifacts are reused without overwrite; symlinks never followed", t => {
  const { collector, dir } = setup(t);
  const bytes = png(); const path = join(dir, `computer-use-${sha(bytes)}.png`);
  const target = join(dir, "target.txt"); writeFileSync(target, "PRIVATE"); symlinkSync(target, path);
  collector.onLine(event("a", { code: 'await cua.getApp("Finder");' }, { content: [image(bytes)] }));
  attribute(t, collector, [call("a", 'await cua.getApp("Finder");')]);
  assert.equal(readFileSync(target, "utf8"), "PRIVATE");
  assert.equal(collector.finish().screenshots.length, 0);
  assert.ok(collector.finish().violations.includes("screenshot_write_failed_or_unsafe_path"));
  const other = setup(t);
  const existing = join(other.dir, `computer-use-${sha(bytes)}.png`); writeFileSync(existing, bytes);
  other.collector.onLine(event("a", { code: 'await cua.getApp("Finder");' }, { content: [image(bytes)] }));
  attribute(t, other.collector, [call("a", 'await cua.getApp("Finder");')]);
  assert.equal(other.collector.finish().screenshots.length, 1);
  assert.ok(readFileSync(existing).equals(bytes));
});

test("rollout matches actual session, dedups native calls one-to-one, ignores prior screenshots", t => {
  const { collector, dir } = setup(t, ["Finder"]);
  const code = 'const app = await cua.getApp("Finder"); await app.getScreenshot();';
  collector.onLine(event("native-1", { code }, { content: [image(png(1))] }));
  collector.onLine(event("native-2", { code }, { content: [image(png(2))] }));
  const file = writeRollout(dir, [
    call("old", 'const prior = await cua.getApp("Mail");', before), output("old", [image(png(3))], before),
    call("rollout-1", code), output("rollout-1", [image(png(1))]),
    call("rollout-2", code), output("rollout-2", [image(png(2))]),
    call("new", 'await app.click([1, 2]);'),
  ]);
  collector.readRollout(file, "thread-1"); collector.readRollout(file, "thread-1");
  const result = collector.finish(["Finder"]);
  assert.equal(result.actions.length, 5);
  assert.equal(result.screenshots.length, 2);
  assert.deepEqual(result.appsUsed, ["finder"]);
  assert.deepEqual(result.violations, []);
  assert.equal(readdirSync(dir).filter(f => f.startsWith("computer-use-")).length, 2);
});

test("backfill reconstructs old app handles without importing old evidence", t => {
  const { collector, dir } = setup(t, ["Finder"]);
  const file = writeRollout(dir, [
    call("old", 'const app = await cua.getApp("Finder");', before), output("old", [image(png(1))], before),
    call("new", 'await app.getAXState();'), output("new", [image(png(2))]),
  ]);
  collector.readRollout(file, "thread-1");
  assert.equal(collector.finish().actions.length, 1);
  assert.equal(collector.finish().screenshots[0]!.sha256, sha(png(2)));
  assert.deepEqual(collector.finish(["Finder"]).violations, []);
});

test("session mismatch and missing/invalid timestamps cannot import screenshots", t => {
  const { collector, dir } = setup(t);
  const records = [call("a", 'await cua.getApp("Finder");'), output("a", [image()])];
  collector.readRollout(writeRollout(dir, records, "different-thread"), "thread-1");
  assert.equal(collector.finish().screenshots.length, 0);
  assert.ok(collector.finish().violations.includes("rollout_session_mismatch"));
  collector.readRollout(writeRollout(dir, [call("a", 'await cua.getApp("Finder");', "invalid"), output("a", [image()])]), "thread-1");
  assert.equal(collector.finish().actions.length, 0);
  assert.equal(collector.finish().screenshots.length, 0);
  assert.ok(collector.finish().violations.includes("unauditable_timestamp"));
});

test("native resumed events before sinceMs are skipped; snapshots cannot mutate collector", t => {
  const { collector } = setup(t);
  collector.onLine(event("old", { code: 'await cua.getApp("Mail");' }, { content: [image()] }, "item.completed", before));
  collector.onLine(event("new", { code: 'await cua.getApp("Finder");' }));
  const first = collector.finish(["Finder"]); first.actions[0]!.app = "mail"; first.violations.push("injected");
  assert.deepEqual(collector.finish(["Finder"]).appsUsed, ["finder"]);
  assert.equal(collector.finish().actions[0]!.app, "finder");
  assert.equal(collector.finish().screenshots.length, 0);
  assert.deepEqual(collector.finish(["Finder"]).violations, []);
});

test("only actual image content is saved; JSON within a text block stays text", t => {
  const { collector, dir } = setup(t);
  collector.onLine(event("a", { code: 'await cua.getApp("Finder");' }, { content: [{ type: "text", text: JSON.stringify(image()) }] }));
  collector.onLine(event("b", { code: 'await cua.getApp("Finder");' }, { metadata: image() }));
  assert.equal(collector.finish().screenshots.length, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test("2 MiB image boundary is inclusive and validated without a base64 regex stack overflow", t => {
  const { collector } = setup(t);
  const bytes = png(0, 2 * 1024 * 1024 - png().length - 12);
  assert.equal(bytes.length, 2 * 1024 * 1024);
  collector.onLine(event("a", { code: 'await cua.getApp("Finder");' }, { content: [image(bytes)] }));
  attribute(t, collector, [call("a", 'await cua.getApp("Finder");')]);
  assert.equal(collector.finish().screenshots[0]!.bytes, bytes.length);
  assert.deepEqual(collector.finish(["Finder"]).violations, []);
});

test("backfill before stream dedups once, independent of title and argument key order", t => {
  const { collector, dir } = setup(t);
  const code = 'const app = await cua.getApp("Finder"); await app.getAXState();';
  collector.readRollout(writeRollout(dir, [call("rollout-a", code), call("rollout-b", code)]), "thread-1");
  collector.onLine(event("native-a", { title: "PRIVATE TITLE", code }));
  collector.onLine(event("native-a", { code, title: "OTHER PRIVATE TITLE" }));
  collector.onLine(event("native-b", { code }));
  assert.equal(collector.finish().actions.length, 4);
  assert.deepEqual(collector.finish(["Finder"]).violations, []);
  collector.onLine(event("new", { code }));
  assert.equal(collector.finish().actions.length, 6);
});

test("permission remains detectable when a completed native item has lost its arguments", t => {
  const { collector } = setup(t);
  collector.onLine(event("missing", undefined, { error: { message: "Computer Use was not approved to use Finder" } }));
  assert.deepEqual(collector.finish().permission, { kind: "app_permission", app: "Finder" });
  assert.ok(collector.finish().violations.includes("unauditable_missing_call_arguments"));
  assert.ok(collector.finish().violations.includes("app_permission_denied"));
});

test("installed native methods accept only literal awaited calls and keep input private", t => {
  const { collector } = setup(t, ["Calculator"]);
  collector.onLine(event("native", { code: `
    const app = await cua.getApp("com.apple.calculator");
    await app.getScreenshot(); await app.getAXState({disableDiffing: true});
    await app.getAXStateAndScreenshot(); await app.click(7); await app.click([10, 20]);
    await app.drag([10, 20], [30, 40]); await app.scroll(7, "down", 1);
    await app.typeText("PRIVATE typed"); await app.paste("PRIVATE pasted", {format: "text"});
    await app.setValue(7, "PRIVATE field"); await app.pressKey("super+a");
  ` }, { content: [{ type: "text", text: "PRIVATE native AX" }] }));
  const result = collector.finish(["Calculator.app"]);
  assert.deepEqual(result.appsUsed, ["calculator"]);
  assert.deepEqual(result.actions.map(action => action.kind), ["view", "view", "view", "view", "click", "click", "click", "scroll", "type", "type", "type", "shortcut"]);
  assert.deepEqual(result.violations, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|super\+a|disableDiffing/);
  for (const code of [
    'app.click(7);', 'await app.click(index);', 'await app.typeText("PRIVATE" + "suffix");',
    'await app.getState();', 'await app.screenshot();', 'await app.type("PRIVATE");',
    '// PRIVATE comment only', '/* PRIVATE */',
  ]) {
    const next = setup(t).collector;
    next.onLine(event("bind", { code: 'const app = await cua.getApp("Calculator");' }));
    next.onLine(event("unknown", { code }));
    next.onLine(event("after", { code: 'await app.getAXState();' }));
    assert.ok(next.finish().violations.includes("unparseable_call"), code);
    assert.equal(next.finish().actions.at(-1)!.app, null);
    assert.doesNotMatch(JSON.stringify(next.finish()), /PRIVATE/);
  }
});

test("Calculator aliases compare canonically while permission preserves its safe display name", t => {
  const { collector } = setup(t, ["com.apple.calculator"]);
  collector.onLine(event("denied", { code: 'await cua.getApp("Calculator");' }, {
    error: { message: "Computer Use was not approved to use Calculator\nPRIVATE STACK" },
  }));
  const result = collector.finish(["Calculator"]);
  assert.equal(canonicalAppId("com.apple.calculator"), canonicalAppId("Calculator"));
  assert.deepEqual(result.permission, { kind: "app_permission", app: "Calculator" });
  assert.deepEqual(result.appsUsed, ["calculator"]);
  assert.deepEqual(result.violations, ["app_permission_denied"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const unsafe = setup(t).collector;
  unsafe.onLine(event("denied", { code: 'await cua.getApp("Calculator");' }, {
    error: { message: "Computer Use was not approved to use /PRIVATE/screen" },
  }));
  assert.equal(unsafe.finish().permission, null);
  assert.ok(unsafe.finish().violations.includes("unauditable_permission_target"));
  assert.doesNotMatch(JSON.stringify(unsafe.finish()), /PRIVATE/);
});

test("native rollout namespace shape deduplicates with stream and reads paired outputs", t => {
  const { collector, dir } = setup(t, ["Calculator"]);
  const code = 'const app = await cua.getApp("Calculator"); await app.getAXStateAndScreenshot();';
  collector.onLine(event("stream", { code }));
  const file = writeRollout(dir, [
    rolloutRecord("response_item", { type: "function_call", name: "js", namespace: "mcp__cua_repl", call_id: "native", arguments: JSON.stringify({ code }) }),
    output("native", [image(), { type: "text", text: "Computer Use was not approved to use Calculator" }]),
  ]);
  collector.readRollout(file, "thread-1"); collector.readRollout(file, "thread-1");
  const result = collector.finish(["com.apple.calculator"]);
  assert.equal(result.actions.length, 2);
  assert.equal(result.screenshots.length, 1);
  assert.equal(result.permission, null);
  assert.deepEqual(result.violations, []);
});

test("other native and rollout tools invalidate app bindings and cannot succeed silently", t => {
  for (const item of [
    { type: "mcp_tool_call", server: "other", tool: "js" },
    { type: "mcp_tool_call", server: "cua_repl", tool: "unknown" },
    { type: "command_execution", command: "PRIVATE" },
    { type: "custom_tool_call", input: "PRIVATE" },
  ]) {
    const { collector } = setup(t);
    collector.onLine(event("bind", { code: 'let app = await cua.getApp("Calculator");' }));
    collector.onLine(JSON.stringify({ type: "item.started", timestamp: at, item }));
    collector.onLine(event("after", { code: 'await app.getAXState();' }));
    assert.ok(collector.finish().violations.some(v => v.startsWith("unauditable_")));
    assert.equal(collector.finish().actions.at(-1)!.app, null);
    assert.doesNotMatch(JSON.stringify(collector.finish()), /PRIVATE/);
  }
  for (const payload of [
    { type: "function_call", name: "js", namespace: "other" },
    { type: "function_call", name: "unknown", namespace: "mcp__cua_repl" },
    { type: "function_call", name: "exec_command" },
    { type: "custom_tool_call", name: "exec", input: "PRIVATE nested tools" },
  ]) {
    const { collector, dir } = setup(t);
    collector.readRollout(writeRollout(dir, [
      call("bind", 'let app = await cua.getApp("Calculator");'),
      rolloutRecord("response_item", payload), call("after", 'await app.getAXState();'),
    ]), "thread-1");
    assert.ok(collector.finish().violations.some(v => v.startsWith("unauditable_")));
    assert.equal(collector.finish().actions.at(-1)!.app, null);
    assert.doesNotMatch(JSON.stringify(collector.finish()), /PRIVATE/);
    const empty = setup(t);
    empty.collector.readRollout(writeRollout(empty.dir, [rolloutRecord("response_item", payload)]), "thread-1");
    assert.ok(empty.collector.finish().violations.length > 0);
  }
});

// Static 1x1 JPEG fixture, not an observed screenshot.
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAr/2Q==", "base64");
const jpegImage = (bytes = jpeg) => ({ type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") });

test("JPEG screenshots preserve bytes and reject truncated, empty or malformed containers", t => {
  const { collector } = setup(t);
  collector.onLine(event("jpeg", { code: 'await cua.getApp("Calculator");' }, { content: [jpegImage()] }));
  attribute(t, collector, [call("jpeg", 'await cua.getApp("Calculator");')]);
  const saved = collector.finish().screenshots[0]!;
  assert.ok(saved);
  assert.equal(saved.sha256, sha(jpeg));
  assert.ok(saved.path.endsWith(".jpg"));
  assert.ok(readFileSync(saved.path).equals(jpeg));
  assert.deepEqual(collector.finish(["Calculator"]).violations, []);
  for (const bytes of [jpeg.subarray(0, -2), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.concat([jpeg, Buffer.from("PRIVATE")]), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])]) {
    const next = setup(t).collector;
    next.onLine(event("bad", { code: 'await cua.getApp("Calculator");' }, { content: [jpegImage(bytes)] }));
    assert.equal(next.finish().screenshots.length, 0);
    assert.ok(next.finish().violations.includes("screenshot_invalid_format"));
  }
});

test("screenshot quota spans resumes, permits duplicates at capacity, and counts JPEG too", t => {
  const { collector, dir } = setup(t);
  collector.onLine(event("jpeg", { code: 'await cua.getApp("Calculator");' }, { content: [jpegImage()] }));
  for (let i = 0; i < 18; i++) collector.onLine(event(String(i), { code: 'await cua.getApp("Calculator");' }, { content: [image(png(i))] }));
  attribute(t, collector, ["jpeg", ...Array.from({ length: 18 }, (_, i) => String(i))].map(id => call(id, 'await cua.getApp("Calculator");')));
  collector.finish();
  const resumed = new ComputerUseCollector({ artifactsDir: dir, sinceMs });
  resumed.onLine(event("reuse", { code: 'await cua.getApp("Calculator");' }, { content: [image(png(0)), jpegImage(), image(png(18))] }));
  attribute(t, resumed, [call("reuse", 'await cua.getApp("Calculator");')]);
  resumed.finish();
  const resumedAgain = new ComputerUseCollector({ artifactsDir: dir, sinceMs });
  resumedAgain.onLine(event("last", { code: 'await cua.getApp("Calculator");' }, { content: [image(png(19)), jpegImage()] }));
  attribute(t, resumedAgain, [call("last", 'await cua.getApp("Calculator");')]);
  resumedAgain.finish();
  assert.equal(readdirSync(dir).length, 20);
  assert.equal(resumed.finish().screenshots.length, 3);
  assert.deepEqual(resumed.finish(["Calculator"]).violations, []);
  assert.equal(resumedAgain.finish().screenshots.length, 0);
  assert.ok(resumedAgain.finish().violations.includes("screenshot_count_limit_exceeded"));
});

test("quota recognizes only hash-matching owned regular images and rejects artifact directory symlinks", t => {
  const { collector, dir } = setup(t);
  const target = join(dir, "PRIVATE-target"); writeFileSync(target, "PRIVATE");
  for (let i = 0; i < 21; i++) {
    const path = join(dir, `computer-use-${sha(png(i))}.png`);
    if (i % 2) symlinkSync(target, path); else writeFileSync(path, "PRIVATE non-image");
  }
  // A valid unrelated image has no collector-owned name and consumes no quota.
  writeFileSync(join(dir, "unrelated.png"), png());
  collector.onLine(event("new", { code: 'await cua.getApp("Calculator");' }, { content: [image(png(99))] }));
  attribute(t, collector, [call("new", 'await cua.getApp("Calculator");')]);
  assert.equal(collector.finish().screenshots.length, 1);
  assert.deepEqual(collector.finish(["Calculator"]).violations, []);
  assert.equal(readFileSync(target, "utf8"), "PRIVATE");
  const link = join(dir, "linked-artifacts"); symlinkSync(dir, link);
  const unsafe = new ComputerUseCollector({ artifactsDir: link, sinceMs });
  unsafe.onLine(event("new", { code: 'await cua.getApp("Calculator");' }, { content: [image(png(100))] }));
  attribute(t, unsafe, [call("new", 'await cua.getApp("Calculator");')]);
  assert.equal(unsafe.finish().screenshots.length, 0);
  assert.ok(unsafe.finish().violations.includes("screenshot_write_failed_or_unsafe_path"));
  const unsafeParent = new ComputerUseCollector({ artifactsDir: join(link, "new-child"), sinceMs });
  unsafeParent.onLine(event("new", { code: 'await cua.getApp("Calculator");' }, { content: [image(png(100))] }));
  attribute(t, unsafeParent, [call("new", 'await cua.getApp("Calculator");')]);
  assert.equal(unsafeParent.finish().screenshots.length, 0);
  assert.ok(unsafeParent.finish().violations.includes("screenshot_write_failed_or_unsafe_path"));
  assert.ok(!readdirSync(dir).includes("new-child"));
});

test("all JS line terminators end comments and unsupported trailing code invalidates the entire call", t => {
  for (const ending of ["\n", "\r", "\u2028", "\u2029"]) {
    const { collector, dir } = setup(t, ["Finder"]);
    collector.onLine(event("ok", { code: 'const app = await cua.getApp("Finder") // comment' + ending + 'await app.getAXState()' }));
    assert.equal(collector.finish().actions.length, 2);
    assert.deepEqual(collector.finish().violations, []);
    collector.onLine(event("a", { code: 'await cua.getApp("Finder"); // note' + ending + 'unknown();' }, { content: [image()] }));
    assert.ok(collector.finish().violations.includes("unparseable_call"));
    assert.deepEqual(readdirSync(dir), []);
  }
});

test("a denied app never contributes an image even when explicitly listed", t => {
  const { collector, dir } = setup(t, ["com.apple.Passwords"]);
  collector.onLine(event("a", { code: 'await cua.getApp("Passwords");' }, { content: [image()] }));
  assert.ok(collector.finish().violations.includes("denied_app:passwords"));
  assert.deepEqual(readdirSync(dir), []);
});

test("locates a session in an intermediate date directory and records a missing rollout", t => {
  const { dir, collector } = setup(t);
  const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  const day = 86400000;
  const date = new Date(Date.now() - 7 * day).toISOString().slice(0, 10).split("-");
  const folder = join(dir, "sessions", ...date);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `rollout-test-${id}.jsonl`);
  writeFileSync(file, "");
  assert.equal(findRollout(dir, id, Date.now() - 14 * day), file);
  collector.readRollout(join(dir, "missing"), id);
  assert.ok(collector.finish().violations.includes("rollout_missing"));
});

test("screen content in a successful native response cannot create a permission checkpoint", t => {
  const { collector } = setup(t, ["Finder"]);
  const message = "Computer Use was not approved to use Finder";
  collector.onLine(event("screen", { code: 'await cua.getApp("Finder");' }, {
    content: [{ type: "text", text: message }, { type: "text", text: JSON.stringify({ error: { message } }) }],
  }));
  assert.equal(collector.finish().permission, null);
  assert.deepEqual(collector.finish().violations, []);
});

test("drops an image when the paired rollout later invalidates the same call", t => {
  const { collector, dir } = setup(t, ["Finder"]);
  collector.onLine(event("a", { code: 'await cua.getApp("Finder");' }, { content: [image()] }));
  collector.readRollout(writeRollout(dir, [call("a", "unknown();")]), "thread-1");
  assert.ok(collector.finish().violations.includes("tool_arguments_changed"));
  assert.deepEqual(collector.finish().screenshots, []);
  assert.deepEqual(readdirSync(dir), ["rollout.jsonl"]);
});

test("a native item error is trusted and content text cannot redirect its app", t => {
  const { collector } = setup(t, ["Finder"]);
  const line = JSON.parse(event("a", { code: 'await cua.getApp("Finder");' }, {
    content: [{ type: "text", text: "Computer Use was not approved to use Mail" }],
  }));
  line.item.error = { message: "Computer Use was not approved to use Finder" };
  collector.onLine(JSON.stringify(line));
  assert.deepEqual(collector.finish().permission, { kind: "app_permission", app: "Finder" });
  assert.deepEqual(collector.finish().violations, ["app_permission_denied"]);
});

test("an unreadable rollout and an in-window output with no call fail the audit", t => {
  const { dir, collector } = setup(t, ["Finder"]);
  collector.readRollout(writeRollout(dir, [output("unknown", [image()])]), "thread-1");
  assert.ok(collector.finish().violations.includes("unparseable_call"));
  const truncated = writeRollout(dir, ['{"type":']);
  collector.readRollout(truncated, "thread-1");
  assert.ok(collector.finish().violations.includes("rollout_missing"));
  assert.deepEqual(collector.finish().screenshots, []);
});

test("Codex 0.166 Calculator denial uses the failed MCP content envelope", t => {
  const { collector } = setup(t, ["Calculator"]);
  const line = JSON.parse(event("a", { code: 'await cua.getApp("Calculator");' }, {
    content: [{ type: "text", text: "Computer Use was not approved to use Calculator" }], isError: true,
  }));
  line.item.status = "failed";
  collector.onLine(JSON.stringify(line));
  assert.deepEqual(collector.finish().permission, { kind: "app_permission", app: "Calculator" });
});

for (const mode of ["absent", "invalid JSON", "wrong session", "metadata only", "different call"]) {
  test(`stream screenshot stays private with ${mode} rollout`, t => {
    const { collector, dir } = setup(t);
    const code = 'await cua.getApp("Finder");';
    collector.onLine(event("screen", { code }, { content: [image()] }));
    const records = mode === "invalid JSON" ? ["{"] : mode === "different call" ? [call("other", 'await cua.getApp("Calculator");')] : [call("screen", code)];
    if (mode === "absent") collector.auditSession(dir, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    else collector.readRollout(writeRollout(dir, mode === "metadata only" ? [] : records, mode === "wrong session" ? "other" : "thread-1"), "thread-1");
    const result = collector.finish();
    assert.ok(result.actions.length > 0);
    assert.deepEqual(result.screenshots, []);
    assert.ok(!readdirSync(dir).some(name => name.startsWith("computer-use-")));
  });
}

test("compressed rollouts retain identity and decompressed size checks", { skip: typeof zlib.zstdCompressSync !== "function" }, t => {
  const { dir, collector } = setup(t);
  const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  const day = new Date(sinceMs).toISOString().slice(0, 10).split("-");
  const folder = join(dir, "sessions", ...day);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `rollout-test-${id}.jsonl.zst`);
  writeFileSync(file, zlib.zstdCompressSync([rolloutRecord("session_meta", { id }), rolloutRecord("turn_context", { model: "test-model" })].join("\n")));
  assert.equal(findRollout(dir, id, sinceMs), file);
  assert.equal(readRolloutEvidence(file, id, dir)?.model, "test-model");
  writeFileSync(file, zlib.zstdCompressSync(rolloutRecord("session_meta", { id: "other" })));
  assert.equal(readRolloutEvidence(file, id, dir), null);
  collector.auditSession(dir, id);
  assert.ok(collector.finish().violations.includes("rollout_session_mismatch"));
  writeFileSync(file, zlib.zstdCompressSync(Buffer.alloc(64 * 1024 * 1024 + 1)));
  collector.auditSession(dir, id);
  assert.ok(collector.finish().violations.includes("rollout_size_limit_exceeded"));
});

test("the matching native rollout completion also records Calculator's denial", t => {
  const { collector, dir } = setup(t, ["Calculator"]);
  collector.readRollout(writeRollout(dir, [
    call("a", 'await cua.getApp("Calculator");'),
    rolloutRecord("event_msg", { type: "item_completed", item: {
      type: "McpToolCall", id: "a", server: "cua_repl", tool: "js", status: "failed",
      result: { content: [{ type: "text", text: "Computer Use was not approved to use Calculator" }], isError: true },
    } }),
  ]), "thread-1");
  assert.deepEqual(collector.finish().permission, { kind: "app_permission", app: "Calculator" });
});

test("a runtime without native zstd diagnoses the archive before parsing any bytes", t => {
  const { collector, dir } = setup(t);
  const file = join(dir, "rollout.jsonl.zst");
  writeFileSync(file, "invalid archive");
  const builtin = createRequire(import.meta.url)("node:zlib");
  const decoder = builtin.zstdDecompressSync;
  try {
    builtin.zstdDecompressSync = undefined;
    syncBuiltinESMExports();
    collector.readRollout(file, "thread-1");
    assert.deepEqual(collector.finish().violations, ["rollout_zstd_unavailable"]);
  } finally {
    if (decoder === undefined) delete builtin.zstdDecompressSync;
    else builtin.zstdDecompressSync = decoder;
    syncBuiltinESMExports();
  }
});

test("a validated session authorizes pixels only for the matching call", t => {
  const { collector, dir } = setup(t);
  const code = 'await cua.getApp("Finder");';
  collector.onLine(event("first", { code }, { content: [image(png(1))] }));
  collector.onLine(event("second", { code }, { content: [image(png(2))] }));
  collector.readRollout(writeRollout(dir, [call("second", code)]), "thread-1");
  const evidence = collector.finish();
  assert.equal(evidence.actions.length, 2);
  assert.deepEqual(evidence.screenshots.map(entry => entry.sha256), [sha(png(2))]);
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith(".png")), [`computer-use-${sha(png(2))}.png`]);
});

test("compressed rollout reads every zstd frame and refuses a truncated one", { skip: typeof zlib.zstdCompressSync !== "function" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "duo-zst-"));
  try {
    const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
    const big = "x".repeat(300_000) + "\n"; // várias blocks por frame
    const a = zlib.zstdCompressSync(Buffer.from('{"a":1}\n' + big), opts), b = zlib.zstdCompressSync(Buffer.from('{"b":2}\n'));
    const skip = Buffer.alloc(12); skip.writeUInt32LE(0x184d2a50, 0); skip.writeUInt32LE(4, 4);
    const file = join(dir, "r.jsonl.zst");
    writeFileSync(file, Buffer.concat([a, skip, b]));
    const text = readBoundedRollout(file);
    assert.ok(text.startsWith('{"a":1}') && text.endsWith('{"b":2}\n'), "o segundo frame não pode sumir");
    for (const cut of [1, 4, 10]) {
      writeFileSync(file, Buffer.concat([a, b]).subarray(0, a.length + b.length - cut));
      assert.throws(() => readBoundedRollout(file), /rollout_zstd_invalid/, `truncado em ${cut} bytes`);
    }
    writeFileSync(file, a.subarray(0, a.length - 2));
    assert.throws(() => readBoundedRollout(file), /rollout_zstd_invalid/);
    writeFileSync(file, Buffer.alloc(0));
    assert.throws(() => readBoundedRollout(file), /rollout_zstd_invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
