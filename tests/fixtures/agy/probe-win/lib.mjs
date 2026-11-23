// Helpers puros do teste de fatos do Gemini no Windows (Fase 0). Só módulos nativos do Node; nada de dist/.
// Usam path.win32 para dar o resultado do Windows mesmo quando testados no Mac.
import { win32 } from "node:path";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tira e-mail, token longo e a pasta do perfil do dono antes de gravar evidência. */
export function redact(text, profileDir) {
  let out = String(text);
  if (profileDir) out = out.replace(new RegExp(escapeRe(profileDir), "gi"), "%USERPROFILE%");
  out = out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>");
  return out.replace(/[A-Za-z0-9_\-.]{32,}/g, "<token>");
}

const GOOGLE_BILLING = /^(GEMINI_|GOOGLE_|AGY_)/i;
const PROFILE_KEYS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"];

/** Ambiente do agy com perfil privado completo. Nomes de variável no Windows não diferenciam caixa.
 * pathApi: win32 por padrão (testes); a sonda passa o path nativo para o ensaio no Mac funcionar. */
export function privateEnv(base, root, pathApi = win32) {
  const env = {};
  const replaced = new Set(PROFILE_KEYS.map((k) => k.toUpperCase()));
  for (const [k, v] of Object.entries(base)) {
    if (GOOGLE_BILLING.test(k) || replaced.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  const home = pathApi.join(root, "home");
  const tmp = pathApi.join(root, "tmp");
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: pathApi.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: pathApi.join(home, "AppData", "Local"),
    TEMP: tmp,
    TMP: tmp,
  };
}

/** Decide se o login provado sem inferência permite gastar cota. Só "consumer" puro, sem sinal de API ou nuvem. */
export function authVerdict(logText) {
  const all = (re) => [...new Set([...String(logText).matchAll(re)].map((m) => m[1]))];
  const methods = all(/\bauthMethod=([a-z_]+)/g);
  const effectives = all(/\(effective: ([a-z_]+)\)/g);
  const lines = String(logText).split(/\r?\n/).filter((l) => /auth|keyring|credential|wincred|login/i.test(l));
  const cloud = effectives.some((e) => /api|adc|cloud|enterprise|gateway|business|vertex/.test(e));
  const proceed = methods.length === 1 && methods[0] === "consumer" && !cloud;
  return { verdict: proceed ? "proceed" : "stop", methods, effectives, lines };
}

/** Linha de comando do hook: cada parte entre aspas duplas. Caracteres que o cmd interpretaria são recusados. */
export function hookCommand(nodePath, script, args) {
  const parts = [nodePath, script, ...args];
  for (const p of parts) {
    const bad = /[%^&"!\x00-\x1f]/.exec(p);
    if (bad) throw new Error(`caractere não suportado no caminho do hook: ${JSON.stringify(bad[0])}`);
  }
  return parts.map((p) => `"${p}"`).join(" ");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** Linhas do rastreio do Process Monitor (CSV) cujo caminho cai num prefixo proibido. */
export function analyzeTrace(csv, forbidden) {
  const [header, ...rows] = parseCsv(String(csv).replace(/^﻿/, ""));
  const col = (name) => header.indexOf(name);
  const idx = { time: col("Time of Day"), process: col("Process Name"), pid: col("PID"), op: col("Operation"), path: col("Path") };
  if (Object.values(idx).some((i) => i < 0)) throw new Error("CSV sem as colunas esperadas do Process Monitor");
  const prefixes = forbidden.map((f) => f.toLowerCase());
  const hits = [];
  for (const r of rows) {
    const path = r[idx.path] ?? "";
    const low = path.toLowerCase();
    if (prefixes.some((p) => low === p || low.startsWith(p.endsWith("\\") ? p : `${p}\\`))) {
      hits.push({ time: r[idx.time], process: r[idx.process], pid: r[idx.pid], op: r[idx.op], path });
    }
  }
  return { hits };
}

/** Classifica o agy achado pelo `where agy`: executável, shim npm com script JS ou outro shim. */
export function resolveAgy(whereOutput, readFile) {
  const path = String(whereOutput).split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? null;
  if (!path) return { kind: "missing", path: null, script: null };
  const ext = win32.extname(path).toLowerCase();
  if (ext === ".exe") return { kind: "exe", path, script: null };
  if (ext === ".cmd") {
    const m = /%~?dp0%?\\([^"\r\n]+?\.[cm]?js)\b/i.exec(readFile(path));
    if (m) return { kind: "cmd-js", path, script: win32.join(win32.dirname(path), m[1]) };
    return { kind: "cmd-other", path, script: null };
  }
  return { kind: "cmd-other", path, script: null };
}
