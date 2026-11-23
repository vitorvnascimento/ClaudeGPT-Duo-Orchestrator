// Hooks de sonda: cada um registra a chamada e responde de um jeito (libera, nega, trava, lixo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = new URL("./hooks/", import.meta.url);
const input = JSON.stringify({ toolCall: { name: "write_file", args: { path: "a.txt" } }, modelName: "m" });

function run(name) {
  const log = join(mkdtempSync(join(tmpdir(), "probe-hook-")), "log.jsonl");
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(`${name}.mjs`, dir)), log], { input, encoding: "utf8", timeout: 10_000 });
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { r, lines };
}

for (const [name, expectOut] of [
  ["allow-log", { decision: "allow", reason: "probe" }],
  ["deny", { decision: "deny", reason: "probe-deny" }],
]) {
  test(`${name}: decisão e log`, () => {
    const { r, lines } = run(name);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), expectOut);
    assert.equal(lines[0].hook, name);
    assert.equal(lines[0].toolName, "write_file");
    assert.equal(lines[0].modelName, "m");
    assert.deepEqual(lines[0].args, { path: "a.txt" });
  });
}

test("crash: registra e sai com erro, sem stdout", () => {
  const { r, lines } = run("crash");
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(lines[0].hook, "crash");
});

test("garbage: registra e responde texto que não é JSON", () => {
  const { r, lines } = run("garbage");
  assert.equal(r.stdout, "not json");
  assert.equal(lines[0].hook, "garbage");
});

test("stdin inválido fica registrado com o motivo", () => {
  const log = join(mkdtempSync(join(tmpdir(), "probe-hook-")), "log.jsonl");
  spawnSync(process.execPath, [fileURLToPath(new URL("deny.mjs", dir)), log], { input: "isto não é json", encoding: "utf8", timeout: 10_000 });
  const line = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(line.stdinError, "SyntaxError");
  assert.equal(line.toolName, null);
});
