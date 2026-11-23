// Testes dos helpers puros do teste de fatos do Gemini no Windows. Rodam em qualquer SO (usam path.win32).
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, privateEnv, authVerdict, hookCommand, analyzeTrace, resolveAgy } from "./lib.mjs";

test("redact: e-mail, token longo e pasta do perfil", () => {
  const tok = "a".repeat(20) + "B9_-" + "c".repeat(16);
  const out = redact(`user ana@example.com key ${tok} at C:\\Users\\Vitor\\x`, "c:\\users\\vitor");
  assert.equal(out, "user <email> key <token> at %USERPROFILE%\\x");
});

test("privateEnv: limpa cobrança do Google em qualquer caixa e troca o perfil", () => {
  const env = privateEnv({ Path: "x", gemini_api_key: "k", GOOGLE_CLOUD_PROJECT: "p", Agy_Adc_Auth: "1", userprofile: "C:\\real", temp: "C:\\t" }, "R");
  for (const k of ["gemini_api_key", "GOOGLE_CLOUD_PROJECT", "Agy_Adc_Auth", "userprofile", "temp"]) assert.equal(k in env, false, k);
  assert.equal(env.USERPROFILE, "R\\home");
  assert.equal(env.HOME, "R\\home");
  assert.equal(env.APPDATA, "R\\home\\AppData\\Roaming");
  assert.equal(env.LOCALAPPDATA, "R\\home\\AppData\\Local");
  assert.equal(env.TEMP, "R\\tmp");
  assert.equal(env.TMP, "R\\tmp");
  assert.equal(env.Path, "x");
});

test("authVerdict: só consumer sem sinal de API/nuvem prossegue", () => {
  const ok = "x authMethod=consumer y\nChainedAuth: authenticated via keyring (effective: keyring)\n";
  assert.equal(authVerdict(ok).verdict, "proceed");
  assert.equal(authVerdict(ok + "authMethod=api_key\n").verdict, "stop");
  assert.equal(authVerdict("authMethod=consumer\nauthenticated via adc (effective: adc)\n").verdict, "stop");
  assert.equal(authVerdict("").verdict, "stop");
  assert.deepEqual(authVerdict(ok).methods, ["consumer"]);
  assert.equal(authVerdict(ok).lines.length, 2);
});

test("hookCommand: aspas duplas em cada parte; recusa caracteres do cmd", () => {
  assert.equal(hookCommand("C:\\n\\node.exe", "C:\\p\\h.mjs", ["C:\\l\\log.jsonl"]), '"C:\\n\\node.exe" "C:\\p\\h.mjs" "C:\\l\\log.jsonl"');
  for (const c of ["%", "^", "&", '"', "!", "\n"]) {
    assert.throws(() => hookCommand("C:\\n\\node.exe", `C:\\p${c}x\\h.mjs`, []), /caractere não suportado/, JSON.stringify(c));
  }
});

test("analyzeTrace: CSV do Procmon com vírgula entre aspas", () => {
  const csv = [
    '"Time of Day","Process Name","PID","Operation","Path","Result","Detail"',
    '"10:00:00","agy.exe","100","CreateFile","C:\\R\\home\\.gemini\\a","SUCCESS",""',
    '"10:00:01","agy.exe","100","ReadFile","C:\\Users\\v\\.gemini\\x, y","SUCCESS","Offset: 0, Length: 4"',
    '"10:00:02","node.exe","101","QueryOpen","C:\\Windows\\a.dll","SUCCESS",""',
  ].join("\r\n");
  const { hits } = analyzeTrace(csv, ["c:\\users\\v\\.gemini"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "C:\\Users\\v\\.gemini\\x, y");
  assert.equal(hits[0].op, "ReadFile");
  assert.equal(hits[0].pid, "100");
});

test("resolveAgy: exe, shim .cmd com js e ausente", () => {
  assert.deepEqual(resolveAgy("C:\\agy\\agy.exe\r\n", () => ""), { kind: "exe", path: "C:\\agy\\agy.exe", script: null });
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\agy\\cli.js" %*\r\n';
  assert.deepEqual(resolveAgy("C:\\npm\\agy.cmd\r\n", () => shim), { kind: "cmd-js", path: "C:\\npm\\agy.cmd", script: "C:\\npm\\node_modules\\agy\\cli.js" });
  assert.equal(resolveAgy("C:\\npm\\agy.cmd\r\n", () => "@echo off\r\nfoo.exe %*").kind, "cmd-other");
  assert.deepEqual(resolveAgy("", () => ""), { kind: "missing", path: null, script: null });
});
