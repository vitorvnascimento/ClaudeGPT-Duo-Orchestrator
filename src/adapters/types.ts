import type { DuoConfig, Provider } from "../config.js";
import type { DelegationRequest, ExecutorReport, TaskKind } from "../state/types.js";
import type { Capabilities } from "./capabilities.js";
import type { Resolved } from "./resolve.js";

export type InvocationInput = {
  resolved: Resolved & { ok: true };
  caps: Capabilities;
  cfg: DuoConfig;
  cwd: string;
  kind: TaskKind;
  prompt: string;
  /** Caminhos absolutos autorizados para escrita (vazio em tarefas de leitura). */
  writableAbs: { abs: string; isDir: boolean }[];
  denyGlobs: string[];
  acceptanceArgv: string[][];
  /** Capacidades exigidas (ex.: image_generation habilita a ferramenta no Codex). */
  needs: string[];
  model: string | null;
  effort?: DelegationRequest["effort"] | null;
  resumeSessionId: string | null;
  artifactsDir: string;
  env: NodeJS.ProcessEnv;
};

export type InvocationPlan = {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  firstSignal: NodeJS.Signals;
  lastMessagePath: string | null;
  /** Restrições aplicadas pelo cliente (e não apenas pedidas no prompt), para registro honesto. */
  enforced: string[];
};

export type ErrorKind =
  | "auth"
  | "quota"
  | "model_unavailable"
  | "error_envelope"
  | "incomplete_stream"
  | "invalid_report"
  | "unknown";

/** Estado de limite informado pelo próprio cliente no stream (observado após a execução, não é pré-verificação). */
export type RateLimitObservation = {
  status: string | null;
  rateLimitType: string | null;
  resetsAt: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean | null;
};

export type ParsedOutcome = {
  sessionId: string | null;
  reportedModel: string | null;
  report: ExecutorReport | null;
  reportErrors: string[];
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  usage: Record<string, number> | null;
  cacheSemantics: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  events: { total: number; unknown: number; malformed: number };
  unknownTypes: string[];
  permissionDenials: number;
  rateLimit: RateLimitObservation | null;
  /** Avisos não fatais emitidos pelo cliente (ex.: orçamento de skills excedido, hook falhando). */
  warnings: string[];
};

export interface StreamParser {
  onLine(line: string): void;
  /** Modelo nativo já observado, disponível antes do término no Claude system/init. */
  observedModel?(): string | null;
  finish(lastMessage: string | null): ParsedOutcome;
}

export interface ExecutorAdapter {
  readonly provider: Provider;
  plan(input: InvocationInput): InvocationPlan;
  parser(): StreamParser;
}

export function classifyErrorText(text: string): ErrorKind {
  if (/usage limit|rate.?limit|limit (reached|exceeded)|quota|too many requests|\b429\b|try again (at|in)|resets? (at|in)/i.test(text)) return "quota";
  if (/not logged in|please run \/login|login expired|unauthori[sz]ed|\b401\b|authentication|invalid api key|oauth/i.test(text)) return "auth";
  if (/model[^.\n]{0,80}(not found|not available|not supported|unsupported|does not exist|invalid|no access)|model_not_found|unknown model|does not support this model|claude_code_version_too_old|or newer is required/i.test(text)) return "model_unavailable";
  return "unknown";
}

/** Extrai JSON de uma mensagem final, tolerando cerca ```json. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced ? (fenced[1] as string) : trimmed);
}

/** Campos numéricos de primeiro nível; sem lista, preserva o esquema nativo inteiro (ex.: campos novos como cache_write_input_tokens). */
export function numericFields(obj: unknown, keys?: string[]): Record<string, number> | null {
  if (typeof obj !== "object" || obj === null) return null;
  const out: Record<string, number> = {};
  for (const k of keys ?? Object.keys(obj)) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
