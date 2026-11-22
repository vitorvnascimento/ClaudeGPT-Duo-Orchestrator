// Executor Gemini via Antigravity CLI (agy). Contenção (emenda A do spec): gate PreToolUse na worktree,
// HOME privado por cadeia e perfil sandbox-exec. O adaptador só monta a chamada; a ponte prepara os três.
import { existsSync, readFileSync } from "node:fs";
import { loadSchema, validate } from "../schema.js";
import type { ExecutorReport } from "../state/types.js";
import { childEnv } from "../permissions/auth.js";
import { compareVersions } from "./capabilities.js";
import { AGY_MODEL_ID, validateGeminiArgv } from "./gemini-argv.js";
import { writeExecutorSchema } from "./report-schema.js";
import { SANDBOX_EXEC } from "./sandbox-profile.js";
import { classifyErrorText, extractJson, numericFields, type ExecutorAdapter, type InvocationInput, type InvocationPlan, type ParsedOutcome, type StreamParser } from "./types.js";

export type VerifiedAgy = { version: string; platform: NodeJS.Platform };
/** Pares versão+plataforma que passaram na bateria de contenção. Começa vazio: a 1.5.3 só entra depois do gate. */
export const GEMINI_VERIFIED: readonly VerifiedAgy[] = [];
/** Mensagens de ferramenta negada pela contenção (hook do duo, regras da sessão ou sandbox do SO). */
const DENIAL = /denied by pre-tool hook|JSON hook .* failed|failed to unmarshal result from hook|permission check failed|Matches user-configured deny rule|operation not permitted/i;

function readGateModels(path?: string): string[] {
  if (!path || !existsSync(path)) return [];
  const out: string[] = [];
  for (const l of readFileSync(path, "utf8").split("\n")) {
    try { const m = (JSON.parse(l) as { modelName?: unknown }).modelName; if (typeof m === "string" && m && !out.includes(m)) out.push(m); } catch { /* linha parcial */ }
  }
  return out;
}

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
    if (!input.model) throw new Error("executor gemini exige modelo explícito (id do agy models)");
    if (!AGY_MODEL_ID.test(input.model)) throw new Error(`id de modelo inválido para o agy: ${input.model}`);
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

  /** gateLogPath: log do gate no HOME privado; o hook recebe do agy o modelo em uso (evidência de sessão). */
  parser(gateLogPath?: string): StreamParser {
    const events = { total: 0, unknown: 0, malformed: 0 };
    const unknownTypes = new Set<string>();
    const denials = new Map<string, string>();
    let sessionId: string | null = null;
    let result: Record<string, unknown> | null = null;
    return {
      onLine(line: string) {
        events.total++;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line) as Record<string, unknown>; } catch { events.malformed++; return; }
        if (ev.event === "init") { if (typeof ev.conversation_id === "string") sessionId = ev.conversation_id; return; }
        if (ev.event === "result") { result = (ev.result ?? null) as Record<string, unknown> | null; return; }
        if (ev.event !== "step_update") { events.unknown++; unknownTypes.add(String(ev.event)); return; }
        const u = ev.step_update as { state?: string; tool_name?: string; tool_info?: { parameters?: Record<string, unknown>; error?: { message?: string } } } | undefined;
        const msg = u?.tool_info?.error?.message ?? "";
        if (u?.state === "ERROR" && DENIAL.test(msg)) {
          const tool = u.tool_name ?? "?";
          const target = Object.values(u.tool_info?.parameters ?? {}).find((v) => typeof v === "string") ?? "";
          denials.set(`${tool}|${String(target)}`, tool);
        }
      },
      finish(lastMessage: string | null, stderrTail = ""): ParsedOutcome {
        const r = result as { conversation_id?: unknown; status?: unknown; response?: unknown; error?: unknown; num_turns?: unknown; duration_seconds?: unknown; usage?: unknown; denied_actions?: unknown } | null;
        const deniedTools = [...denials.values()];
        for (const d of Array.isArray(r?.denied_actions) ? r.denied_actions as { action?: string }[] : []) {
          const tool = d.action === "command" ? "run_command" : String(d.action ?? "?");
          if (!deniedTools.includes(tool)) deniedTools.push(tool);
        }
        const models = readGateModels(gateLogPath);
        const base: ParsedOutcome = {
          sessionId: typeof r?.conversation_id === "string" && r.conversation_id ? r.conversation_id : sessionId,
          reportedModel: models.at(-1) ?? null,
          ...(models.length ? { mainModels: models } : {}),
          report: null,
          reportErrors: [],
          errorKind: null,
          errorMessage: null,
          usage: numericFields(r?.usage),
          cacheSemantics: "agy: cache_read_tokens e thinking_tokens informados pelo cliente; total_tokens = input + output (observado na 1.5.3). Não somar campos.",
          costUsd: null,
          numTurns: typeof r?.num_turns === "number" ? r.num_turns : null,
          durationMs: typeof r?.duration_seconds === "number" ? Math.round(r.duration_seconds * 1000) : null,
          events,
          unknownTypes: [...unknownTypes],
          permissionDenials: deniedTools.length,
          rateLimit: null,
          warnings: [],
        };
        if (!r) {
          const kind = classifyErrorText(stderrTail);
          return { ...base, errorKind: kind === "unknown" ? "incomplete_stream" : kind, errorMessage: (stderrTail.trim() || "stream terminou sem evento result").slice(0, 500) };
        }
        if (r.status !== "SUCCESS") {
          const detail = [r.error, r.response, stderrTail].filter((x) => typeof x === "string" && x).join(" | ");
          const kind = classifyErrorText(detail);
          return { ...base, errorKind: kind === "unknown" ? "error_envelope" : kind, errorMessage: (typeof r.error === "string" && r.error ? r.error : detail || "status de erro sem detalhe").slice(0, 500) };
        }
        const text = lastMessage ?? (typeof r.response === "string" ? r.response : "");
        if (!text.trim()) {
          if (deniedTools.length) return { ...base, errorKind: "permission_denied", errorMessage: `o agy parou após ação negada pela contenção: ${[...new Set(deniedTools)].join(", ")}` };
          return { ...base, errorKind: "invalid_report", errorMessage: "nenhuma mensagem final do agente" };
        }
        let candidate: unknown;
        try { candidate = extractJson(text); } catch { return { ...base, errorKind: "invalid_report", errorMessage: "mensagem final não é JSON" }; }
        const errs = validate(loadSchema("executor-report"), candidate);
        if (errs.length) return { ...base, errorKind: "invalid_report", reportErrors: errs, errorMessage: "relatório fora do schema" };
        return { ...base, report: candidate as ExecutorReport };
      },
    };
  }
}
