// Comum aos hooks de sonda: lê a chamada do agy no stdin e registra uma linha JSON no log (argv[2]).
// No Windows, pega o nome do processo pai e do avô enquanto ainda estão vivos (responde qual shell rodou o hook).
// Best effort: falha ao ler ou gravar nunca muda a resposta do hook.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

function parentChain() {
  if (process.platform !== "win32") return null;
  const ps = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.ppid}'; $g=$null; if ($p) { $g=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId) }; "$($p.Name)|$($g.Name)"`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 4000 });
  const [parent, grandparent] = (r.stdout ?? "").trim().split("|");
  return { parent: parent || null, grandparent: grandparent || null, error: r.error?.code ?? null };
}

export function record(hook) {
  let input = null;
  let stdinError = null;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch (e) { stdinError = e.code ?? e.name ?? "erro"; }
  try {
    const call = input?.toolCall ?? {};
    appendFileSync(process.argv[2], `${JSON.stringify({
      hook,
      argv: process.argv.slice(1),
      ppid: process.ppid,
      parents: parentChain(),
      stdinError,
      toolName: typeof call.name === "string" ? call.name : null,
      args: call.args ?? null,
      modelName: typeof input?.modelName === "string" ? input.modelName : null,
      keys: input && typeof input === "object" ? Object.keys(input) : [],
    })}\n`);
  } catch { /* log é evidência auxiliar */ }
  return input;
}
