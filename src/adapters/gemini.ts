// Executor Gemini via Antigravity CLI (agy). Contenção (emenda A do spec): gate PreToolUse na worktree,
// HOME privado por cadeia e perfil sandbox-exec. O adaptador só monta a chamada; a ponte prepara os três.
import { childEnv } from "../permissions/auth.js";
import { compareVersions } from "./capabilities.js";
import { validateGeminiArgv } from "./gemini-argv.js";
import { writeExecutorSchema } from "./report-schema.js";
import { SANDBOX_EXEC } from "./sandbox-profile.js";
import type { ExecutorAdapter, InvocationInput, InvocationPlan, StreamParser } from "./types.js";

export type VerifiedAgy = { version: string; platform: NodeJS.Platform };
/** Pares versão+plataforma que passaram na bateria de contenção. Começa vazio: a 1.5.3 só entra depois do gate. */
export const GEMINI_VERIFIED: readonly VerifiedAgy[] = [];
export const SESSION_GUARD = { allowNonWorkspaceAccess: false, permissions: { deny: ["command(*)"] } };

export function isVerifiedAgy(version: string | null, platform: NodeJS.Platform, list: readonly VerifiedAgy[] = GEMINI_VERIFIED): boolean {
  return !!version && list.some((v) => v.platform === platform && compareVersions(v.version, version) === 0);
}

export class GeminiAdapter implements ExecutorAdapter {
  readonly provider = "gemini" as const;
  private readonly verified: readonly VerifiedAgy[];
  constructor(opts: { verified?: readonly VerifiedAgy[] } = {}) {
    this.verified = opts.verified ?? GEMINI_VERIFIED;
  }

  plan(input: InvocationInput): InvocationPlan {
    const { caps } = input;
    if (caps.missingRequired.length) throw new Error(`esta versão do agy não anuncia recursos obrigatórios: ${caps.missingRequired.join(", ")}`);
    if (!isVerifiedAgy(caps.version, process.platform, this.verified)) {
      throw new Error(`versão ${caps.version ?? "desconhecida"} do agy não verificada nesta plataforma (${process.platform}); rode a sonda de contenção (tests/fixtures/agy/probe) antes de liberar`);
    }
    if (!input.gemini) throw new Error("executor gemini sem HOME privado preparado pela ponte");
    if (!input.model) throw new Error("executor gemini exige modelo explícito (id gemini-*)");
    if (!/^gemini-/.test(input.model)) throw new Error(`modelo fora do catálogo gemini-*: ${input.model}`);
    const args = ["-p=", "--input-format", "stream-json", "--output-format", "stream-json", "--model", input.model, "--settings", JSON.stringify(SESSION_GUARD)];
    const enforced = [
      "gate PreToolUse do duo (.agents/hooks.json): só leitura na worktree e escrita nos alvos autorizados; demais ferramentas negadas",
      "HOME privado por cadeia (sem config, plugins, MCP ou instruções do usuário no agy)",
      `settings da sessão: ${JSON.stringify(SESSION_GUARD)}`,
      "prompt por stdin (stream-json)",
    ];
    if (caps.flags.disableSlashCommands) { args.push("--disable-slash-commands"); enforced.push("disable-slash-commands"); }
    if (caps.flags.jsonSchema) args.push("--json-schema", writeExecutorSchema(input.artifactsDir));
    if (input.resumeSessionId) {
      if (!caps.flags.conversation) throw new Error("esta versão do agy não anuncia --conversation, necessário para retomar");
      args.push("--conversation", input.resumeSessionId);
    }
    const bad = validateGeminiArgv(args);
    if (bad) throw new Error(`argv do agy recusado: ${bad}`);
    const { env } = childEnv(input.env, { HOME: input.gemini.privateHome, TMPDIR: input.gemini.tmpDir });
    const agy = [input.resolved.command, ...input.resolved.prefixArgs];
    let command = agy[0] as string;
    let fullArgs = [...agy.slice(1), ...args];
    if (input.gemini.profilePath) {
      command = SANDBOX_EXEC;
      fullArgs = ["-f", input.gemini.profilePath, ...agy, ...args];
      enforced.push(`sandbox-exec (${input.gemini.profilePath}): escrita só nos alvos, no HOME privado e no TMPDIR`);
    }
    return {
      command,
      args: fullArgs,
      stdin: `${JSON.stringify({ event: "user", message: { role: "user", content: input.prompt } })}\n`,
      cwd: input.cwd,
      env,
      firstSignal: "SIGTERM",
      lastMessagePath: null,
      enforced,
    };
  }

  parser(): StreamParser {
    throw new Error("parser do agy: tarefa 7");
  }
}
