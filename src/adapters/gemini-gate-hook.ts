#!/usr/bin/env node
// Hook PreToolUse do agy: lê a chamada no stdin, decide pela allowlist do duo e responde no stdout.
// Qualquer erro vira "deny" (e, se nem isso sair, o agy nega porque o hook falhou).
// Allowlist, log e prazo: argv[2..4] (Windows) ou DUO_GATE_ALLOWLIST/DUO_GATE_LOG/DUO_GATE_TIMEOUT (macOS).
// O cronômetro e o vigia do pai ficam na thread principal, que não faz nenhuma operação de disco bloqueante: a leitura
// da allowlist, a decisão (caminhos, links) e o log rodam numa worker. Se o disco travar, o prazo ainda nega e sai.
// No Windows o agy mata só o cmd.exe no timeout (fatos da Fase 0): o hook sai sozinho quando o pai some.
import { appendFileSync, readFileSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { decideToolCall, pathDigest, rawPathArgs, type GateDecision, type PersistedGateAllowlist } from "./gemini-gate.js";

const deny = (reason: string): GateDecision => ({ decision: "deny", reason: `duo-gate: ${reason}` });

if (isMainThread) {
  const allowPath = process.argv[2] ?? process.env.DUO_GATE_ALLOWLIST ?? "";
  const logPath = process.argv[3] ?? process.env.DUO_GATE_LOG ?? "";
  const timeoutSec = Number(process.argv[4] ?? process.env.DUO_GATE_TIMEOUT ?? 10);
  const limitMs = Math.max(1000, (Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 10) * 1000 - 1500);
  let answered = false;
  // process.exit espera uma worker presa em E/S: no prazo e com o pai morto o hook se mata (SIGKILL; TerminateProcess
  // no Windows), sem esperar ninguém. A saída diferente de zero também é negação para o agy.
  const hardExit = (): never => { process.kill(process.pid, "SIGKILL"); process.exit(1); };
  const answer = (out: GateDecision, hard = false): void => {
    if (answered) return;
    answered = true;
    // Resposta curta (o motivo pode trazer um caminho longo) e saída garantida mesmo se o pipe não for lido.
    const bounded = { decision: out.decision, reason: out.reason.slice(0, 300) };
    process.stdout.write(JSON.stringify(bounded), () => (hard ? hardExit() : process.exit(0)));
    setTimeout(hardExit, 1000).unref();
  };
  // Vigias armados antes de qualquer outra coisa e só desarmados pela saída do processo. No prazo, uma resposta já
  // escrita mas ainda não entregue também não segura o hook.
  setTimeout(() => (answered ? hardExit() : answer(deny("prazo do hook esgotado"), true)), limitMs);
  if (process.platform === "win32") {
    setInterval(() => {
      try { process.kill(process.ppid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") hardExit(); }
    }, 250);
  }
  const worker = new Worker(new URL(import.meta.url), { workerData: { allowPath, logPath } });
  worker.on("message", (out: GateDecision) => answer(out));
  worker.on("error", (e) => answer(deny(`erro: ${e.message}`)));
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c: string) => { buf += c; });
  process.stdin.on("error", (e) => answer(deny(`erro: ${e.message}`)));
  process.stdin.on("end", () => worker.postMessage(buf));
} else {
  const { allowPath, logPath } = workerData as { allowPath: string; logPath: string };
  parentPort?.on("message", (buf: string) => {
    let input: unknown = null;
    let allow: PersistedGateAllowlist | null = null;
    let out: GateDecision;
    try {
      allow = JSON.parse(readFileSync(allowPath, "utf8")) as PersistedGateAllowlist;
      input = JSON.parse(buf);
      out = decideToolCall(input, allow);
    } catch (e) { out = deny(`erro: ${(e as Error).message}`); }
    try {
      const i = input as { toolCall?: { name?: unknown; args?: unknown }; modelName?: unknown } | null;
      const tool = typeof i?.toolCall?.name === "string" ? i.toolCall.name : null;
      const modelName = typeof i?.modelName === "string" ? i.modelName : null;
      const digests = allow?.nonce ? rawPathArgs(i?.toolCall?.args).map((raw) => pathDigest(allow?.nonce as string, raw)) : [];
      if (logPath) appendFileSync(logPath, `${JSON.stringify({ tool, decision: out.decision, modelName, pathDigest: digests })}\n`);
    } catch { /* log é evidência auxiliar; a decisão não depende dele */ }
    parentPort?.postMessage(out);
  });
}
