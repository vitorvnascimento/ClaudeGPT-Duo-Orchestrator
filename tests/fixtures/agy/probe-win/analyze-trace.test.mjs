// O analyze-trace.mjs lê os dois formatos: o results.json da sonda da Fase 0 e o trace.json da bateria do duo.
// Roda em qualquer SO: o perfil "Windows" vem de HOME/APPDATA/LOCALAPPDATA falsos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./analyze-trace.mjs", import.meta.url));
const HOME = "C:\\Users\\v";
const LOCAL = `${HOME}\\AppData\\Local`;
const env = { ...process.env, HOME, USERPROFILE: HOME, APPDATA: `${HOME}\\AppData\\Roaming`, LOCALAPPDATA: LOCAL };
const csv = (rows) => ['"Time of Day","Process Name","PID","Operation","Path","Result","Detail"', ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
const born = (parent, pid) => ["09:00:00", "node.exe", String(parent), "Process Create", "C:\\agy\\agy.exe", "SUCCESS", `PID: ${pid}, Command line: agy`];
const read = (pid, path) => ["09:00:01", "agy.exe", String(pid), "ReadFile", path, "SUCCESS", ""];
const died = (pid) => ["09:00:02", "agy.exe", String(pid), "Process Exit", "", "SUCCESS", "Exit Status: 0"];

function analyze(rows, results) {
  const dir = mkdtempSync(join(tmpdir(), "analyze-trace-"));
  writeFileSync(join(dir, "t.csv"), csv(rows));
  writeFileSync(join(dir, "r.json"), JSON.stringify(results));
  return spawnSync(process.execPath, [cli, join(dir, "t.csv"), join(dir, "r.json")], { env, encoding: "utf8" });
}

test("formato da Fase 0 (probePid + root): limpo dá OK, ~/.gemini dá PROIBIDO", () => {
  const res = { probePid: 50, root: "%USERPROFILE%\\AppData\\Local\\duo-probe-win\\run1", launches: [{ pid: 100, image: "agy.exe", label: "models" }] };
  const ok = analyze([born(50, 100), read(100, `${LOCAL}\\duo-probe-win\\run1\\home\\a`), died(100)], res);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = analyze([born(50, 100), read(100, `${HOME}\\.gemini\\settings.json`), died(100)], res);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
});

test("formato da bateria do duo (lançadores + pastas por lançamento): OK, PROIBIDO e INCOMPLETO", () => {
  const state = `${LOCAL}\\duo\\gemini-state`;
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const res = { stateRoot: "%USERPROFILE%\\AppData\\Local\\duo\\gemini-state", launches: [
    { launcher: { pid: 60, image: node }, pid: 100, image: "agy.exe", label: "doctor", allowedRoots: ["%USERPROFILE%\\AppData\\Local\\duo\\gemini-state\\probe\\m1"] },
    { launcher: { pid: 61, image: node }, pid: 101, image: "agy.exe", label: "delegate agy", allowedRoots: ["%USERPROFILE%\\AppData\\Local\\duo\\gemini-state\\c\\home", "C:\\proj\\wt"] },
  ] };
  const both = (r100, r101) => [born(60, 100), read(100, r100), died(100), born(61, 101), read(101, r101), died(101)];
  const ok = analyze(both(`${state}\\probe\\m1\\x`, "C:\\proj\\wt\\a.ts"), res);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const cross = analyze(both("C:\\proj\\wt\\a.ts", "C:\\proj\\wt\\a.ts"), res);
  assert.equal(cross.status, 1, cross.stdout + cross.stderr);
  const missing = analyze([born(60, 100), read(100, `${state}\\probe\\m1\\x`), died(100)], res);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /INCOMPLETO/);
  const noRoots = analyze([], { ...res, launches: [{ ...res.launches[0], allowedRoots: [] }] });
  assert.equal(noRoots.status, 2);
});
