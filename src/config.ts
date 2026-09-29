import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { duoDir } from "./paths.js";

export type Provider = "claude" | "codex";
export type Policy = "economico" | "equilibrado" | "qualidade";
export type QuotaPreference = "balance" | "preserve-codex" | "preserve-claude";

export type ExecutorConfig = {
  /** Caminho absoluto opcional (ex.: .exe no Windows ou ["node", "/abs/cli.js"]). Padrão: resolver no PATH. */
  command: string[] | null;
  model: string | null;
};

export type DuoConfig = {
  version: 1;
  defaultBrain: Provider;
  policy: Policy;
  quotaPreference: QuotaPreference;
  limits: {
    maxDelegationsPerRun: number;
    qualityBudgetAuthorized: boolean;
    maxConcurrentExecutors: 1;
    timeoutSec: number;
    maxPromptBytes: number;
    maxOutputBytes: number;
    maxSnapshotBytes: number;
    acceptanceTimeoutSec: number;
  };
  executors: {
    claude: ExecutorConfig & {
      /** Carrega apenas estas fontes de settings no executor; "user" evita hooks de projetos não confiáveis. */
      settingSources: string;
      strictMcpConfig: boolean;
      disableSlashCommands: boolean;
    };
    codex: ExecutorConfig & {
      ignoreUserConfig: boolean;
      /** Desliga hooks e plugins do usuário no executor (--disable hooks/plugins): evita que gravem no projeto e economiza contexto. */
      disableUserExtensions: boolean;
    };
  };
  billing: {
    profile: "subscription-only";
    /** Crédito/uso extra da conta não é verificável pelas interfaces oficiais; exige ciência explícita. */
    acknowledgeUnverifiableExtraUsage: Record<Provider, boolean>;
  };
  acceptance: {
    /** Prefixos de argv que a ponte pode executar como critério de aceite (sem shell). */
    allowedCommands: string[][];
  };
  scope: {
    deny: string[];
  };
  routing: {
    /** Candidatos usados só quando o catálogo das contas não pode ser descoberto (duo models). */
    candidates: { executor: Provider; model: string | null }[];
    /** Se definido, restringe o roteador a estes modelos ("claude:claude-opus-5-5", "codex:gpt-6-astra"). */
    include: string[] | null;
    /** Modelos que o roteador nunca recomenda ("provider:modelo"). */
    exclude: string[];
    /** Mínimo de tarefas comparáveis para a evidência contar como suficiente. */
    minSamples: number;
    /** Preferências declaradas pelo usuário (não são medição); bônus limitado a [-0.2, 0.2]. */
    priors: { executor: Provider; model?: string | null; kind?: string; tag?: string; needs?: string; bonus: number; note: string }[];
  };
};

export const DEFAULT_CONFIG: DuoConfig = {
  version: 1,
  defaultBrain: "claude",
  policy: "economico",
  quotaPreference: "balance",
  limits: {
    maxDelegationsPerRun: 2,
    qualityBudgetAuthorized: false,
    maxConcurrentExecutors: 1,
    timeoutSec: 600,
    maxPromptBytes: 60_000,
    maxOutputBytes: 20 * 1024 * 1024,
    maxSnapshotBytes: 20 * 1024 * 1024,
    acceptanceTimeoutSec: 300,
  },
  executors: {
    // Preferência do usuário: Opus 5.5 como executor Claude. Exige Claude Code >= 2.1.280 (erro real observado na 2.1.114).
    claude: { command: null, model: "claude-opus-5-5", settingSources: "user", strictMcpConfig: true, disableSlashCommands: true },
    codex: { command: null, model: null, ignoreUserConfig: false, disableUserExtensions: true },
  },
  billing: {
    profile: "subscription-only",
    acknowledgeUnverifiableExtraUsage: { claude: false, codex: false },
  },
  acceptance: { allowedCommands: [] },
  scope: {
    deny: [
      ".git/**",
      ".duo/**",
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "**/*.p12",
      "**/id_rsa*",
      "**/id_ed25519*",
      "**/.npmrc",
      "**/.netrc",
      "**/credentials*",
      "**/secrets/**",
      "**/auth.json",
      "**/.credentials.json",
    ],
  },
  routing: {
    candidates: [
      { executor: "claude", model: "claude-opus-5-5" },
      { executor: "codex", model: null },
    ],
    include: null,
    exclude: [],
    minSamples: 3,
    priors: [],
  },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out && isObj(out[k]) && isObj(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

export function configPath(projectRoot: string): string {
  return join(duoDir(projectRoot), "config.json");
}

export class ConfigError extends Error {}

export function loadConfig(projectRoot: string): DuoConfig {
  const p = configPath(projectRoot);
  if (!existsSync(p)) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new ConfigError(`config inválida em ${p}: ${(e as Error).message}`);
  }
  const cfg = merge(structuredClone(DEFAULT_CONFIG), raw);
  const problems: string[] = [];
  if (!["claude", "codex"].includes(cfg.defaultBrain)) problems.push("defaultBrain");
  if (!["economico", "equilibrado", "qualidade"].includes(cfg.policy)) problems.push("policy");
  if (!["balance", "preserve-codex", "preserve-claude"].includes(cfg.quotaPreference)) problems.push("quotaPreference");
  if (!Number.isInteger(cfg.limits.maxDelegationsPerRun) || cfg.limits.maxDelegationsPerRun < 1) problems.push("limits.maxDelegationsPerRun");
  if (cfg.limits.maxConcurrentExecutors !== 1) problems.push("limits.maxConcurrentExecutors (o MVP só aceita 1)");
  for (const field of ["timeoutSec", "acceptanceTimeoutSec"] as const) {
    const value = cfg.limits[field];
    if (!Number.isInteger(value) || value < 1 || value > 86400) problems.push(`limits.${field} (inteiro de 1 a 86400 segundos)`);
  }
  for (const field of ["maxOutputBytes", "maxPromptBytes", "maxSnapshotBytes"] as const) {
    const value = cfg.limits[field];
    if (!Number.isInteger(value) || value < 1 || value > 1024 * 1024 * 1024) problems.push(`limits.${field} (inteiro de 1 a 1073741824 bytes)`);
  }
  if (cfg.billing.profile !== "subscription-only") problems.push("billing.profile (o MVP só implementa subscription-only)");
  if (!Array.isArray(cfg.acceptance.allowedCommands) || !cfg.acceptance.allowedCommands.every((c) => Array.isArray(c) && c.every((x) => typeof x === "string"))) {
    problems.push("acceptance.allowedCommands");
  }
  if (!Array.isArray(cfg.routing.candidates) || !cfg.routing.candidates.every((c) => (c.executor === "claude" || c.executor === "codex") && (c.model === null || typeof c.model === "string"))) {
    problems.push("routing.candidates");
  }
  if (!Number.isInteger(cfg.routing.minSamples) || cfg.routing.minSamples < 1) problems.push("routing.minSamples");
  if (!Array.isArray(cfg.routing.priors) || !cfg.routing.priors.every((p) => typeof p.bonus === "number" && Math.abs(p.bonus) <= 0.2 && typeof p.note === "string")) {
    problems.push("routing.priors (bonus entre -0.2 e 0.2, com note)");
  }
  if (problems.length) throw new ConfigError(`config inválida em ${p}: ${problems.join(", ")}`);
  return cfg;
}
