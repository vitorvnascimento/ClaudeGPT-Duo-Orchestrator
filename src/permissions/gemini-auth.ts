// Login do executor Gemini (agy). Não há "status" oficial sem segredo: o sinal vem do log do próprio agy, gerado por
// um `agy models` (sem inferência) no HOME privado, com o log zerado antes para não ler linhas antigas. Prova o tipo
// de login (conta Google pelo keyring = assinatura pessoal); se a assinatura está paga, só o aceite do dono cobre.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DuoConfig } from "../config.js";
import { runQuick } from "../adapters/process.js";
import type { Resolved } from "../adapters/resolve.js";
import { SANDBOX_EXEC } from "../adapters/sandbox-profile.js";
import type { AuthCheck, AuthMethod } from "./auth.js";
import { BILLING_ENV, childEnv } from "./auth.js";

const GOOGLE_ENV = BILLING_ENV.filter((k) => /^(GEMINI_|GOOGLE_|AGY_)/.test(k));

/** Credencial de API/nuvem do Google no ambiente do cérebro: recusa antes de limpar (o executor nunca a veria). */
export function geminiParentEnvProblem(parentEnv: NodeJS.ProcessEnv): string | null {
  const found = GOOGLE_ENV.filter((k) => parentEnv[k] !== undefined && parentEnv[k] !== "");
  return found.length ? `variáveis de cobrança do Google no ambiente (${found.join(", ")}); remova-as antes de delegar ao gemini` : null;
}

function classifyAgyLog(text: string): { method: AuthMethod; detail: string } {
  const effective = /authenticated via [a-z_]+ \(effective: ([a-z_]+)\)/.exec(text)?.[1] ?? null;
  const authMethod = /\bauthMethod=([a-z_]+)/.exec(text)?.[1] ?? null;
  const detail = `authMethod=${authMethod ?? "?"} effective=${effective ?? "?"}`;
  if (authMethod === "consumer" && effective === "keyring") return { method: "subscription", detail };
  if (authMethod && /api/.test(authMethod)) return { method: "api_key", detail };
  if (authMethod && /adc|cloud|enterprise|gateway|business/.test(authMethod)) return { method: "cloud", detail };
  if (!authMethod && !effective) return { method: "none", detail: "sem sinal de login no log do agy" };
  return { method: "unknown", detail };
}

export function geminiAuthPreflight(resolved: Resolved, env: NodeJS.ProcessEnv, cfg: DuoConfig, profilePath: string | null): AuthCheck {
  const { env: clean, removed } = childEnv(env);
  const base = {
    provider: "gemini" as const,
    conflicts: [] as string[],
    warnings: [] as string[],
    removedEnv: removed.filter((k) => BILLING_ENV.includes(k)),
    extraUsage: cfg.billing.acknowledgeUnverifiableExtraUsage.gemini === true ? "unverifiable-acknowledged" as const : "unverifiable-not-acknowledged" as const,
  };
  if (!resolved.ok) return { ...base, ok: false, method: "unknown", detail: resolved.reason };
  const home = clean.HOME;
  if (!home) return { ...base, ok: false, method: "unknown", detail: "HOME privado ausente" };
  const logDir = join(home, ".gemini", "antigravity-cli", "log");
  rmSync(logDir, { recursive: true, force: true });
  const agy = [resolved.command, ...resolved.prefixArgs, "models"];
  const [cmd, ...args] = profilePath ? [SANDBOX_EXEC, "-f", profilePath, ...agy] : agy;
  const r = runQuick(cmd as string, args, { env: clean, timeoutMs: 30_000 });
  if (!r.ok) return { ...base, ok: false, method: "none", detail: `agy models falhou: ${(r.stderr || r.error || "").trim().slice(0, 200)}` };
  const text = existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("\n") : "";
  const c = classifyAgyLog(text);
  return { ...base, ...c, ok: c.method === "subscription" };
}
