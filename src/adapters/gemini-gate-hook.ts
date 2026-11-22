#!/usr/bin/env node
// Hook PreToolUse do agy: lê a chamada no stdin, decide pela allowlist do duo e responde no stdout.
// Qualquer erro vira "deny" (e, se nem isso sair, o agy nega porque o hook falhou).
import { appendFileSync, readFileSync } from "node:fs";
import { decideToolCall, type GateAllowlist, type GateDecision } from "./gemini-gate.js";

let input: unknown = null;
let out: GateDecision;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
  const allow = JSON.parse(readFileSync(process.env.DUO_GATE_ALLOWLIST ?? "", "utf8")) as GateAllowlist;
  out = decideToolCall(input, allow);
} catch (e) {
  out = { decision: "deny", reason: `duo-gate: erro: ${(e as Error).message}` };
}
try {
  const i = input as { toolCall?: { name?: unknown }; modelName?: unknown } | null;
  const tool = typeof i?.toolCall?.name === "string" ? i.toolCall.name : null;
  const modelName = typeof i?.modelName === "string" ? i.modelName : null;
  if (process.env.DUO_GATE_LOG) appendFileSync(process.env.DUO_GATE_LOG, `${JSON.stringify({ tool, decision: out.decision, modelName })}\n`);
} catch { /* log é evidência auxiliar; a decisão não depende dele */ }
process.stdout.write(JSON.stringify(out));
