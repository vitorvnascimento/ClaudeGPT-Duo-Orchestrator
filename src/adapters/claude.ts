// Adaptador do Claude Code via `claude -p` (CLI oficial, login de assinatura; nunca --bare).
import { isAbsolute } from "node:path";
import { loadSchema, validate } from "../schema.js";
import { isWriteKind, type ExecutorReport } from "../state/types.js";
import { executorSchemaForCli } from "./report-schema.js";
import {
  classifyErrorText,
  extractJson,
  numericFields,
  type ExecutorAdapter,
  type InvocationInput,
  type InvocationPlan,
  type ParsedOutcome,
  type RateLimitObservation,
  type StreamParser,
} from "./types.js";

const READ_TOOLS = ["Read", "Grep", "Glob"];
const WRITE_TOOLS = [...READ_TOOLS, "Edit", "Write", "Bash"];
/** Comandos que abririam uma segunda cadeia de delegação. Negação explícita vence regras allow do usuário. */
const RECURSION_DENY = ["Bash(claude *)", "Bash(codex *)", "Bash(duo *)", "Bash(npx duo*)", "Bash(npm exec duo*)", "Bash(node *duo-orchestrator*)"];
const GIT_MUTATION_DENY = ["Bash(git reset *)", "Bash(git clean *)", "Bash(git stash *)", "Bash(git checkout *)", "Bash(git push *)", "Bash(git commit *)"];

export const EXECUTOR_SYSTEM_APPEND =
  "You are running as a bounded EXECUTOR for duo-orchestrator (delegation depth 1). " +
  "Never delegate, never invoke other AI CLIs, skills or the duo bridge. Only modify the authorized paths. " +
  "Your final answer must be the JSON object required by the provided schema.";

/** Regra de permissão com caminho absoluto (prefixo // na sintaxe do Claude Code). */
export function absRule(tool: string, abs: string, isDir: boolean): string {
  const posixAbs = abs.replace(/\\/g, "/");
  const withSlash = posixAbs.startsWith("/") ? posixAbs : `/${posixAbs}`;
  return `${tool}(/${withSlash}${isDir ? "/**" : ""})`;
}

export class ClaudeAdapter implements ExecutorAdapter {
  readonly provider = "claude" as const;

  plan(input: InvocationInput): InvocationPlan {
    const { caps, cfg } = input;
    const writes = isWriteKind(input.kind);
    const enforced: string[] = [];
    const args = [...input.resolved.prefixArgs, "-p", "--output-format", "stream-json", "--verbose"];
    args.push("--json-schema", JSON.stringify(executorSchemaForCli()));
    args.push("--permission-mode", "dontAsk");
    enforced.push("permission-mode=dontAsk (ações não pré-aprovadas são negadas pelo cliente)");
    if (caps.flags.permissionPrompts) {
      // >= 2.1.259: ninguém aprova nada durante a delegação; o Claude é avisado para não repetir ações negadas.
      args.push("--permission-prompts", "none");
      enforced.push("permission-prompts=none (sem espera por aprovação; ações negadas não são repetidas)");
    }

    args.push("--tools", (writes ? WRITE_TOOLS : READ_TOOLS).join(","));
    enforced.push(`tools=${(writes ? WRITE_TOOLS : READ_TOOLS).join(",")}`);

    const allow: string[] = [];
    if (writes) {
      for (const w of input.writableAbs) {
        allow.push(absRule("Edit", w.abs, w.isDir), absRule("Write", w.abs, w.isDir));
      }
      // Exato + com argumentos extras (ex.: `node check.mjs --verbose`); formas compostas continuam negadas.
      for (const argv of input.acceptanceArgv) allow.push(`Bash(${argv.join(" ")})`, `Bash(${argv.join(" ")} *)`);
    }
    if (allow.length) args.push("--allowedTools", ...allow);

    const root = input.cwd.replace(/\\/g, "/");
    const deny = [...RECURSION_DENY, ...GIT_MUTATION_DENY];
    for (const g of input.denyGlobs) {
      const p = isAbsolute(g) ? g : `${root}/${g}`;
      for (const tool of ["Read", "Edit", "Write"]) deny.push(`${tool}(/${p.startsWith("/") ? p : `/${p}`})`);
    }
    args.push("--disallowedTools", ...deny);
    enforced.push("disallowedTools: recursão (claude/codex/duo), git destrutivo, caminhos protegidos");

    if (caps.flags.settingSources && cfg.executors.claude.settingSources) {
      args.push("--setting-sources", cfg.executors.claude.settingSources);
      enforced.push(`setting-sources=${cfg.executors.claude.settingSources} (hooks/settings do projeto não carregados)`);
    }
    if (caps.flags.strictMcpConfig && cfg.executors.claude.strictMcpConfig) {
      args.push("--strict-mcp-config");
      enforced.push("strict-mcp-config sem --mcp-config (nenhum servidor MCP)");
    }
    if (caps.flags.disableSlashCommands && cfg.executors.claude.disableSlashCommands) {
      args.push("--disable-slash-commands");
      enforced.push("disable-slash-commands (skills desativadas no executor)");
    }
    if (caps.flags.appendSystemPrompt) args.push("--append-system-prompt", EXECUTOR_SYSTEM_APPEND);
    if (input.model) args.push("--model", input.model);
    if (input.effort) {
      if (!caps.flags.effort) throw new Error("esforço solicitado, mas esta versão do claude não anuncia --effort");
      args.push("--effort", input.effort);
    }
    if (input.resumeSessionId) {
      if (!caps.flags.resume) throw new Error("esta versão do claude não anuncia --resume");
      args.push("--resume", input.resumeSessionId);
    }
    return {
      command: input.resolved.command,
      args,
      stdin: input.prompt,
      cwd: input.cwd,
      env: input.env,
      firstSignal: "SIGINT",
      lastMessagePath: null,
      enforced,
    };
  }

  parser(): StreamParser {
    const events = { total: 0, unknown: 0, malformed: 0 };
    const unknownTypes = new Set<string>();
    let sessionId: string | null = null;
    let model: string | null = null;
    let result: Record<string, unknown> | null = null;
    let lastRetryError: string | null = null;
    let permissionDenials = 0;
    let rateLimit: RateLimitObservation | null = null;
    const warnings: string[] = [];
    return {
      observedModel: () => model,
      onLine(line: string) {
        events.total++;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          events.malformed++;
          return;
        }
        const type = String(ev.type ?? "");
        if (typeof ev.session_id === "string") sessionId = ev.session_id;
        if (type === "system") {
          if (ev.subtype === "init" && typeof ev.model === "string") model = ev.model;
          if (ev.subtype === "api_retry" && typeof ev.error === "string") lastRetryError = ev.error;
          if (ev.subtype === "permission_denied") permissionDenials++;
          if (ev.subtype === "notification" && /error|fail/i.test(String(ev.key ?? "")) && warnings.length < 10) warnings.push(`${String(ev.key)}: ${String(ev.text ?? "")}`.slice(0, 300));
        } else if (type === "result") {
          result = ev;
        } else if (type === "rate_limit_event") {
          // Campo observado na CLI 2.1.114 (não descrito na página headless consultada): tratado como informativo.
          const info = ev.rate_limit_info as Record<string, unknown> | undefined;
          if (info) {
            const s = (k: string) => (typeof info[k] === "string" ? (info[k] as string) : null);
            rateLimit = {
              status: s("status"),
              rateLimitType: s("rateLimitType"),
              resetsAt: typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : null,
              overageStatus: s("overageStatus"),
              overageDisabledReason: s("overageDisabledReason"),
              isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null,
            };
          }
        } else if (!["assistant", "user", "stream_event", "tool_progress", "auth_status", "rate_limit_event"].includes(type)) {
          events.unknown++;
          unknownTypes.add(type || "(sem type)");
        }
      },
      finish(): ParsedOutcome {
        const base: ParsedOutcome = {
          sessionId,
          reportedModel: model,
          report: null,
          reportErrors: [],
          errorKind: null,
          errorMessage: null,
          usage: null,
          cacheSemantics: "Claude: input_tokens exclui cache_read_input_tokens e cache_creation_input_tokens (contadores separados; não somar como se fossem subconjuntos).",
          costUsd: null,
          numTurns: null,
          durationMs: null,
          events,
          unknownTypes: [...unknownTypes],
          permissionDenials,
          rateLimit,
          warnings,
        };
        const r = result as Record<string, unknown> | null;
        if (!r) {
          const kind = lastRetryError === "rate_limit" || (rateLimit && rateLimit.status !== null && rateLimit.status !== "allowed" && rateLimit.status !== "allowed_warning") ? "quota" : lastRetryError === "authentication_failed" ? "auth" : lastRetryError === "model_not_found" ? "model_unavailable" : "incomplete_stream";
          return { ...base, errorKind: kind, errorMessage: `stream terminou sem evento result${lastRetryError ? ` (último api_retry: ${lastRetryError})` : ""}` };
        }
        base.usage = numericFields(r.usage, ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]);
        base.costUsd = typeof r.total_cost_usd === "number" ? r.total_cost_usd : null;
        base.numTurns = typeof r.num_turns === "number" ? r.num_turns : null;
        base.durationMs = typeof r.duration_ms === "number" ? r.duration_ms : null;
        if (Array.isArray(r.permission_denials)) base.permissionDenials = Math.max(base.permissionDenials, r.permission_denials.length);
        if (r.modelUsage && typeof r.modelUsage === "object") {
          // Todo modelo que consumiu tokens conta: a confirmação confere cada um (cobrança, piso e independência).
          base.usedModels = Object.keys(r.modelUsage as object).filter((k) => typeof k === "string" && k.length > 0);
          if (!base.reportedModel) base.reportedModel = base.usedModels[0] ?? null;
        }
        const text = typeof r.result === "string" ? r.result : "";
        if (r.is_error === true || (typeof r.subtype === "string" && r.subtype !== "success")) {
          const kind = classifyErrorText(`${text} ${String(r.subtype ?? "")} ${lastRetryError ?? ""}`);
          return { ...base, errorKind: kind === "unknown" ? "error_envelope" : kind, errorMessage: `${String(r.subtype ?? "erro")}: ${text.slice(0, 500)}` };
        }
        let candidate: unknown = r.structured_output;
        if (candidate === undefined) {
          try {
            candidate = extractJson(text);
          } catch {
            return { ...base, errorKind: "invalid_report", errorMessage: "resultado sem structured_output e sem JSON válido" };
          }
        }
        const errs = validate(loadSchema("executor-report"), candidate);
        if (errs.length) return { ...base, errorKind: "invalid_report", reportErrors: errs, errorMessage: "relatório fora do schema" };
        return { ...base, report: candidate as ExecutorReport };
      },
    };
  }
}
