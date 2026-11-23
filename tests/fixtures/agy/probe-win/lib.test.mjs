// Testes dos helpers puros do teste de fatos do Gemini no Windows. Rodam em qualquer SO (usam path.win32).
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, privateEnv, authVerdict, hookCommand, createTraceAnalyzer, resolveAgy, parseStream, classifyRun } from "./lib.mjs";

test("redact: e-mail, token longo e pasta do perfil em todas as grafias", () => {
  const tok = "a".repeat(20) + "B9_-" + "c".repeat(16);
  const out = redact(`user ana@example.com key ${tok} at C:\\Users\\Vitor\\x`, "c:\\users\\vitor");
  assert.equal(out, "user <email> key <token> at %USERPROFILE%\\x");
  assert.equal(redact("file:///C:/Users/Vitor/a.js", "C:\\Users\\Vitor"), "file:///%USERPROFILE%/a.js");
  assert.equal(redact('{"p":"C:\\\\Users\\\\Vitor\\\\a"}', "C:\\Users\\Vitor"), '{"p":"%USERPROFILE%\\\\a"}');
  assert.equal(redact("C:/Users/Jo%C3%A3o/a", "C:\\Users\\João"), "%USERPROFILE%/a");
});

test("privateEnv: limpa cobrança do Google em qualquer caixa e troca o perfil inteiro", () => {
  const env = privateEnv({ Path: "x", gemini_api_key: "k", GOOGLE_CLOUD_PROJECT: "p", Agy_Adc_Auth: "1", userprofile: "C:\\real", temp: "C:\\t", HomePath: "\\Users\\v" }, "D:\\R");
  for (const k of ["gemini_api_key", "GOOGLE_CLOUD_PROJECT", "Agy_Adc_Auth", "userprofile", "temp", "HomePath"]) assert.equal(k in env, false, k);
  assert.equal(env.USERPROFILE, "D:\\R\\home");
  assert.equal(env.HOME, "D:\\R\\home");
  assert.equal(env.APPDATA, "D:\\R\\home\\AppData\\Roaming");
  assert.equal(env.LOCALAPPDATA, "D:\\R\\home\\AppData\\Local");
  assert.equal(env.TEMP, "D:\\R\\tmp");
  assert.equal(env.TMP, "D:\\R\\tmp");
  assert.equal(env.HOMEDRIVE, "D:");
  assert.equal(env.HOMEPATH, "\\R\\home");
  assert.equal(env.Path, "x");
});

test("authVerdict: só consumer com fonte reconhecida prossegue; fonte nova vai para revisão", () => {
  const ok = "x authMethod=consumer y\nChainedAuth: authenticated via keyring (effective: keyring)\n";
  assert.equal(authVerdict(ok).verdict, "proceed");
  assert.equal(authVerdict(ok + "authMethod=api_key\n").verdict, "stop");
  assert.equal(authVerdict(ok + "authMethod=API_KEY\n").verdict, "stop");
  assert.equal(authVerdict(ok + "(effective: API key)\n").verdict, "stop");
  assert.equal(authVerdict("authMethod=consumer\nauthenticated via adc (effective: adc)\n").verdict, "stop");
  assert.equal(authVerdict("authMethod=consumer\n").verdict, "stop");
  assert.equal(authVerdict("authMethod=consumer\n(effective: wincred)\n").verdict, "review");
  assert.equal(authVerdict("").verdict, "stop");
  assert.deepEqual(authVerdict(ok).methods, ["consumer"]);
  assert.equal(authVerdict(ok).lines.length, 2);
});

test("hookCommand: sem aspas quando não há espaço; aspas com espaço; recusa caracteres do cmd e do PowerShell", () => {
  assert.equal(hookCommand(["node", "C:\\p\\h.mjs", "C:\\l\\log.jsonl"]), "node C:\\p\\h.mjs C:\\l\\log.jsonl");
  assert.equal(hookCommand(["node", "C:\\a b\\h.mjs"]), 'node "C:\\a b\\h.mjs"');
  for (const c of ["%", "^", "&", '"', "!", "$", "`", "'", "\n"]) {
    assert.throws(() => hookCommand(["node", `C:\\p${c}x\\h.mjs`]), /caractere não suportado/, JSON.stringify(c));
  }
});

const HEADER = '"Time of Day","Process Name","PID","Operation","Path","Result","Detail"';
const row = (t, p, pid, op, path, detail = "") => [t, p, pid, op, path, "SUCCESS", detail].map((c) => `"${c}"`).join(",");
const analyze = (lines, launchPids) => {
  const a = createTraceAnalyzer({ launchPids, forbidden: ["C:\\Users\\v\\.gemini", "C:\\Users\\v\\AppData\\Local"], allowed: ["C:\\Users\\v\\AppData\\Local\\duo-probe-win"] });
  for (const l of [HEADER, ...lines]) a.line(l);
  return a.result();
};

test("trace: só conta a árvore dos processos lançados; a sonda e outros processos ficam de fora", () => {
  const r = analyze([
    row("10:00:00", "node.exe", "50", "ReadFile", "C:\\Users\\v\\.gemini\\x"), // a própria sonda
    row("10:00:01", "agy.exe", "100", "CreateFile", "C:\\Users\\v\\AppData\\Local\\duo-probe-win\\r\\home\\a"),
    row("10:00:02", "agy.exe", "100", "Process Create", "C:\\Windows\\cmd.exe", "PID: 200, Command line: cmd /c node h.mjs"),
    row("10:00:03", "cmd.exe", "200", "ReadFile", "C:\\Users\\v\\.gemini\\settings, old.json", "Offset: 0, Length: 4"),
    row("10:00:04", "svchost.exe", "300", "ReadFile", "C:\\Users\\v\\.gemini\\y"),
  ], [100]);
  assert.equal(r.verdict, "forbidden");
  assert.deepEqual(r.hits.map((h) => [h.pid, h.path]), [["200", "C:\\Users\\v\\.gemini\\settings, old.json"]]);
});

test("trace: Process Start do filho também liga à árvore", () => {
  const r = analyze([
    row("10:00:00", "agy.exe", "100", "CreateFile", "C:\\Windows\\a"),
    row("10:00:01", "helper.exe", "201", "Process Start", "", "Parent PID: 100, Command line: helper"),
    row("10:00:02", "helper.exe", "201", "ReadFile", "C:\\Users\\v\\AppData\\Local\\Antigravity\\c"),
  ], [100]);
  assert.equal(r.verdict, "forbidden");
  assert.equal(r.hits[0].pid, "201");
});

test("trace: limpo só com todos os lançamentos cobertos; vazio ou cortado é incompleto", () => {
  assert.equal(analyze([row("10:00:00", "agy.exe", "100", "CreateFile", "C:\\Windows\\a")], [100]).verdict, "ok");
  assert.equal(analyze([], [100]).verdict, "incomplete");
  const cut = analyze([row("10:00:00", "agy.exe", "100", "CreateFile", "C:\\Windows\\a")], [100, 101]);
  assert.equal(cut.verdict, "incomplete");
  assert.deepEqual(cut.missingPids, ["101"]);
});

test("resolveAgy: exe, shim .cmd com js, launcher sem extensão antes do .cmd, ausente", () => {
  assert.deepEqual(resolveAgy("C:\\agy\\agy.exe\r\n", () => ""), { kind: "exe", path: "C:\\agy\\agy.exe", script: null });
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\agy\\cli.js" %*\r\n';
  assert.deepEqual(resolveAgy("C:\\npm\\agy.cmd\r\n", () => shim), { kind: "cmd-js", path: "C:\\npm\\agy.cmd", script: "C:\\npm\\node_modules\\agy\\cli.js" });
  assert.deepEqual(resolveAgy("C:\\npm\\agy\r\nC:\\npm\\agy.cmd\r\n", () => shim), { kind: "cmd-js", path: "C:\\npm\\agy.cmd", script: "C:\\npm\\node_modules\\agy\\cli.js" });
  assert.equal(resolveAgy("C:\\npm\\agy.cmd\r\n", () => "@echo off\r\nfoo.exe %*").kind, "cmd-other");
  assert.deepEqual(resolveAgy("", () => ""), { kind: "missing", path: null, script: null });
});

const step = (tool, state, path, message = "") => JSON.stringify({ event: "step_update", step_update: { tool_name: tool, state, tool_info: { parameters: { Path: path }, ...(message ? { error: { message } } : {}) } } });
const hookLine = (path) => ({ toolName: "write_file", args: { Path: path } });
const T = "probe-deny.txt";

test("classifyRun: negação só conta com o alvo no hook e o erro típico daquele hook no stream", () => {
  const denied = parseStream([step("write_file", "ERROR", `C:\\ws\\${T}`, "tool call denied by pre-tool hook: probe-deny")].join("\n"));
  assert.equal(classifyRun("deny", { target: T, fileExists: false, hookLines: [hookLine(`C:\\ws\\${T}`)], steps: denied.steps }), "pass");
  // Erro comum do sistema de arquivos depois de um hook que liberou: não é prova.
  const fsErr = parseStream(step("write_file", "ERROR", `C:\\ws\\${T}`, "open C:\\ws\\probe-deny.txt: Access is denied."));
  assert.equal(classifyRun("deny", { target: T, fileExists: false, hookLines: [hookLine(`C:\\ws\\${T}`)], steps: fsErr.steps }), "inconclusive");
  // Erro do hook em outro caminho: não é prova para o alvo.
  const other = parseStream(step("write_file", "ERROR", "C:\\ws\\other.txt", "tool call denied by pre-tool hook: probe-deny"));
  assert.equal(classifyRun("deny", { target: T, fileExists: false, hookLines: [hookLine("C:\\ws\\other.txt")], steps: other.steps }), "inconclusive");
  assert.equal(classifyRun("deny", { target: T, fileExists: true, hookLines: [], steps: [] }), "fail");
  const crash = parseStream(step("write_file", "ERROR", "C:\\ws\\probe-crash.txt", 'JSON hook "jsonhook__probe_PreToolUse_0_0" failed: command failed: exit status 1, stderr:'));
  assert.equal(classifyRun("crash", { target: "probe-crash.txt", fileExists: false, hookLines: [hookLine("C:\\ws\\probe-crash.txt")], steps: crash.steps }), "pass");
  const garbage = parseStream(step("write_file", "ERROR", "C:\\ws\\probe-garbage.txt", "failed to unmarshal result from hook jsonhook__probe_PreToolUse_0_0 via protojson: not json"));
  assert.equal(classifyRun("garbage", { target: "probe-garbage.txt", fileExists: false, hookLines: [hookLine("C:\\ws\\probe-garbage.txt")], steps: garbage.steps }), "pass");
});

test("classifyRun: controle allow-log separa hook que não rodou, comando do hook quebrado e modelo que não tentou", () => {
  const A = "probe-allow-log.txt";
  const done = parseStream(step("write_file", "DONE", `C:\\ws\\${A}`));
  assert.equal(classifyRun("allow-log", { target: A, fileExists: true, hookLines: [hookLine(`C:\\ws\\${A}`)], steps: done.steps }), "pass");
  assert.equal(classifyRun("allow-log", { target: A, fileExists: true, hookLines: [], steps: done.steps }), "hook-not-run");
  const broken = parseStream(step("write_file", "ERROR", `C:\\ws\\${A}`, 'JSON hook "jsonhook__probe_PreToolUse_0_0" failed: command failed: exit status 1'));
  assert.equal(classifyRun("allow-log", { target: A, fileExists: false, hookLines: [], steps: broken.steps }), "hook-cmd-failed");
  assert.equal(classifyRun("allow-log", { target: A, fileExists: false, hookLines: [], steps: [] }), "inconclusive");
  assert.equal(classifyRun("allow-log", { target: A, fileExists: true, hookLines: [{ toolName: "list_dir", args: { Path: "." } }], steps: done.steps }), "hook-not-run");
});
