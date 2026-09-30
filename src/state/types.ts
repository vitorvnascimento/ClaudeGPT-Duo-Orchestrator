import type { CodexRolloutEvidence } from "../adapters/codex-rollout.js";
import type { Effort, Tier } from "../adapters/tiers.js";
import type { Policy, Provider } from "../config.js";

export type TaskState = "planned" | "approved" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";
export type TaskKind = "implement" | "review" | "test" | "investigate" | "asset";

/** Tipos que podem escrever no escopo. */
export const WRITE_KINDS: readonly TaskKind[] = ["implement", "test", "asset"];
export const isWriteKind = (k: TaskKind): boolean => WRITE_KINDS.includes(k);
export type DelegationReason = "user_requested" | "clear_benefit" | "blocked_or_failure" | "second_opinion" | "cross_review";

export type DelegationRequest = {
  version: 1;
  runId?: string;
  taskKey?: string;
  brain: Provider;
  executor: Provider;
  kind: TaskKind;
  objective: string;
  reason: DelegationReason;
  rationale: string;
  risk?: "low" | "medium" | "high";
  model?: string;
  complexity?: Tier;
  adaptive?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Modelo do próprio cérebro, quando conhecido (evita delegar ao mesmo modelo). */
  brainModel?: string;
  /** Capacidades exigidas pela subtarefa (ex.: image_generation). */
  needs?: ("code" | "image_generation")[];
  isolation?: "in-place" | "worktree";
  scope: { allowedPaths: string[] };
  constraints?: string[];
  context?: { interfaces?: string; decisions?: string[]; notes?: string };
  acceptance: { criteria: string[]; commands?: { name: string; argv: string[] }[] };
  limits?: { timeoutSec?: number };
};

export type ExecutorReport = {
  status: "completed" | "partial" | "blocked" | "failed";
  summary: string;
  filesChanged: string[];
  testsRun: { command: string; exitCode: number | null; passed: boolean }[];
  limitations: string[];
  blockedReason: string | null;
};

export type AcceptanceResult = {
  name: string;
  argv: string[];
  ran: boolean;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  outputTail: string;
  skippedReason?: string;
};

/** Origem de cada métrica: nunca misturar medida nativa com estimativa. */
export type MetricSource = "native" | "local-estimate" | "local-measure" | "manual" | "unavailable";

export type TaskMetrics = {
  wallMs: number;
  promptBytes: number;
  promptTokensEstimate: { value: number; source: "local-estimate"; method: string };
  native: {
    source: MetricSource;
    provider: Provider;
    capturedAt: string;
    /** Uso no esquema do próprio cliente (sem conversão entre fornecedores). */
    usage: Record<string, number> | null;
    cacheSemantics: string;
    costUsdClientEstimate: number | null;
    numTurns: number | null;
    durationMs: number | null;
    /** Limite/uso extra informado pelo cliente durante a execução (observado depois, não verificado antes). */
    rateLimit: import("../adapters/types.js").RateLimitObservation | null;
  };
  events: { total: number; unknown: number; malformed: number; oversize: number };
};

export type Verification = {
  filesChangedActual: string[];
  outOfScope: string[];
  deniedTouched: string[];
  claimsMismatch: string[];
  acceptance: AcceptanceResult[];
  staleBase: boolean;
  lockIntact: boolean;
  partialWork: boolean;
  diffPath: string | null;
  patchPath: string | null;
  /** Arquivos de imagem válidos (assinatura binária conferida) produzidos no escopo. */
  images?: { path: string; format: string; bytes: number; width: number | null; height: number | null }[];
};

export type Selection = {
  chainId?: string;
  adaptive: boolean;
  tier: Tier;
  complexitySignals: string[];
  model: string | null;
  effort: string | null;
  reason: string[];
  attempt: number;
  attemptOf: string | null;
  chainRoot?: string;
  /** Somente leitura de auditorias antigas; novas tentativas guardam a cadeia em Chain. */
  origin?: { model: "explicit" | "auto"; effort: "explicit" | "auto" };
  fallbacks?: { from: { executor: Provider; model: string | null }; to: { executor: Provider; model: string | null }; reason: string; resetsAt: string | null }[];
  escalatedFrom?: { model: string | null; effort: string | null; reason: string };
};
export type ChainAttempt = {
  taskId: string;
  attempt: number;
  executor: Provider;
  model: string | null;
  effort: Effort | null;
  tier: Tier;
  reason: "initial" | "escalation" | "quota" | "capacity" | "resume";
  state: TaskState;
  /** Cooldown observado nesta tentativa, preservado mesmo sem o cache global. */
  capacityUntil?: string;
};
export type Chain = {
  version: 1;
  chainId: string;
  runId: string;
  taskKey: string | null;
  requestHash: string;
  originalRequestPath: string;
  floorTier: Tier;
  minTier: Tier;
  minEffort: Effort | null;
  origin: { model: "explicit" | "auto"; effort: "explicit" | "auto" };
  attempts: ChainAttempt[];
  status: "running" | "succeeded" | "failed" | "blocked" | "cancelled";
  latestTaskId: string;
  updatedAt: string;
  /** Reserva entre gates/tentativas; o lock de arquivo só cobre transações curtas. */
  owner: { pid: number; nonce: string } | null;
};

export type Task = {
  selection?: Selection;
  taskId: string;
  runId: string;
  taskKey?: string;
  state: TaskState;
  history: { at: string; from: TaskState | null; to: TaskState; reason: string }[];
  createdAt: string;
  updatedAt: string;
  brain: Provider;
  executor: Provider;
  kind: TaskKind;
  objective: string;
  reason: DelegationReason;
  rationale: string;
  risk: "low" | "medium" | "high";
  /** Modelo do cérebro informado no pedido (auditoria e regra de mesmo fornecedor). */
  brainModel?: string | null;
  /** Extensões de arquivo do escopo (ex.: "ts", "py"): usadas para comparar tarefas no roteador. */
  tags: string[];
  needs: ("code" | "image_generation")[];
  isolation: "in-place" | "worktree";
  scope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  acceptanceCommands: { name: string; argv: string[] }[];
  requestHash: string;
  base: { head: string | null; dirtyInScope: string[]; hashes: Record<string, string | null> } | null;
  model: { requested: string | null; reported: string | null; reportedSource: MetricSource; reportedVia?: string };
  /** Provas pós-execução registradas pelo próprio cliente (ex.: rollout do Codex) e origem das imagens. */
  evidence?: {
    codex?: CodexRolloutEvidence | null;
    images?: { path: string; sha256: string; generatedByExecutorTool: boolean }[];
  };
  effort?: { requested: string | null };
  native: { sessionId: string | null };
  pids: { bridge: number | null; child: number | null };
  invocations: number;
  artifactsDir: string;
  worktree: string | null;
  applied: boolean;
  executorReport: ExecutorReport | null;
  verification: Verification | null;
  metrics: TaskMetrics | null;
  outcome: string | null;
  limitations: string[];
  retryOf?: string;
  accepted?: { at: string; accepted: boolean; note: string };
};

export type Run = {
  runId: string;
  brain: Provider;
  policy: Policy;
  createdAt: string;
  updatedAt: string;
  cancelled: boolean;
  invocations: number;
  taskIds: string[];
  decisions: { at: string; taskId?: string; kind: "accepted" | "rejected" | "note"; text: string }[];
  nextStep: string | null;
};
