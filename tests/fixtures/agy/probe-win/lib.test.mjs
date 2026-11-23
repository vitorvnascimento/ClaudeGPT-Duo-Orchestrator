// Testes dos helpers puros do teste de fatos do Gemini no Windows. Rodam em qualquer SO (usam path.win32).
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, privateEnv, authVerdict, hookCommand, createTraceAnalyzer, resolveAgy, parseStream, classifyRun, summarizeAlive } from "./lib.mjs";

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

test("hookCommand: executável sem aspas, argumentos sempre entre aspas; recusa caracteres do cmd e do PowerShell", () => {
  assert.equal(hookCommand(["node", "C:\\p\\h.mjs", "C:\\l\\log.jsonl"]), 'node "C:\\p\\h.mjs" "C:\\l\\log.jsonl"');
  assert.equal(hookCommand(["node", "C:\\a b;c\\h.mjs"]), 'node "C:\\a b;c\\h.mjs"');
  assert.throws(() => hookCommand(["no de", "C:\\h.mjs"]), /executável/);
  for (const c of ["%", "^", "&", '"', "!", "$", "`", "'", "\n"]) {
    assert.throws(() => hookCommand(["node", `C:\\p${c}x\\h.mjs`]), /caractere não suportado/, JSON.stringify(c));
  }
});

const HEADER = '"Time of Day","Process Name","PID","Operation","Path","Result","Detail"';
const row = (t, p, pid, op, path, detail = "") => [t, p, pid, op, path, "SUCCESS", detail].map((c) => `"${c}"`).join(",");
const PROBE = 50;
const born = (pid) => row("09:59:59", "node.exe", String(PROBE), "Process Create", "C:\\agy\\agy.exe", `PID: ${pid}, Command line: agy`);
const read = (pid, path, t = "10:00:00", p = "agy.exe") => row(t, p, String(pid), "ReadFile", path);
const died = (pid, t = "10:00:09") => row(t, "agy.exe", String(pid), "Process Exit", "", "Exit Status: 0");
const analyze = (lines, launchPids) => {
  const launches = launchPids.map((pid) => ({ pid, image: "agy.exe" }));
  const a = createTraceAnalyzer({ probePid: PROBE, launches, forbidden: ["C:\\Users\\v\\.gemini", "C:\\Users\\v\\AppData\\Local"], allowed: ["C:\\Users\\v\\AppData\\Local\\duo-probe-win\\run1"] });
  for (const l of [HEADER, ...lines]) a.line(l);
  return a.result();
};

test("trace: só conta a árvore dos processos lançados; a sonda e outros processos ficam de fora", () => {
  const r = analyze([
    read(PROBE, "C:\\Users\\v\\.gemini\\x", "09:59:58", "node.exe"), // a própria sonda
    born(100),
    read(100, "C:\\Users\\v\\AppData\\Local\\duo-probe-win\\run1\\home\\a"),
    row("10:00:02", "agy.exe", "100", "Process Create", "C:\\Windows\\cmd.exe", "PID: 200, Command line: cmd /c node h.mjs"),
    read(200, "C:\\Users\\v\\.gemini\\settings, old.json", "10:00:03", "cmd.exe"),
    read(300, "C:\\Users\\v\\.gemini\\y", "10:00:04", "svchost.exe"),
    died(100),
  ], [100]);
  assert.equal(r.verdict, "forbidden");
  assert.deepEqual(r.hits.map((h) => [h.pid, h.path]), [["200", "C:\\Users\\v\\.gemini\\settings, old.json"]]);
});

test("trace: Process Start do filho também liga à árvore", () => {
  const r = analyze([
    born(100), read(100, "C:\\Windows\\a"),
    row("10:00:01", "helper.exe", "201", "Process Start", "", "Parent PID: 100, Command line: helper"),
    read(201, "C:\\Users\\v\\AppData\\Local\\Antigravity\\c", "10:00:02", "helper.exe"),
    died(100),
  ], [100]);
  assert.equal(r.verdict, "forbidden");
  assert.equal(r.hits[0].pid, "201");
});

test("trace: só a pasta desta execução é permitida, não as de execuções anteriores", () => {
  const r = analyze([born(100), read(100, "C:\\Users\\v\\AppData\\Local\\duo-probe-win\\run0\\home\\.gemini\\c"), died(100)], [100]);
  assert.equal(r.verdict, "forbidden");
});

test("trace: limpo só com cada lançamento criado, com acesso a arquivo e encerrado", () => {
  assert.equal(analyze([born(100), read(100, "C:\\Windows\\a"), died(100)], [100]).verdict, "ok");
  assert.equal(analyze([], [100]).verdict, "incomplete");
  // Só o início do processo, sem eventos de arquivo nem saída: captura parada cedo demais.
  const startOnly = analyze([born(100)], [100]);
  assert.equal(startOnly.verdict, "incomplete");
  assert.deepEqual(startOnly.missingPids, ["100"]);
  assert.equal(analyze([born(100), read(100, "C:\\Windows\\a")], [100]).verdict, "incomplete");
  const cut = analyze([born(100), read(100, "C:\\Windows\\a"), died(100)], [100, 101]);
  assert.equal(cut.verdict, "incomplete");
  assert.deepEqual(cut.missingPids, ["101"]);
});

test("trace: acesso proibido comprovado vence a cobertura incompleta", () => {
  const r = analyze([born(100), read(100, "C:\\Users\\v\\.gemini\\x"), died(100)], [100, 101]);
  assert.equal(r.verdict, "forbidden");
  assert.deepEqual(r.missingPids, ["101"]);
});

test("trace: PID reaproveitado antes da criação ou depois da saída não conta", () => {
  const r = analyze([
    read(100, "C:\\Users\\v\\.gemini\\antes", "09:00:00", "outro.exe"),
    born(100), read(100, "C:\\Windows\\a"), died(100),
    read(100, "C:\\Users\\v\\.gemini\\depois", "11:00:00", "outro.exe"),
  ], [100]);
  assert.equal(r.verdict, "ok");
});

test("resolveAgy: exe, shim .cmd com js, launcher sem extensão antes do .cmd, ausente", () => {
  assert.deepEqual(resolveAgy("C:\\agy\\agy.exe\r\n", () => ""), { kind: "exe", path: "C:\\agy\\agy.exe", script: null });
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\agy\\cli.js" %*\r\n';
  assert.deepEqual(resolveAgy("C:\\npm\\agy.cmd\r\n", () => shim), { kind: "cmd-js", path: "C:\\npm\\agy.cmd", script: "C:\\npm\\node_modules\\agy\\cli.js" });
  assert.deepEqual(resolveAgy("C:\\npm\\agy\r\nC:\\npm\\agy.cmd\r\n", () => shim), { kind: "cmd-js", path: "C:\\npm\\agy.cmd", script: "C:\\npm\\node_modules\\agy\\cli.js" });
  assert.equal(resolveAgy("C:\\npm\\agy.cmd\r\n", () => "@echo off\r\nfoo.exe %*").kind, "cmd-other");
  assert.deepEqual(resolveAgy("", () => ""), { kind: "missing", path: null, script: null });
});

const WS = "C:\\ws";
const step = (tool, state, params, message = "") => JSON.stringify({ event: "step_update", step_update: { tool_name: tool, state, tool_info: { parameters: params, ...(message ? { error: { message } } : {}) } } });
const hookLine = (path, toolName = "write_file") => ({ toolName, args: { Path: path } });
const T = "probe-deny.txt";
const run = (hook, target, { fileExists = false, hookLines = [], stream = "" }) => classifyRun(hook, { target, workspace: WS, fileExists, hookLines, steps: parseStream(stream).steps });

test("classifyRun: negação só conta com o caminho exato do alvo no hook e o erro típico daquele hook", () => {
  const deny = "tool call denied by pre-tool hook: probe-deny";
  assert.equal(run("deny", T, { hookLines: [hookLine(`C:\\ws\\${T}`)], stream: step("write_file", "ERROR", { Path: `C:\\ws\\${T}` }, deny) }), "pass");
  // Caminho relativo resolvido contra a pasta de trabalho.
  assert.equal(run("deny", T, { hookLines: [hookLine(T)], stream: step("write_file", "ERROR", { Path: T }, deny) }), "pass");
  // Mesmo nome em subpasta não é o alvo.
  assert.equal(run("deny", T, { hookLines: [hookLine(`C:\\ws\\sub\\${T}`)], stream: step("write_file", "ERROR", { Path: `C:\\ws\\sub\\${T}` }, deny) }), "inconclusive");
  // Parâmetro que não é caminho não identifica o alvo.
  assert.equal(run("deny", T, { hookLines: [{ toolName: "write_file", args: { Path: "C:\\ws\\x.txt", Content: T } }], stream: step("write_file", "ERROR", { Path: "C:\\ws\\x.txt", Content: T }, deny) }), "inconclusive");
  // Erro comum do sistema de arquivos depois de um hook que liberou: não é prova.
  assert.equal(run("deny", T, { hookLines: [hookLine(`C:\\ws\\${T}`)], stream: step("write_file", "ERROR", { Path: `C:\\ws\\${T}` }, "Access is denied.") }), "inconclusive");
  assert.equal(run("deny", T, { fileExists: true }), "fail");
  const C = "probe-crash.txt";
  assert.equal(run("crash", C, { hookLines: [hookLine(`C:\\ws\\${C}`)], stream: step("write_file", "ERROR", { Path: `C:\\ws\\${C}` }, 'JSON hook "jsonhook__probe_PreToolUse_0_0" failed: command failed: exit status 1, stderr:') }), "pass");
  const G = "probe-garbage.txt";
  assert.equal(run("garbage", G, { hookLines: [hookLine(`C:\\ws\\${G}`)], stream: step("write_file", "ERROR", { Path: `C:\\ws\\${G}` }, "failed to unmarshal result from hook jsonhook__probe_PreToolUse_0_0 via protojson: not json") }), "pass");
});

test("classifyRun: tempo esgotado exige motivo de tempo, não falha comum do comando", () => {
  const M = "probe-timeout.txt";
  const base = { hookLines: [hookLine(`C:\\ws\\${M}`)] };
  assert.equal(run("timeout", M, { ...base, stream: step("write_file", "ERROR", { Path: `C:\\ws\\${M}` }, 'JSON hook "jsonhook__probe_PreToolUse_0_0" failed: command failed: signal: killed, stderr:') }), "pass");
  assert.equal(run("timeout", M, { ...base, stream: step("write_file", "ERROR", { Path: `C:\\ws\\${M}` }, 'JSON hook "jsonhook__probe_PreToolUse_0_0" failed: command failed: exit status 1, stderr:') }), "inconclusive");
});

test("classifyRun: controle allow-log separa hook que não rodou, comando quebrado, evidência ilegível e modelo que não tentou", () => {
  const A = "probe-allow-log.txt";
  const done = step("write_file", "DONE", { Path: `C:\\ws\\${A}` });
  assert.equal(run("allow-log", A, { fileExists: true, hookLines: [hookLine(`C:\\ws\\${A}`)], stream: done }), "pass");
  assert.equal(run("allow-log", A, { fileExists: true, hookLines: [], stream: done }), "hook-not-run");
  assert.equal(run("allow-log", A, { stream: step("write_file", "ERROR", { Path: `C:\\ws\\${A}` }, 'JSON hook "jsonhook__probe_PreToolUse_0_0" failed: command failed: exit status 1') }), "hook-cmd-failed");
  assert.equal(run("allow-log", A, {}), "inconclusive");
  // O hook rodou mas a sonda não reconhece a entrada (stdin ilegível ou ferramenta nova): não é "hook não rodou".
  assert.equal(run("allow-log", A, { fileExists: true, hookLines: [{ stdinError: "SyntaxError", toolName: null, args: null }], stream: done }), "inconclusive");
  assert.equal(run("allow-log", A, { fileExists: true, hookLines: [hookLine(`C:\\ws\\${A}`, "save_file")], stream: done }), "inconclusive");
});

test("trace: ajudante ainda vivo quando o lançamento sai deixa o rastreio incompleto", () => {
  const r = analyze([
    born(100), read(100, "C:\\Windows\\a"),
    row("10:00:02", "agy.exe", "100", "Process Create", "C:\\h.exe", "PID: 300, Command line: h"),
    died(100),
  ], [100]);
  assert.equal(r.verdict, "incomplete");
  const ok = analyze([
    born(100), read(100, "C:\\Windows\\a"),
    row("10:00:02", "agy.exe", "100", "Process Create", "C:\\h.exe", "PID: 300, Command line: h"),
    died(100), died(300, "10:00:10"),
  ], [100]);
  assert.equal(ok.verdict, "ok");
});

test("trace: Load Image de DLL no perfil real é acesso proibido", () => {
  const r = analyze([born(100), read(100, "C:\\Windows\\a"), row("10:00:01", "agy.exe", "100", "Load Image", "C:\\Users\\v\\.gemini\\x.dll"), died(100)], [100]);
  assert.equal(r.verdict, "forbidden");
});

test("trace: PID repetido entre lançamentos exige um ciclo de vida para cada um", () => {
  assert.equal(analyze([born(100), read(100, "C:\\Windows\\a"), died(100)], [100, 100]).verdict, "incomplete");
  assert.equal(analyze([born(100), read(100, "C:\\Windows\\a"), died(100), born(100), read(100, "C:\\Windows\\b", "10:01:00"), died(100, "10:01:09")], [100, 100]).verdict, "ok");
});

test("classifyRun: texto do stderr não vale como motivo de tempo esgotado", () => {
  const M = "probe-timeout.txt";
  assert.equal(run("timeout", M, { hookLines: [hookLine(`C:\\ws\\${M}`)], stream: step("write_file", "ERROR", { Path: `C:\\ws\\${M}` }, 'JSON hook "jsonhook__probe_PreToolUse_0_0" failed: command failed: exit status 1, stderr: at C:\\hooks\\timeout.mjs:3 signal: killed') }), "inconclusive");
});

test("classifyRun: hook legível que só viu outras ferramentas e escrita concluída = hook não rodou na escrita", () => {
  const A = "probe-allow-log.txt";
  const done = step("write_file", "DONE", { Path: `C:\\ws\\${A}` });
  assert.equal(run("allow-log", A, { fileExists: true, hookLines: [{ toolName: "list_dir", args: { Path: "." } }], stream: done }), "hook-not-run");
});

test("trace: filho da sonda com o mesmo PID mas outro executável (git) não cobre o lançamento do agy", () => {
  const r = analyze([
    row("09:59:00", "node.exe", String(PROBE), "Process Create", "C:\\Program Files\\Git\\cmd\\git.exe", "PID: 100, Command line: git init -q"),
    read(100, "C:\\Windows\\g", "09:59:01", "git.exe"), died(100, "09:59:02"),
    born(100), read(100, "C:\\Users\\v\\.gemini\\x"), died(100),
  ], [100]);
  assert.equal(r.verdict, "forbidden");
});

test("trace: executável de ajudante dentro do perfil real é acesso proibido", () => {
  const r = analyze([
    born(100), read(100, "C:\\Windows\\a"),
    row("10:00:02", "agy.exe", "100", "Process Create", "C:\\Users\\v\\.gemini\\bin\\h.exe", "PID: 300, Command line: h"),
    died(100), died(300, "10:00:10"),
  ], [100]);
  assert.equal(r.verdict, "forbidden");
});

test("classifyRun: hook que só viu escrita em outro arquivo e escrita do alvo concluída = hook não rodou na escrita", () => {
  const A = "probe-allow-log.txt";
  const done = step("write_file", "DONE", { Path: `C:\\ws\\${A}` });
  assert.equal(run("allow-log", A, { fileExists: true, hookLines: [hookLine("C:\\ws\\other.txt")], stream: done }), "hook-not-run");
  assert.equal(run("allow-log", A, { fileExists: true, hookLines: [{ toolName: "write_file", args: { Content: "x" } }], stream: done }), "inconclusive");
});

test("classifyRun: no Windows o tempo esgotado vale pelo registro de vida do hook cortado perto do limite", () => {
  const M = "probe-timeout.txt";
  const failed = 'JSON hook "jsonhook__probe_PreToolUse_0_0" failed: command failed: exit status 1, stderr:';
  const stream = step("write_file", "ERROR", { Path: `C:\\ws\\${M}` }, failed);
  const go = (alive, extra = {}) => classifyRun("timeout", { target: M, workspace: WS, fileExists: false, hookLines: [{ ...hookLine(`C:\\ws\\${M}`), pid: 7 }], steps: parseStream(stream).steps, alive, hookTimeoutMs: 5000, ...extra });
  const a = (o) => [{ pid: 7, aliveMs: 4750, parentGoneAtMs: null, answered: false, ...o }];
  assert.equal(go(a({})), "pass"); // árvore inteira morta: as anotações param perto dos 5 s
  assert.equal(go(a({ aliveMs: 5300, parentGoneAtMs: 5300 })), "pass"); // só o cmd.exe morto: o hook viu o pai sumir
  assert.equal(go(a({ aliveMs: 900 })), "inconclusive"); // cortado cedo: não foi o limite de tempo
  assert.equal(go(a({ aliveMs: 30_000 })), "inconclusive"); // cortado muito depois: o limite configurado não valeu
  assert.equal(go(a({ aliveMs: 60_000, answered: true })), "inconclusive"); // o hook chegou a responder
  assert.equal(go(a({ pid: 8 })), "inconclusive"); // registro de outro processo
  assert.equal(go([]), "inconclusive");
  assert.equal(go(a({}), { fileExists: true }), "fail");
  assert.equal(go(a({}), { steps: parseStream(step("write_file", "ERROR", { Path: `C:\\ws\\${M}` }, "Access is denied.")).steps }), "inconclusive");
});

test("summarizeAlive: junta por PID, guarda o último instante, a primeira vez que o pai sumiu e a resposta", () => {
  const text = ['{"pid":7,"aliveMs":300}', '{"pid":7,"aliveMs":550}', "lixo", '{"pid":7,"aliveMs":5300,"parentGone":true}', '{"pid":9,"aliveMs":60010,"answered":true}', '{"pid":7,"aliveMs":4'].join("\n");
  assert.deepEqual(summarizeAlive(text), [
    { pid: 7, aliveMs: 5300, parentGoneAtMs: 5300, answered: false },
    { pid: 9, aliveMs: 60010, parentGoneAtMs: null, answered: true },
  ]);
});

const HEADER_R = '"Time of Day","Process Name","PID","Operation","Path","Result","Detail"';
const rowR = (t, p, pid, op, path, result, detail = "") => [t, p, pid, op, path, result, detail].map((c) => `"${c}"`).join(",");
const analyzeR = (lines, opts = {}) => {
  const a = createTraceAnalyzer({
    probePid: PROBE, launches: [{ pid: 100, image: "agy.exe" }],
    forbidden: ["C:\\Users\\v\\.gemini", "C:\\Users\\v\\AppData\\Roaming\\Antigravity"],
    allowed: ["C:\\Users\\v\\AppData\\Local\\duo-probe-win\\run1"],
    configNames: /^(\.?codeium\.ya?ml|GEMINI\.md|AGENTS\.md)$/i, ...opts,
  });
  for (const l of [HEADER_R, born(100), read(100, "C:\\Windows\\a"), ...lines, died(100)]) a.line(l);
  return a.result();
};

test("trace: busca no PATH e subida de pastas fora da lista proibida não contam", () => {
  const r = analyzeR([
    rowR("10:00:01", "agy.exe", "100", "CreateFile", "C:\\Users\\v\\AppData\\Local\\Programs\\Python\\pwsh.exe", "NAME NOT FOUND"),
    rowR("10:00:02", "agy.exe", "100", "CreateFile", "C:\\Users\\v\\AppData\\Local", "SUCCESS"),
  ]);
  assert.equal(r.verdict, "ok");
});

test("trace: procura sem sucesso em pasta proibida é só tentativa; leitura com sucesso é acesso", () => {
  const miss = analyzeR([rowR("10:00:01", "agy.exe", "100", "CreateFile", "C:\\Users\\v\\.gemini\\GEMINI.md", "NAME NOT FOUND")]);
  assert.equal(miss.verdict, "ok");
  assert.equal(miss.lookups.length, 1);
  const hit = analyzeR([rowR("10:00:01", "agy.exe", "100", "ReadFile", "C:\\Users\\v\\.gemini\\GEMINI.md", "SUCCESS")]);
  assert.equal(hit.verdict, "forbidden");
});

test("trace: arquivo de config do agy achado numa pasta-mãe é acesso; só procurado é tentativa", () => {
  const found = analyzeR([rowR("10:00:01", "agy.exe", "100", "CreateFile", "C:\\Users\\v\\AppData\\Local\\codeium.yaml", "SUCCESS")]);
  assert.equal(found.verdict, "forbidden");
  const looked = analyzeR([rowR("10:00:01", "agy.exe", "100", "CreateFile", "C:\\Users\\v\\AppData\\Local\\.codeium.yml", "NAME NOT FOUND")]);
  assert.equal(looked.verdict, "ok");
  assert.equal(looked.lookups[0].path, "C:\\Users\\v\\AppData\\Local\\.codeium.yml");
  // Dentro da raiz privada desta execução, a config é do próprio duo.
  assert.equal(analyzeR([rowR("10:00:01", "agy.exe", "100", "CreateFile", "C:\\Users\\v\\AppData\\Local\\duo-probe-win\\run1\\ws\\codeium.yaml", "SUCCESS")]).verdict, "ok");
});

test("trace: resultado mostra a cobertura de cada lançamento que faltou, mesmo com acesso proibido", () => {
  const a = createTraceAnalyzer({ probePid: PROBE, launches: [{ pid: 100, image: "agy.exe" }, { pid: 101, image: "agy.exe" }], forbidden: ["C:\\Users\\v\\.gemini"], allowed: [] });
  for (const l of [HEADER, born(100), read(100, "C:\\Users\\v\\.gemini\\x"), died(100), born(101)]) a.line(l);
  const r = a.result();
  assert.equal(r.verdict, "forbidden");
  assert.deepEqual(r.missing, [{ pid: "101", image: "agy.exe", created: true, fs: 0, exited: false, liveDescendants: 0 }]);
});
