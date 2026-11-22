#!/usr/bin/env node
// Servidor MCP inerte para a sonda P-mcp: expõe uma ferramenta "echo" e só registra chamadas em FAKE_MCP_LOG.
// Se a sonda passar, este log não pode ter nenhum tools/call.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (o) => { if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(o)}\n`); };
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
log({ event: "start" });
for await (const line of createInterface({ input: process.stdin })) {
  let m; try { m = JSON.parse(line); } catch { continue; }
  log({ method: m.method });
  if (m.id === undefined) continue;
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "duoprobe", version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Repete o texto recebido.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (m.method === "tools/call") { log({ event: "CALLED", params: m.params }); send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(m.params?.arguments?.text ?? "") }] } }); }
  else send({ jsonrpc: "2.0", id: m.id, result: {} });
}
