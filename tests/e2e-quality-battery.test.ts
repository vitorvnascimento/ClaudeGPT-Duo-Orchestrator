// Exercita o Q8 real offline; qualquer processo filho inesperado falha o teste.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const ids = [...Array.from({ length: 15 }, (_, i) => `T${i + 1}`), "A1", "P1"];
const valid = () => ids.map((id) => ({ id, pass: true }));

// O script verifica o shim com zsh antes de selecionar Q8. Simule somente essa
// verificação e impeça qualquer outra execução de processo dentro do gate.
const preload = `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
cp.spawnSync = (file) => {
  if (file !== "/bin/zsh") throw new Error("processo inesperado: " + file);
  const base = process.argv[process.argv.indexOf("--base") + 1];
  return { status: 0, stdout: join(base, ".duo-bin", "duo") + "\\n", stderr: "" };
};
cp.spawn = cp.execFileSync = () => { throw new Error("processo inesperado"); };
syncBuiltinESMExports();`;

function runBattery(content: string, expectedScore: number) {
  const root = mkdtempSync(join(tmpdir(), "duo-q8-"));
  try {
    const fixture = join(root, "battery.json"), base = join(root, "run");
    writeFileSync(fixture, content);
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, join(process.cwd(), "tests/e2e/quality-test.mjs"), "--confirm-quota", "--base", base, "--only", "Q8", "--battery", fixture], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    assert.equal(result.status, expectedScore === 8 ? 0 : 1, result.stdout + result.stderr);
    const reports = readdirSync(base).filter((name) => /^quality-.*\.json$/.test(name));
    assert.equal(reports.length, 1, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(join(base, reports[0]!), "utf8")) as { total: number; max: number; results: { id: string; score: number; ok: boolean }[] };
    assert.equal(report.total, expectedScore);
    assert.equal(report.max, 8);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]?.id, "Q8");
    assert.equal(report.results[0]?.score, expectedScore);
    assert.equal(report.results[0]?.ok, expectedScore === 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("gate Q8 da bateria E2E", () => {
  it("aceita IDs distintos aprovados nos formatos suportados", () => {
    const mixed = ids.map((id, i) => i % 3 === 0 ? { id, ok: true } : i % 3 === 1 ? { id, passed: true } : { id, pass: true });
    for (const input of [valid(), { results: mixed }, { scenarios: [...valid()].reverse() }]) {
      runBattery(JSON.stringify(input), 8);
    }
  });

  it("recusa duplicatas, IDs desconhecidos, ausências e falhas", () => {
    for (const input of [
      Array.from({ length: 17 }, () => ({ id: "P1", pass: true })),
      [...valid().slice(0, 16), { id: "T1", pass: true }],
      [...valid().slice(0, 16), { id: "X1", pass: true }],
      valid().slice(0, 16),
      [...valid(), { id: "X1", pass: true }],
      [...valid().slice(0, 16), { id: "P1", pass: false }],
      [...valid().slice(0, 16), { id: "P1", ok: false, pass: true }],
    ]) runBattery(JSON.stringify(input), 0);
  });

  it("recusa estruturas e aprovações inválidas", () => {
    for (const input of [
      "{", "null", JSON.stringify({ results: {} }), JSON.stringify({ scenarios: "invalid" }),
      JSON.stringify([...valid().slice(0, 16), null]),
      JSON.stringify([...valid().slice(0, 16), { id: "P1", pass: "true" }]),
      JSON.stringify([...valid().slice(0, 16), { id: "P1", pass: 1 }]),
      JSON.stringify([...valid().slice(0, 16), { pass: true }]),
    ]) runBattery(input, 0);
  });
});
