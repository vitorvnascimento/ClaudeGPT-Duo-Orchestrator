// Utilidades compartilhadas pelas CLIs simuladas. Nada aqui chama modelos.
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const attempt = Number(process.env.DUO_ATTEMPT ?? "1");
export const scenario = JSON.parse(process.env.FAKE_SCENARIO_BY_ATTEMPT ?? "{}")[attempt] ?? process.env.FAKE_SCENARIO ?? "success";

export function log(entry) {
  if (!process.env.FAKE_LOG) return;
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
}

export function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function sensitiveEnvSeen() {
  return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDECODE"].filter((k) => process.env[k] !== undefined);
}

/** Aplica as escritas simuladas (FAKE_WRITE = {"caminho": "conteúdo"}) no diretório atual. */
export function applyWrites() {
  const writes = JSON.parse(process.env.FAKE_WRITE_BY_ATTEMPT ?? "{}")[attempt] ?? JSON.parse(process.env.FAKE_WRITE ?? "{}");
  for (const [rel, content] of Object.entries(writes)) {
    const abs = join(process.cwd(), rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (content === null) rmSync(abs, { force: true });
    else writeFileSync(abs, content);
  }
  return Object.keys(writes);
}

export function report(files) {
  const base = {
    status: "completed",
    summary: "Implementado conforme pedido.",
    filesChanged: files,
    testsRun: [{ command: "npm test", exitCode: 0, passed: true }],
    limitations: [],
    blockedReason: null,
  };
  return { ...base, ...JSON.parse(process.env.FAKE_REPORT ?? "{}"), ...JSON.parse(process.env.FAKE_REPORT_BY_ATTEMPT ?? "{}")[attempt] };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cenário de timeout/cancelamento: cria um neto para verificar o encerramento da árvore. */
export function spawnGrandchild() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
  if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, JSON.stringify({ self: process.pid, grandchild: child.pid }));
  return child;
}

/** Cenário de recursão: o executor tenta chamar a ponte de novo. */
export function tryRecursiveDelegate() {
  const cli = process.env.FAKE_DUO_CLI;
  const req = process.env.FAKE_RECURSIVE_REQUEST;
  if (!cli || !req) return null;
  const r = spawnSync(process.execPath, [cli, "delegate", "--request", req], { encoding: "utf8", cwd: process.cwd() });
  log({ recursiveAttempt: true, exitCode: r.status, stdout: r.stdout.slice(0, 500) });
  return r.status;
}

export function removeLock() {
  const p = join(process.cwd(), ".duo", "lock.json");
  if (existsSync(p)) rmSync(p);
}

/** Escreve linhas em pedaços pequenos, quebrando no meio de caracteres multibyte. */
export async function writeFragmented(lines) {
  const buf = Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  for (let i = 0; i < buf.length; i += 7) {
    process.stdout.write(buf.subarray(i, i + 7));
    if (i % 70 === 0) await sleep(1);
  }
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function emitPrivateKey() {
  const pem = process.env.FAKE_PRIVATE_KEY;
  if (!pem) return;
  for (const line of pem.trimEnd().split("\n")) {
    if (process.env.FAKE_KEY_FORMAT === "json") {
      emit({ type: "stream_event", event: { delta: { type: "text_delta", text: line } } });
    } else process.stdout.write(line + "\n");
  }
  process.stderr.write(pem.slice(pem.indexOf("\n") + 1));
}
