// Helpers puros do teste de fatos do Gemini no Windows (Fase 0). Só módulos nativos do Node; nada de dist/.
// Usam path.win32 para dar o resultado do Windows mesmo quando testados no Mac.
import { win32 } from "node:path";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tira e-mail, token longo e a pasta do perfil do dono (com \, /, \\ escapado e %-codificado) antes de gravar evidência. */
export function redact(text, profileDir) {
  let out = String(text);
  if (profileDir) {
    const forms = new Set([profileDir, profileDir.replace(/\\/g, "/"), profileDir.replace(/\\/g, "\\\\"), encodeURI(profileDir.replace(/\\/g, "/"))]);
    for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRe(f), "gi"), "%USERPROFILE%");
  }
  out = out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>");
  return out.replace(/[A-Za-z0-9_\-.]{32,}/g, "<token>");
}

const GOOGLE_BILLING = /^(GEMINI_|GOOGLE_|AGY_)/i;
const PROFILE_KEYS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH"];

/** Ambiente do agy com perfil privado completo. Nomes de variável no Windows não diferenciam caixa.
 * pathApi: win32 por padrão (testes); a sonda passa o path nativo para o ensaio no Mac funcionar. */
export function privateEnv(base, root, pathApi = win32) {
  const env = {};
  const replaced = new Set(PROFILE_KEYS);
  for (const [k, v] of Object.entries(base)) {
    if (GOOGLE_BILLING.test(k) || replaced.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  const home = pathApi.join(root, "home");
  const tmp = pathApi.join(root, "tmp");
  const out = {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: pathApi.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: pathApi.join(home, "AppData", "Local"),
    TEMP: tmp,
    TMP: tmp,
  };
  if (pathApi.sep === "\\") {
    const drive = pathApi.parse(home).root.replace(/\\$/, "");
    out.HOMEDRIVE = drive;
    out.HOMEPATH = home.slice(drive.length);
  }
  return out;
}

/** Fontes de credencial já vistas com login de assinatura. Outra fonte no Windows vai para revisão, sem gastar cota. */
export const RECOGNIZED_EFFECTIVE = new Set(["keyring"]);

/** Decide se o login provado sem inferência permite gastar cota: "consumer" puro com fonte reconhecida. */
export function authVerdict(logText) {
  const all = (re) => [...new Set([...String(logText).matchAll(re)].map((m) => m[1].trim().toLowerCase()))];
  const methods = all(/\bauthMethod=([\w-]+)/gi);
  const effectives = all(/\(effective: ([^)]+)\)/gi);
  const lines = String(logText).split(/\r?\n/).filter((l) => /auth|keyring|credential|wincred|login/i.test(l));
  const cloud = [...methods, ...effectives].some((s) => /api|adc|cloud|enterprise|gateway|business|vertex/.test(s));
  let verdict = "stop";
  if (!cloud && methods.length === 1 && methods[0] === "consumer" && effectives.length === 1) {
    verdict = RECOGNIZED_EFFECTIVE.has(effectives[0]) ? "proceed" : "review";
  }
  return { verdict, methods, effectives, lines };
}

/** Linha de comando do hook: o executável vai sem aspas (no PowerShell, aspas no início viram texto, não comando) e
 * cada argumento vai entre aspas (protege espaço e `;`). Caracteres que cmd ou PowerShell interpretariam são recusados. */
export function hookCommand([exe, ...args]) {
  if (!/^[\w.\-]+$/.test(exe)) throw new Error(`executável do hook precisa ser um nome simples sem espaço: ${JSON.stringify(exe)}`);
  for (const p of args) {
    const bad = /[%^&"!$`'\x00-\x1f]/.exec(p);
    if (bad) throw new Error(`caractere não suportado no caminho do hook: ${JSON.stringify(bad[0])}`);
  }
  return [exe, ...args.map((p) => `"${p}"`)].join(" ");
}

/** Uma linha de CSV (RFC 4180, sem quebra de linha dentro de campo, como o Process Monitor exporta). */
export function parseCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

const under = (path, prefixes) => {
  const low = path.toLowerCase();
  return prefixes.some((p) => { const q = p.toLowerCase().replace(/\\+$/, ""); return low === q || low.startsWith(`${q}\\`); });
};

/** Analisa o rastreio do Process Monitor linha a linha. Só conta eventos dos processos lançados pela sonda e dos
 * descendentes deles, cada um da criação até a saída (um PID reaproveitado antes ou depois não entra). Um lançamento
 * só entra na árvore quando a própria sonda (probePid) o cria.
 * Cobertura: cada lançamento precisa ter criação, ao menos um evento de arquivo e saída; senão o rastreio está
 * incompleto. Acesso proibido comprovado vence a cobertura incompleta. */
export function createTraceAnalyzer({ probePid, launchPids, forbidden, allowed }) {
  const roots = new Set(launchPids.map(String));
  const probe = String(probePid);
  const live = new Map(); // pid vivo → lançamento de origem
  const cover = new Map(launchPids.map((p) => [String(p), { created: false, fs: 0, exited: false }]));
  const hits = [];
  let idx = null;
  let rows = 0;
  const join = (pid, origin) => { live.set(pid, origin); if (pid === origin) cover.get(origin).created = true; };
  return {
    line(text) {
      const raw = text.replace(/^\uFEFF/, "");
      if (!raw.trim()) return;
      const cells = parseCsvLine(raw);
      if (!idx) {
        const col = (n) => cells.indexOf(n);
        idx = { time: col("Time of Day"), process: col("Process Name"), pid: col("PID"), op: col("Operation"), path: col("Path"), detail: col("Detail") };
        if (Object.values(idx).some((i) => i < 0)) throw new Error("CSV sem as colunas esperadas do Process Monitor (Time of Day, Process Name, PID, Operation, Path, Detail)");
        return;
      }
      rows++;
      const pid = cells[idx.pid];
      const op = cells[idx.op];
      const detail = cells[idx.detail] ?? "";
      if (op === "Process Create") {
        const child = /\bPID: (\d+)/.exec(detail)?.[1];
        if (child && pid === probe && roots.has(child)) join(child, child);
        else if (child && live.has(pid)) join(child, live.get(pid));
        return;
      }
      if (op === "Process Start") {
        const parent = /Parent PID: (\d+)/.exec(detail)?.[1];
        if (parent === probe && roots.has(pid)) join(pid, pid);
        else if (parent && live.has(parent)) join(pid, live.get(parent));
        return;
      }
      if (!live.has(pid)) return;
      const origin = live.get(pid);
      if (op === "Process Exit") { if (pid === origin) cover.get(origin).exited = true; live.delete(pid); return; }
      const path = cells[idx.path] ?? "";
      if (!path || /^(Thread |Load Image|Reg|TCP|UDP|Profiling)/.test(op)) return;
      cover.get(origin).fs++;
      if (under(path, forbidden) && !under(path, allowed)) hits.push({ time: cells[idx.time], process: cells[idx.process], pid, op, path });
    },
    result() {
      const missing = [...cover].filter(([, c]) => !(c.created && c.fs > 0 && c.exited)).map(([p]) => p);
      const verdict = hits.length ? "forbidden" : !idx || missing.length ? "incomplete" : "ok";
      return { rows, hits, missingPids: missing, verdict };
    },
  };
}

/** Classifica o agy achado pelo `where agy`: executável, shim npm com script JS ou outro. Prefere .exe/.cmd/.bat. */
export function resolveAgy(whereOutput, readFile) {
  const lines = String(whereOutput).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { kind: "missing", path: null, script: null };
  const path = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0];
  const ext = win32.extname(path).toLowerCase();
  if (ext === ".exe") return { kind: "exe", path, script: null };
  if (ext === ".cmd" || ext === ".bat") {
    const m = /%~?dp0%?\\([^"\r\n]+?\.[cm]?js)\b/i.exec(readFile(path));
    if (m) return { kind: "cmd-js", path, script: win32.join(win32.dirname(path), m[1]) };
  }
  return { kind: "cmd-other", path, script: null };
}

export const WRITE_TOOLS = new Set(["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]);

/** Passos de ferramenta do stream-json do agy: ferramenta, estado, parâmetros de texto (com o nome) e mensagem de erro. */
export function parseStream(stdout) {
  const events = new Set();
  const steps = [];
  let status = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (typeof ev.event === "string") events.add(ev.event);
    if (ev.event === "result") status = ev.result?.status ?? null;
    const u = ev.step_update;
    if (u && typeof u.tool_name === "string") {
      const params = Object.fromEntries(Object.entries(u.tool_info?.parameters ?? {}).filter(([, v]) => typeof v === "string"));
      steps.push({ tool: u.tool_name, state: u.state ?? null, params, message: String(u.tool_info?.error?.message ?? "") });
    }
  }
  return { events: [...events], status, steps };
}

/** Mensagem do agy que prova a falha/negação vinda do hook "probe" (formatos vistos no macOS 1.5.x). O tempo esgotado
 * precisa de motivo de tempo: uma falha comum do comando (exit status) não distingue estouro de travamento. */
export const HOOK_REASON = {
  deny: /denied by pre-tool hook: probe-deny/i,
  crash: /hook\W+jsonhook__probe_\S*\W+failed: command failed: exit status/i,
  garbage: /unmarshal result from hook jsonhook__probe_/i,
  timeout: /hook\W+jsonhook__probe_\S*\W+failed\b.*(signal: killed|timed? ?out|deadline exceeded|context canceled)/i,
};
const ANY_HOOK_FAILURE = /jsonhook__probe_/i;
const PATH_ARG = /path|file/i;

/** Resultado de uma execução de sonda. Arquivo ausente só prova a trava quando a escrita do caminho exato do alvo
 * (argumento de caminho resolvido contra a pasta de trabalho) chegou ao hook e o stream mostra a mesma escrita
 * terminando no erro típico daquele hook. */
export function classifyRun(hook, { target, workspace, fileExists, hookLines, steps }, pathApi = win32) {
  const want = pathApi.resolve(workspace, target).toLowerCase();
  const isTarget = (args) => Object.entries(args ?? {}).some(([k, v]) => PATH_ARG.test(k) && typeof v === "string" && pathApi.resolve(workspace, v).toLowerCase() === want);
  const hookSaw = hookLines.some((l) => WRITE_TOOLS.has(l.toolName) && isTarget(l.args));
  const writes = steps.filter((s) => WRITE_TOOLS.has(s.tool) && isTarget(s.params));
  if (hook === "allow-log") {
    if (fileExists && hookSaw) return "pass";
    if (!hookLines.length && steps.some((s) => ANY_HOOK_FAILURE.test(s.message))) return "hook-cmd-failed";
    // Só "hook não rodou" quando o hook não registrou nada e a escrita do alvo aconteceu. Hook que registrou algo que a
    // sonda não reconhece (stdin ilegível, ferramenta nova) fica inconclusivo.
    if (!hookLines.length && (fileExists || writes.some((s) => s.state === "DONE"))) return "hook-not-run";
    return "inconclusive";
  }
  if (fileExists || writes.some((s) => s.state === "DONE")) return "fail";
  const reason = HOOK_REASON[hook];
  if (hookSaw && writes.some((s) => s.state === "ERROR" && reason.test(s.message))) return "pass";
  return "inconclusive";
}
