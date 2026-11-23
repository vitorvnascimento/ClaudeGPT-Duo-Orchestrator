// Comum aos hooks de sonda: lê a chamada do agy no stdin e registra uma linha JSON no log (argv[2]).
// Best effort: falha ao ler ou gravar nunca muda a resposta do hook.
import { appendFileSync, readFileSync } from "node:fs";

export function record(hook) {
  let input = null;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* entrada inválida fica registrada como null */ }
  try {
    const call = input?.toolCall ?? {};
    appendFileSync(process.argv[2], `${JSON.stringify({
      hook,
      argv: process.argv.slice(1),
      ppid: process.ppid,
      comspec: process.env.ComSpec ?? null,
      toolName: typeof call.name === "string" ? call.name : null,
      args: call.args ?? null,
      modelName: typeof input?.modelName === "string" ? input.modelName : null,
      keys: input && typeof input === "object" ? Object.keys(input) : [],
    })}\n`);
  } catch { /* log é evidência auxiliar */ }
  return input;
}
