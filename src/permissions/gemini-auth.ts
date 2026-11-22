// Login do executor Gemini (agy). Não há "status" oficial sem segredo: o sinal vem do log do próprio agy, gerado por
// um `agy models` (sem inferência) no HOME privado, com o log zerado antes para não ler linhas antigas. Prova o tipo
// de login (conta Google pelo keyring = assinatura pessoal); se a assinatura está paga, só o aceite do dono cobre.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateHome } from "../state/gemini-state.js";
import type { DuoConfig } from "../config.js";
import { runQuick } from "../adapters/process.js";
import type { Resolved } from "../adapters/resolve.js";
import { classifyErrorText } from "../adapters/types.js";
import { SANDBOX_EXEC } from "../adapters/sandbox-profile.js";
import type { AuthCheck, AuthMethod } from "./auth.js";
import { BILLING_ENV, childEnv } from "./auth.js";

const GOOGLE_ENV = BILLING_ENV.filter((k) => /^(GEMINI_|GOOGLE_|AGY_)/.test(k));

/** Credencial de API/nuvem do Google no ambiente do cérebro: recusa antes de limpar (o executor nunca a veria). */
export function geminiParentEnvProblem(parentEnv: NodeJS.ProcessEnv): string | null {
  const found = GOOGLE_ENV.filter((k) => parentEnv[k] !== undefined && parentEnv[k] !== "");
  return found.length ? `variáveis de cobrança do Google no ambiente (${found.join(", ")}); remova-as antes de delegar ao gemini` : null;
}

function classifyAgyLog(text: string): { method: AuthMethod; detail: string; conflict?: true } {
  const all = (re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => m[1] as string))];
  const effectives = all(/authenticated via [a-z_]+ \(effective: ([a-z_]+)\)/g);
  const methods = all(/\bauthMethod=([a-z_]+)/g);
  // Sinais diferentes no mesmo log: não dá para saber qual login a chamada usou.
  if (effectives.length > 1 || methods.length > 1) return { method: "unknown", conflict: true, detail: `sinais de login conflitantes (authMethod=${methods.join("|") || "?"} effective=${effectives.join("|") || "?"})` };
  const effective = effectives[0] ?? null;
  const authMethod = methods[0] ?? null;
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
  // Nunca repassa o stderr cru (pode conter conta ou URL com credencial): só a classe da falha.
  const text = existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("\n") : "";
  const c = classifyAgyLog(text);
  if (!r.ok) {
    const kind = classifyErrorText(`${r.stderr}\n${r.error ?? ""}`);
    const failed = `agy models falhou (${kind === "unknown" ? `código ${r.code ?? "?"}` : kind})`;
    // Evidência negativa do log (API, nuvem, sinais conflitantes) vale mesmo com a falha; o resto é "sem login legível".
    if (c.method === "api_key" || c.method === "cloud" || c.conflict) return { ...base, ...c, ok: false, detail: `${failed}; ${c.detail}` };
    return { ...base, ok: false, method: "none", detail: failed };
  }
  return { ...base, ...c, ok: c.method === "subscription" };
}

/** Login sem inferência (agy models) num HOME temporário só desta checagem (não disputa logs nem a limpeza das cadeias). */
/** conflict: o log trouxe sinais de login diferentes (evidência contra, não falta de evidência). */
export function geminiLoginProbe(resolved: Resolved, env: NodeJS.ProcessEnv, cfg: DuoConfig): { ok: boolean; method: string; detail: string; conflict: boolean } {
  let tmpHome: string | null = null;
  try {
    tmpHome = mkdtempSync(join(tmpdir(), "duo-agy-login-"));
    const { home } = createPrivateHome(tmpHome, env);
    const a = geminiAuthPreflight(resolved, { ...env, HOME: home }, cfg, null);
    return { ok: a.method === "subscription", method: a.method, detail: a.detail, conflict: (a as { conflict?: boolean }).conflict === true };
  } catch (e) {
    return { ok: false, method: "unknown", detail: `não foi possível verificar o login do agy (${(e as NodeJS.ErrnoException).code ?? "erro"})`, conflict: false };
  } finally { if (tmpHome) try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* limpeza best-effort */ } }
}
