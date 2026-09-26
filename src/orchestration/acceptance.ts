// Critérios de aceite executados pela própria ponte, sem shell e só a partir de uma allowlist do usuário.
// Atenção: um script de teste executa código arbitrário do repositório com as permissões do usuário.
import type { DuoConfig } from "../config.js";
import { runProcess } from "../adapters/process.js";
import { resolveExecutable } from "../adapters/resolve.js";
import { redact } from "../redact.js";
import type { AcceptanceResult } from "../state/types.js";

export function isAllowlisted(argv: string[], allowed: string[][]): boolean {
  return allowed.some((prefix) => prefix.length > 0 && prefix.length <= argv.length && prefix.every((x, i) => argv[i] === x));
}

export async function runAcceptance(
  commands: { name: string; argv: string[] }[],
  cfg: DuoConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<AcceptanceResult[]> {
  const results: AcceptanceResult[] = [];
  for (const c of commands) {
    const base = { name: c.name, argv: c.argv };
    if (!isAllowlisted(c.argv, cfg.acceptance.allowedCommands)) {
      results.push({ ...base, ran: false, exitCode: null, passed: false, durationMs: 0, outputTail: "", skippedReason: "não está em acceptance.allowedCommands" });
      continue;
    }
    const resolved = resolveExecutable(c.argv[0] as string, null, env);
    if (!resolved.ok) {
      results.push({ ...base, ran: false, exitCode: null, passed: false, durationMs: 0, outputTail: "", skippedReason: resolved.reason });
      continue;
    }
    const r = await runProcess({
      command: resolved.command,
      args: c.argv.slice(1),
      cwd,
      env,
      timeoutMs: cfg.limits.acceptanceTimeoutSec * 1000,
      maxOutputBytes: 5 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    const tail = redact(`${r.stdoutTail.slice(-4000)}${r.stderrTail ? `\n[stderr]\n${r.stderrTail.slice(-2000)}` : ""}`);
    results.push({
      ...base,
      ran: true,
      exitCode: r.exitCode,
      passed: r.exitCode === 0 && !r.timedOut && !r.cancelled && !r.outputLimitExceeded,
      durationMs: r.durationMs,
      outputTail: r.timedOut ? `${tail}\n[timeout]` : tail,
    });
  }
  return results;
}
