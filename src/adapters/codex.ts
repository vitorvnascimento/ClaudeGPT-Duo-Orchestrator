// Adaptador do Codex via `codex exec --json` (CLI oficial, login ChatGPT).
// Não usa `codex mcp-server` nem o binário embutido na extensão do VS Code.
import { join } from "node:path";
import { loadSchema, validate } from "../schema.js";
import { isWriteKind, type ExecutorReport } from "../state/types.js";
import { writeExecutorSchema } from "./report-schema.js";
import {
  classifyErrorText,
  extractJson,
  numericFields,
  type ExecutorAdapter,
  type InvocationInput,
  type InvocationPlan,
  type ParsedOutcome,
  type StreamParser,
} from "./types.js";

const KNOWN_ITEM_TYPES = new Set([
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "plan_update",
  "error",
]);

export class CodexAdapter implements ExecutorAdapter {
  readonly provider = "codex" as const;

  plan(input: InvocationInput): InvocationPlan {
    const { caps, cfg } = input;
    const writes = isWriteKind(input.kind);
    const enforced: string[] = [];
    const schemaPath = writeExecutorSchema(input.artifactsDir);
    const lastMessagePath = caps.flags.outputLastMessage ? join(input.artifactsDir, "last-message.json") : null;
    const sandbox = writes ? "workspace-write" : "read-only";
    // `codex exec resume` (0.157.1) não aceita --sandbox/--cd: as opções vão depois do subcomando,
    // o sandbox via -c sandbox_mode e o diretório pelo cwd do processo.
    const resuming = input.resumeSessionId !== null;
    if (resuming && !caps.flags.config) throw new Error("esta versão do codex não anuncia --config, necessário para aplicar o sandbox na retomada");
    const args = [...input.resolved.prefixArgs, "exec", ...(resuming ? ["resume"] : []), "--json"];
    if (resuming) args.push("--config", `sandbox_mode="${sandbox}"`);
    else args.push("--sandbox", sandbox);
    enforced.push(`sandbox=${sandbox} (imposto pelo SO via Codex; leitura de disco não é restringida)`);
    if (writes && caps.flags.config) {
      args.push("--config", "sandbox_workspace_write.network_access=false");
      enforced.push("rede desativada no sandbox (impede chamar outra IA a partir do executor)");
    }
    if (!resuming) args.push("--cd", input.cwd);
    args.push("--output-schema", schemaPath);
    if (lastMessagePath) args.push("--output-last-message", lastMessagePath);
    if (cfg.executors.codex.ignoreUserConfig && caps.flags.ignoreUserConfig) {
      args.push("--ignore-user-config");
      enforced.push("ignore-user-config (MCPs/perfis do usuário não carregados)");
    }
    if (cfg.executors.codex.disableUserExtensions && caps.flags.disable) {
      // Hooks de plugins do usuário (ex.: Ruflo) gravavam arquivos no projeto durante a delegação real.
      args.push("--disable", "hooks", "--disable", "plugins");
      enforced.push("hooks e plugins do usuário desligados no executor (--disable hooks/plugins)");
    }
    if (input.model) args.push("--model", input.model);
    if (input.needs.includes("image_generation")) {
      if (!caps.flags.enable) throw new Error("esta versão do codex não anuncia --enable, necessário para ligar image_generation");
      args.push("--enable", "image_generation");
      enforced.push("ferramenta image_generation habilitada explicitamente");
    }
    if (input.resumeSessionId) args.push(input.resumeSessionId, "-");
    else args.push("-");
    return {
      command: input.resolved.command,
      args,
      stdin: input.prompt,
      cwd: input.cwd,
      env: input.env,
      firstSignal: "SIGTERM",
      lastMessagePath,
      enforced,
    };
  }

  parser(): StreamParser {
    const events = { total: 0, unknown: 0, malformed: 0 };
    const unknownTypes = new Set<string>();
    let sessionId: string | null = null;
    let turnCompleted = false;
    let failure: string | null = null;
    let lastAgentMessage: string | null = null;
    let usage: Record<string, number> | null = null;
    let turns = 0;
    const warnings: string[] = [];
    return {
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
        switch (type) {
          case "thread.started":
            if (typeof ev.thread_id === "string") sessionId = ev.thread_id;
            break;
          case "turn.started":
            turns++;
            break;
          case "turn.completed": {
            turnCompleted = true;
            const u = numericFields(ev.usage);
            if (u) {
              usage = usage ?? {};
              for (const [k, v] of Object.entries(u)) usage[k] = (usage[k] ?? 0) + v;
            }
            break;
          }
          case "turn.failed": {
            const err = ev.error as { message?: unknown } | undefined;
            failure = typeof err?.message === "string" ? err.message : "turn.failed";
            break;
          }
          case "error":
            failure = typeof ev.message === "string" ? ev.message : "error";
            break;
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const item = ev.item as Record<string, unknown> | undefined;
            const itemType = String(item?.type ?? "");
            if (!KNOWN_ITEM_TYPES.has(itemType)) {
              events.unknown++;
              unknownTypes.add(`item:${itemType || "?"}`);
            }
            // Texto de raciocínio (reasoning) nunca é guardado.
            if (type === "item.completed" && itemType === "agent_message" && typeof item?.text === "string") lastAgentMessage = item.text;
            if (type === "item.completed" && itemType === "error" && typeof item?.message === "string" && warnings.length < 10) warnings.push(item.message.slice(0, 300));
            break;
          }
          default:
            events.unknown++;
            unknownTypes.add(type || "(sem type)");
        }
      },
      finish(lastMessage: string | null): ParsedOutcome {
        const base: ParsedOutcome = {
          sessionId,
          reportedModel: null,
          report: null,
          reportErrors: [],
          errorKind: null,
          errorMessage: null,
          usage,
          cacheSemantics:
            "Codex: cached_input_tokens é subconjunto de input_tokens (semântica OpenAI). cache_write_input_tokens (observado na 0.157.1) e reasoning_output_tokens não têm relação documentada com os demais: não somar.",
          costUsd: null,
          numTurns: turns || null,
          durationMs: null,
          events,
          unknownTypes: [...unknownTypes],
          permissionDenials: 0,
          rateLimit: null,
          warnings,
        };
        if (failure && !turnCompleted) {
          const kind = classifyErrorText(failure);
          return { ...base, errorKind: kind === "unknown" ? "error_envelope" : kind, errorMessage: failure.slice(0, 500) };
        }
        if (!turnCompleted) return { ...base, errorKind: "incomplete_stream", errorMessage: "stream terminou sem turn.completed" };
        const text = lastMessage ?? lastAgentMessage;
        if (!text) return { ...base, errorKind: "invalid_report", errorMessage: "nenhuma mensagem final do agente" };
        let candidate: unknown;
        try {
          candidate = extractJson(text);
        } catch {
          return { ...base, errorKind: "invalid_report", errorMessage: "mensagem final não é JSON" };
        }
        const errs = validate(loadSchema("executor-report"), candidate);
        if (errs.length) return { ...base, errorKind: "invalid_report", reportErrors: errs, errorMessage: "relatório fora do schema" };
        return { ...base, report: candidate as ExecutorReport };
      },
    };
  }
}
