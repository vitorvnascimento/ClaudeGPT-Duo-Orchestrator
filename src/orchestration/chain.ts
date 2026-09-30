import { isPidAlive } from "../adapters/process.js";
import { EFFORTS, type Effort, type Tier } from "../adapters/tiers.js";
import type { Chain, Task } from "../state/types.js";
import { TIERS, tierRank } from "./complexity.js";

export const effortRank = (effort: string | null | undefined): number => EFFORTS.indexOf(effort as Effort);
export const maxTier = (...tiers: Tier[]): Tier => TIERS[Math.max(...tiers.map(tierRank))]!;
export const maxEffort = (...efforts: (string | null | undefined)[]): Effort | null => EFFORTS[Math.max(...efforts.map(effortRank))] ?? null;
export const chainStatus = (state: Task["state"]): Chain["status"] => state === "planned" || state === "approved" ? "blocked" : state;

/** Todas as decisões da cadeia usam este registro, nunca linhagem/snapshots de tasks. */
export function chainPolicy(chain: Chain, options: { resumeTaskId?: string; maxAttempts?: number; now?: number } = {}) {
  const running = chain.status === "running" && !!chain.owner && isPidAlive(chain.owner.pid);
  let resumeError: string | null = null;
  if (options.resumeTaskId && options.resumeTaskId !== chain.latestTaskId) {
    resumeError = `tentativa substituída; a cadeia ${chain.chainId} está em ${chain.status}, última tentativa ${chain.latestTaskId}`;
  } else if (options.resumeTaskId && running) {
    resumeError = `cadeia ${chain.chainId} ainda está em execução (${chain.latestTaskId})`;
  } else if (options.resumeTaskId && (chain.status === "failed" || chain.status === "cancelled")) {
    resumeError = `só cadeias em blocked podem ser retomadas (cadeia ${chain.chainId}, estado atual: ${chain.status})`;
  }
  return {
    floor: chain.minTier,
    minimumEffort: chain.minEffort ?? undefined,
    origin: chain.origin,
    latestTaskId: chain.latestTaskId,
    attempts: chain.attempts.length,
    canRetry: chain.attempts.length < (options.maxAttempts ?? Infinity),
    succeeded: chain.status === "succeeded",
    running,
    resumeError,
    automatic: chain.origin.model === "auto" || chain.attempts.some((a) => a.reason === "quota" || a.reason === "capacity"),
    unavailable: chain.attempts.filter((a) => a.capacityUntil && Date.parse(a.capacityUntil) > (options.now ?? Date.now())),
  };
}
