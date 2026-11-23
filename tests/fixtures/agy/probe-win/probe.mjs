#!/usr/bin/env node
// Teste de fatos do agy no Windows (Fase 0 do design docs/superpowers/specs/2026-11-23-gemini-windows-design.md).
// Ordem: F1 (achar o agy) → F4/F5 sem inferência (agy models com perfil privado) → só então F2/F3/F6/F7, que gastam cota.
// Toda evidência passa por redact() antes de ir para o disco. Nada aqui escreve no perfil real do dono.
// Uso: node probe.mjs [--dry-run] [--pause] [--model <id>] [--out <dir>]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path, { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authVerdict, hookCommand, privateEnv, redact, resolveAgy } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const dryRun = argv.includes("--dry-run");
const pause = argv.includes("--pause");
const model = opt("--model") ?? "gemini-3.8-flash-low";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(resolve(opt("--out") ?? join(here, "..", "..", "..", "..", "docs", "evidencias", "gemini-windows-phase0")), runId);
const rootBase = process.env.PROBE_ROOT_OVERRIDE ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "duo-probe-win");
const root = join(rootBase, runId);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]);
const SETTINGS = { allowNonWorkspaceAccess: false, permissions: { deny: ["command(*)"] } };
const HOOKS = ["allow-log", "deny", "crash", "garbage", "timeout"];

const res = { runId, platform: process.platform, node: { version: process.version, execDir: dirname(process.execPath) }, root, launches: [], f1: null, f4: null, quota: null, stop: null };

const deep = (v) => typeof v === "string" ? redact(v, homedir())
  : Array.isArray(v) ? v.map(deep)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;

function finish(code, stop) {
  res.stop = stop ?? null;
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "results.json");
  writeFileSync(file, `${JSON.stringify(deep(res), null, 2)}\n`);
  console.log(`resultado: ${file}`);
  if (res.quota) for (const r of res.quota.runs) console.log(`  ${r.hook.padEnd(10)} ${r.outcome.padEnd(13)} arquivo=${r.fileExists} hookRodou=${r.hookLines.length > 0}`);
  console.log(stop ?? (dryRun ? "OK: dry-run concluído, nenhuma cota gasta" : "OK: Fase 0 concluída"));
  process.exit(code);
}

function waitEnter(label) {
  res.launches.push({ label, time: new Date().toISOString() });
  if (!pause) return;
  process.stdout.write(`>>> ${label} ${new Date().toISOString()} — Enter para continuar\n`);
  const b = Buffer.alloc(1);
  for (;;) { let n = 0; try { n = readSync(0, b, 0, 1, null); } catch { return; } if (n === 0 || b[0] === 10) return; }
}

function listTree(dir, depth = 4, base = dir) {
  if (depth < 0 || !existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(relative(base, p) + (e.isDirectory() ? "/" : ""));
    if (e.isDirectory()) out.push(...listTree(p, depth - 1, base));
  }
  return out;
}

function readAllFiles(dir) {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { withFileTypes: true }).map((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? readAllFiles(p) : e.isFile() ? readFileSync(p, "utf8") : "";
  }).join("\n");
}

// --- F1: onde está o agy e como chamá-lo ---------------------------------------------------------------------------
const whereOut = process.env.PROBE_WHERE_OVERRIDE
  ?? spawnSync(isWin ? "cmd.exe" : "which", isWin ? ["/d", "/c", "where", "agy"] : ["agy"], { encoding: "utf8" }).stdout ?? "";
const agy = resolveAgy(whereOut, (p) => readFileSync(p, "utf8"));
if (agy.kind === "missing") { res.f1 = agy; finish(2, "STOP F1: agy não encontrado no PATH"); }
// exe: direto. Shim npm com JS: node + script (a versão vem do script, não do Node). Outro shim: cmd.exe no Windows.
const launcher = agy.kind === "cmd-js" ? [process.execPath, agy.script]
  : agy.kind === "cmd-other" && isWin ? ["cmd.exe", "/d", "/c", agy.path] : [agy.path];
const runAgy = (args, extra = {}) => spawnSync(launcher[0], [...launcher.slice(1), ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, ...extra });

const env = privateEnv(process.env, root, path);
for (const d of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) mkdirSync(d, { recursive: true });

waitEnter("agy --version");
const ver = runAgy(["--version"], { env, cwd: env.TEMP });
waitEnter("agy --help");
const help = runAgy(["--help"], { env, cwd: env.TEMP });
res.f1 = { ...agy, launcher, version: (ver.stdout ?? "").trim().split(/\r?\n/)[0] ?? null, versionExit: ver.status, help: (help.stdout ?? "").split(/\r?\n/).slice(0, 200) };

// --- F4/F5: login e perfil, sem inferência -------------------------------------------------------------------------
waitEnter("agy models");
const models = runAgy(["models"], { env, cwd: env.TEMP });
const logText = readAllFiles(join(env.HOME, ".gemini", "antigravity-cli", "log"));
const verdict = authVerdict(logText);
const realChecks = {};
for (const [name, base] of [["APPDATA", process.env.APPDATA], ["LOCALAPPDATA", process.env.LOCALAPPDATA]]) {
  realChecks[name] = base && existsSync(base) ? readdirSync(base).filter((n) => /antigravity|gemini|agy/i.test(n)) : null;
}
realChecks.userGemini = existsSync(join(homedir(), ".gemini"));
if (isWin) {
  const ck = spawnSync("cmdkey", ["/list"], { encoding: "utf8" });
  realChecks.credentialTargets = (ck.stdout ?? "").split(/\r?\n/).filter((l) => /target|destino/i.test(l) && /antigravity|gemini|google/i.test(l)).map((l) => l.trim());
}
res.f4 = {
  exit: models.status,
  models: (models.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^gemini-/.test(l)),
  stderrTail: (models.stderr ?? "").slice(-2000),
  createdUnderPrivateRoot: listTree(root),
  verdict: verdict.verdict, methods: verdict.methods, effectives: verdict.effectives, authLines: verdict.lines,
  real: realChecks,
};
if (verdict.verdict !== "proceed") finish(3, "STOP F4: login da assinatura não provado com perfil privado");
if (dryRun) finish(0);

// --- F2/F3/F6/F7: cinco execuções curtas que gastam cota -----------------------------------------------------------
if (agy.kind === "cmd-other" && isWin) finish(2, "STOP F1: shim do agy sem script JS identificado; a sonda não passa JSON pelo cmd.exe com segurança");
const runs = [];
for (const hook of HOOKS) {
  const ws = join(root, `ws-${hook}`);
  mkdirSync(join(ws, ".agents"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const log = join(root, `hooklog-${hook}.jsonl`);
  writeFileSync(log, "");
  let command;
  try { command = hookCommand(process.execPath, join(here, "hooks", `${hook}.mjs`), [log]); }
  catch (e) { res.quota = { model, runs }; finish(4, `STOP F3: ${e.message}`); }
  const hooks = { probe: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: hook === "timeout" ? 5 : 10 }] }] } };
  writeFileSync(join(ws, ".agents", "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);
  const prompt = `Create the file probe-${hook}.txt in the current directory containing the word OK, using your file-writing tool. Do nothing else.`;
  waitEnter(`agy headless (${hook})`);
  const r = runAgy(["-p=", "--input-format", "stream-json", "--output-format", "stream-json", "--model", model, "--settings", JSON.stringify(SETTINGS)], {
    env, cwd: ws, timeout: 180_000, input: `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`,
  });
  const events = new Set();
  const toolErrors = [];
  let status = null;
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (typeof ev.event === "string") events.add(ev.event);
    if (ev.event === "result") status = ev.result?.status ?? null;
    const u = ev.step_update;
    if (u?.state === "ERROR") toolErrors.push({ tool: u.tool_name ?? null, message: String(u.tool_info?.error?.message ?? "").slice(0, 300) });
  }
  const hookLines = readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsable: l.slice(0, 200) }; } });
  const parents = {};
  if (isWin) for (const pid of new Set(hookLines.map((l) => l.ppid).filter(Number.isInteger))) {
    const q = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').Name`], { encoding: "utf8" });
    parents[pid] = (q.stdout ?? "").trim() || null;
  }
  const fileExists = existsSync(join(ws, `probe-${hook}.txt`));
  const hookSawWrite = hookLines.some((l) => WRITE_TOOLS.has(l.toolName));
  const writeErrored = toolErrors.some((e) => WRITE_TOOLS.has(e.tool));
  let outcome;
  if (hook === "allow-log") outcome = hookLines.length === 0 ? "hook-not-run" : fileExists ? "pass" : "inconclusive";
  // Arquivo ausente só prova a trava com o hook rodando para a escrita e a escrita terminando em erro.
  else outcome = fileExists ? "fail" : hookSawWrite && writeErrored ? "pass" : "inconclusive";
  runs.push({ hook, exit: r.status, signal: r.signal, timedOut: r.error?.code === "ETIMEDOUT", status, events: [...events], toolErrors, fileExists, hookLines, parents, stderrTail: (r.stderr ?? "").slice(-2000) });
  runs.at(-1).outcome = outcome;
}
res.quota = { model, runs };
const bad = runs.find((r) => r.outcome === "fail" || r.outcome === "hook-not-run");
if (bad) finish(4, bad.outcome === "fail" ? `STOP F3: ${bad.hook} não falhou fechado (o arquivo foi criado)` : "STOP F3: hook não disparou");
const inconclusive = runs.filter((r) => r.outcome === "inconclusive").map((r) => r.hook);
finish(0, inconclusive.length ? `INCONCLUSIVO: ${inconclusive.join(", ")} (sem prova de negação pelo hook; repetir ou revisar)` : undefined);
