#!/usr/bin/env node
// Teste de fatos do agy no Windows (Fase 0 do design docs/superpowers/specs/2026-11-23-gemini-windows-design.md).
// Ordem: F1 (achar o agy) → F4/F5 sem inferência (agy models com perfil privado) → só então F2/F3/F6/F7, que gastam cota.
// Toda evidência passa por redact() antes de ir para o disco. Nada aqui escreve no perfil real do dono.
// Uso: node probe.mjs [--dry-run] [--pause] [--model <id>] [--out <dir>]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path, { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authVerdict, classifyRun, hookCommand, parseStream, privateEnv, redact, resolveAgy } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const dryRun = argv.includes("--dry-run");
let pause = argv.includes("--pause");
const model = opt("--model") ?? "gemini-3.8-flash-low";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(resolve(opt("--out") ?? join(here, "..", "..", "..", "..", "docs", "evidencias", "gemini-windows-phase0")), runId);
const rootBase = process.env.PROBE_ROOT_OVERRIDE ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "duo-probe-win");
const root = join(rootBase, runId);
const SETTINGS = { allowNonWorkspaceAccess: false, permissions: { deny: ["command(*)"] } };
const HOOKS = ["allow-log", "deny", "crash", "garbage", "timeout"];
const quick = (cmd, args, extra = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, ...extra });

const res = { runId, platform: process.platform, node: { version: process.version, execDir: dirname(process.execPath) }, probePid: process.pid, rootBase, root, launches: [], f1: null, f4: null, quota: null, stop: null };

const deep = (v) => typeof v === "string" ? redact(v, homedir())
  : Array.isArray(v) ? v.map(deep)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;

function finish(code, stop) {
  res.stop = stop ?? null;
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "results.json");
  writeFileSync(file, `${JSON.stringify(deep(res), null, 2)}\n`);
  console.log(`resultado: ${file}`);
  if (res.quota) for (const r of res.quota.runs) console.log(`  ${r.hook.padEnd(10)} ${r.outcome.padEnd(15)} arquivo=${r.fileExists} hookRodou=${r.hookLines.length > 0}`);
  console.log(stop ? redact(stop, homedir()) : dryRun ? "OK: dry-run concluído, nenhuma cota gasta" : "OK: Fase 0 concluída");
  process.exit(code);
}

function waitEnter(label) {
  if (!pause) return;
  process.stdout.write(`>>> ${label} ${new Date().toISOString()} — Enter para continuar\n`);
  const b = Buffer.alloc(1);
  for (;;) {
    let n = 0;
    try { n = readSync(0, b, 0, 1, null); }
    catch (e) { console.warn(`aviso: --pause desligado, não deu para ler o teclado (${e.code ?? e.message})`); pause = false; return; }
    if (n === 0 || b[0] === 10) return;
  }
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

// --- Fatos sobre o perfil real, lidos ANTES de qualquer agy (o rastreio só conta a árvore dos processos do agy) -----
const realChecks = {};
for (const [name, base] of [["APPDATA", process.env.APPDATA], ["LOCALAPPDATA", process.env.LOCALAPPDATA]]) {
  realChecks[name] = base && existsSync(base) ? readdirSync(base).filter((n) => /antigravity|gemini|agy/i.test(n)) : null;
}
realChecks.userGemini = existsSync(join(homedir(), ".gemini"));
if (isWin) {
  const ck = quick("cmdkey", ["/list"]);
  realChecks.credentialTargets = (ck.stdout ?? "").split(/\r?\n/).filter((l) => /target|destino/i.test(l) && /antigravity|gemini|google/i.test(l)).map((l) => l.trim());
}

// --- F1: onde está o agy e como chamá-lo ---------------------------------------------------------------------------
const whereOut = process.env.PROBE_WHERE_OVERRIDE
  ?? quick(isWin ? "cmd.exe" : "which", isWin ? ["/d", "/c", "where", "agy"] : ["agy"]).stdout ?? "";
const agy = resolveAgy(whereOut, (p) => readFileSync(p, "utf8"));
if (agy.kind === "missing") { res.f1 = agy; finish(2, "STOP F1: agy não encontrado no PATH"); }
// exe: direto. Shim npm com JS: node + script (a versão vem do script, não do Node). Outro: cmd.exe no Windows.
const launcher = agy.kind === "cmd-js" ? [process.execPath, agy.script]
  : agy.kind === "cmd-other" && isWin ? ["cmd.exe", "/d", "/c", agy.path] : [agy.path];

function runAgy(label, args, extra = {}) {
  waitEnter(label);
  const r = spawnSync(launcher[0], [...launcher.slice(1), ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, ...extra });
  res.launches.push({ label, pid: r.pid ?? null, time: new Date().toISOString(), exit: r.status, error: r.error?.code ?? null });
  return r;
}

const env = privateEnv(process.env, root, path);
for (const d of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) mkdirSync(d, { recursive: true });

// Hooks copiados para a raiz privada e chamados com `node` do PATH, sem aspas quando o caminho não tem espaço:
// a mesma linha funciona se o agy rodar o hook pelo cmd, pelo PowerShell ou direto. Validados antes de gastar cota.
const hookDir = join(root, "hooks");
mkdirSync(hookDir, { recursive: true });
for (const f of ["_record.mjs", ...HOOKS.map((h) => `${h}.mjs`)]) copyFileSync(join(here, "hooks", f), join(hookDir, f));
const hookCommands = {};
try { for (const h of HOOKS) hookCommands[h] = hookCommand(["node", join(hookDir, `${h}.mjs`), join(root, `hooklog-${h}.jsonl`)]); }
catch (e) { finish(5, `STOP sonda: ${e.message}`); }

const ver = runAgy("agy --version", ["--version"], { env, cwd: env.TEMP });
const help = runAgy("agy --help", ["--help"], { env, cwd: env.TEMP });
res.f1 = { ...agy, launcher, version: (ver.stdout ?? "").trim().split(/\r?\n/)[0] ?? null, versionExit: ver.status, help: (help.stdout ?? "").split(/\r?\n/).slice(0, 200) };

// --- F4/F5: login e perfil, sem inferência. O log é zerado antes: só vale o sinal desta chamada do models. ----------
const logDir = join(env.HOME, ".gemini", "antigravity-cli", "log");
rmSync(logDir, { recursive: true, force: true });
const models = runAgy("agy models", ["models"], { env, cwd: env.TEMP });
const verdict = authVerdict(readAllFiles(logDir));
res.f4 = {
  exit: models.status,
  models: (models.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^gemini-/.test(l)),
  stderrTail: (models.stderr ?? "").slice(-2000),
  createdUnderPrivateRoot: listTree(root),
  verdict: verdict.verdict, methods: verdict.methods, effectives: verdict.effectives, authLines: verdict.lines,
  real: realChecks,
};
if (models.status !== 0) finish(3, `STOP F4: agy models falhou (saída ${models.status ?? models.error?.code}); login não provado`);
if (verdict.verdict === "review") finish(3, `STOP F4: fonte de login desconhecida no Windows (${verdict.effectives.join(", ")}); revisar antes de gastar cota`);
if (verdict.verdict !== "proceed") finish(3, "STOP F4: login da assinatura não provado com perfil privado");
if (dryRun) finish(0);

// --- F2/F3/F6/F7: até cinco execuções curtas que gastam cota; para na primeira falha definitiva ---------------------
if (agy.kind === "cmd-other" && isWin) finish(2, "STOP F1: shim do agy sem script JS identificado; a sonda não passa JSON pelo cmd.exe com segurança");
const runs = [];
res.quota = { model, runs };
for (const hook of HOOKS) {
  const ws = join(root, `ws-${hook}`);
  mkdirSync(join(ws, ".agents"), { recursive: true });
  const gi = quick("git", ["init", "-q"], { cwd: ws });
  if (gi.status !== 0) finish(5, `STOP sonda: git init falhou em ${ws}`);
  const log = join(root, `hooklog-${hook}.jsonl`);
  writeFileSync(log, "");
  const hooks = { probe: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommands[hook], timeout: hook === "timeout" ? 5 : 10 }] }] } };
  writeFileSync(join(ws, ".agents", "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);
  const target = `probe-${hook}.txt`;
  const prompt = `Create the file ${target} in the current directory containing the word OK, using your file-writing tool. Do nothing else.`;
  const r = runAgy(`agy headless (${hook})`, ["-p=", "--input-format", "stream-json", "--output-format", "stream-json", "--model", model, "--settings", JSON.stringify(SETTINGS)], {
    env, cwd: ws, timeout: 180_000, input: `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`,
  });
  const stream = parseStream(r.stdout ?? "");
  const hookLines = readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsable: l.slice(0, 200) }; } });
  const fileExists = existsSync(join(ws, target));
  const outcome = classifyRun(hook, { target, workspace: ws, fileExists, hookLines, steps: stream.steps }, path);
  runs.push({ hook, outcome, exit: r.status, timedOut: r.error?.code === "ETIMEDOUT", status: stream.status, events: stream.events, steps: stream.steps, fileExists, hookLines, stderrTail: (r.stderr ?? "").slice(-2000) });
  if (outcome === "fail") finish(4, `STOP F3: ${hook} não falhou fechado (a escrita aconteceu)`);
  if (outcome === "hook-not-run") finish(4, "STOP F3: hook não disparou para a escrita");
}
const open = runs.filter((r) => r.outcome !== "pass").map((r) => `${r.hook}=${r.outcome}`);
finish(0, open.length ? `INCONCLUSIVO: ${open.join(", ")} (sem prova de negação pelo hook; repetir ou revisar)` : undefined);
