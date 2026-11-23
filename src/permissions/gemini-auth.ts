// Login do executor Gemini (agy). Não há "status" oficial sem segredo: o sinal vem do log do próprio agy, gerado por
// um `agy models` (sem inferência) no HOME privado, com o log zerado antes para não ler linhas antigas. Prova o tipo
// de login (conta Google pelo keyring = assinatura pessoal); se a assinatura está paga, só o aceite do dono cobre.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { agyConfigAbove, createPrivateHome, launcherFor, newProbeDir, privateProfileEnv } from "../state/gemini-state.js";
import type { DuoConfig } from "../config.js";
import { runQuick } from "../adapters/process.js";
import type { Resolved } from "../adapters/resolve.js";
import { classifyErrorText } from "../adapters/types.js";
import { SANDBOX_EXEC } from "../adapters/sandbox-profile.js";
import type { AuthCheck, AuthMethod } from "./auth.js";
import { BILLING_ENV, childEnv, isBillingEnvName } from "./auth.js";

const GOOGLE_ENV = BILLING_ENV.filter((k) => /^(GEMINI_|GOOGLE_|AGY_)/.test(k));

/** Credencial de API/nuvem do Google no ambiente do cérebro: recusa antes de limpar (o executor nunca a veria). */
export function geminiParentEnvProblem(parentEnv: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  // No Windows o nome não diferencia caixa: `gemini_api_key` também seleciona a API.
  const found = platform === "win32"
    ? Object.keys(parentEnv).filter((k) => GOOGLE_ENV.includes(k.toUpperCase()) && parentEnv[k] !== undefined && parentEnv[k] !== "")
    : GOOGLE_ENV.filter((k) => parentEnv[k] !== undefined && parentEnv[k] !== "");
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
  // Cada sinal decide sozinho quando aponta para login não aceito (log parcial: um deles pode faltar).
  if ((authMethod && /api/.test(authMethod)) || (effective && /api/.test(effective))) return { method: "api_key", detail };
  if ((authMethod && /adc|cloud|enterprise|gateway|business/.test(authMethod)) || (effective && /adc|cloud|enterprise|gateway|business|vertex/.test(effective))) return { method: "cloud", detail };
  if (!authMethod && !effective) return { method: "none", detail: "sem sinal de login no log do agy" };
  return { method: "unknown", detail };
}

/** opts.cwd: pasta privada onde o `agy models` roda (nunca a pasta do projeto: o agy procura config nas pastas acima). */
export function geminiAuthPreflight(resolved: Resolved, env: NodeJS.ProcessEnv, cfg: DuoConfig, profilePath: string | null, opts: { cwd?: string; platform?: NodeJS.Platform } = {}): AuthCheck {
  const { env: clean, removed } = childEnv(env);
  const base = {
    provider: "gemini" as const,
    conflicts: [] as string[],
    warnings: [] as string[],
    removedEnv: removed.filter((k) => isBillingEnvName(k)),
    extraUsage: cfg.billing.acknowledgeUnverifiableExtraUsage.gemini === true ? "unverifiable-acknowledged" as const : "unverifiable-not-acknowledged" as const,
  };
  if (!resolved.ok) return { ...base, ok: false, method: "unknown", detail: resolved.reason };
  const home = clean.HOME;
  if (!home) return { ...base, ok: false, method: "unknown", detail: "HOME privado ausente" };
  if ((opts.platform ?? process.platform) === "win32") {
    // No Windows a checagem só roda numa pasta privada conferida: sem ela o agy herdaria a pasta do chamador.
    if (!opts.cwd) return { ...base, ok: false, method: "unknown", detail: "checagem de login sem pasta de trabalho privada" };
    const found = agyConfigAbove(opts.cwd);
    if (found) return { ...base, ok: false, method: "unknown", detail: `config do agy acima da pasta da checagem de login (${basename(found)})` };
  }
  const logDir = join(home, ".gemini", "antigravity-cli", "log");
  rmSync(logDir, { recursive: true, force: true });
  // Fora da pasta do projeto, um script relativo do lançador configurado vira absoluto antes de trocar de pasta.
  const launch = opts.cwd ? launcherFor(resolved) : resolved;
  const agy = [launch.command, ...launch.prefixArgs, "models"];
  const [cmd, ...args] = profilePath ? [SANDBOX_EXEC, "-f", profilePath, ...agy] : agy;
  const r = runQuick(cmd as string, args, { env: clean, cwd: opts.cwd, timeoutMs: 30_000 });
  // Nunca repassa o stderr cru (pode conter conta ou URL com credencial): só a classe da falha.
  // Arquivos regulares são lidos; pasta vazia é ignorada (o agy grava o log em arquivos soltos). Qualquer outra entrada
  // (pasta com conteúdo, link, arquivo ou pasta ilegível) pode esconder o sinal conflitante: sem evidência negativa
  // nos logs lidos, o resultado vira inconclusivo e bloqueia.
  let text = "";
  let unaccounted = false;
  const why = new Set<string>();
  try {
    if (existsSync(logDir)) {
      text = readdirSync(logDir).flatMap((f) => {
        const p = join(logDir, f);
        try {
          const st = lstatSync(p);
          if (st.isDirectory()) { if (readdirSync(p).length > 0) { unaccounted = true; why.add("pasta com conteúdo"); } return []; }
          if (!st.isFile()) { unaccounted = true; why.add(st.isSymbolicLink() ? "link" : "entrada não regular"); return []; }
          return [readFileSync(p, "utf8")];
        } catch { unaccounted = true; why.add("ilegível"); return []; }
      }).join("\n");
    }
  } catch { unaccounted = true; why.add("ilegível"); }
  const c = classifyAgyLog(text);
  const negative = c.method === "api_key" || c.method === "cloud" || c.conflict === true;
  if (unaccounted && !negative) return { ...base, ok: false, method: "unknown", detail: `log do agy com entrada não lida (${[...why].sort().join(", ")}): login não verificável` };
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
export function geminiLoginProbe(resolved: Resolved, env: NodeJS.ProcessEnv, cfg: DuoConfig, platform: NodeJS.Platform = process.platform): { ok: boolean; method: string; detail: string; conflict: boolean } {
  let tmpHome: string | null = null;
  try {
    tmpHome = newProbeDir(env, "duo-agy-login-", platform);
    const { home } = createPrivateHome(tmpHome, env, platform);
    let a: AuthCheck;
    if (platform === "win32") {
      // Windows: perfil inteiro privado e pasta de trabalho privada (fatos da Fase 0).
      const work = join(tmpHome, "work");
      const tmp = join(tmpHome, "tmp");
      mkdirSync(work, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      a = geminiAuthPreflight(resolved, privateProfileEnv(env, { home, tmpDir: tmp }, platform).env, cfg, null, { cwd: work, platform });
    } else a = geminiAuthPreflight(resolved, { ...env, HOME: home }, cfg, null);
    return { ok: a.method === "subscription", method: a.method, detail: a.detail, conflict: (a as { conflict?: boolean }).conflict === true };
  } catch (e) {
    return { ok: false, method: "unknown", detail: `não foi possível verificar o login do agy (${(e as NodeJS.ErrnoException).code ?? "erro"})`, conflict: false };
  } finally { if (tmpHome) try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* limpeza best-effort */ } }
}
