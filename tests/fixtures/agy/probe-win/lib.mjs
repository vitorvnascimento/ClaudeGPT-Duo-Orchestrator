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

/** Analisa o rastreio do Process Monitor linha a linha. Só conta eventos dos processos lançados pela sonda e dos
 * descendentes deles, cada um da criação até a saída (um PID reaproveitado antes ou depois não entra). Um lançamento
 * só entra na árvore quando a própria sonda (probePid) o cria.
 * Cobertura: cada lançamento precisa ter criação, ao menos um evento de arquivo e saída; senão o rastreio está
 * incompleto. Acesso proibido comprovado vence a cobertura incompleta. */
/** Resultado do Process Monitor que diz que o caminho não existe: é só uma procura, não uma leitura. */
const NOT_FOUND = /NOT FOUND|NO SUCH|NAME INVALID|NOT A DIRECTORY|BAD NETWORK/i;
/** Resultados que provam que a operação aconteceu (listar até o fim ou ler até o fim também são sucesso). REPARSE fica
 * de fora: é um passo intermediário ao resolver junction/link, antes do resultado final da abertura. */
const SUCCESS = /^(SUCCESS|BUFFER OVERFLOW|NO MORE (FILES|ENTRIES)|END OF FILE)$/i;
/** Falhas conhecidas: a abertura não aconteceu. Qualquer outro resultado (vazio, REPARSE, desconhecido) é incerto. */
const KNOWN_FAILURE = /^(ACCESS DENIED|SHARING VIOLATION|PRIVILEGE NOT HELD|IS DIRECTORY|FILE LOCKED WITH (ONLY )?READERS|FILE LOCKED WITH WRITERS|INVALID PARAMETER|DELETE PENDING|CANNOT DELETE|NOT REPARSE POINT|OPLOCK NOT GRANTED|INVALID DEVICE REQUEST|FAST IO DISALLOWED)$/i;

const CONFIG_DIR = /antigravity|gemini|codeium|windsurf/i;
const HOME_CONFIG = /^\.(gemini|codeium|antigravity|windsurf)/i;
const CONFIG_FILE = /^(\.?codeium\.ya?ml|GEMINI\.md|AGENTS\.md)$/i;

/** Política do F5 (design, emenda B), decidida só pelo caminho registrado — nunca pelo disco de agora, para que o
 * mesmo CSV dê sempre o mesmo veredito. Ordem: raiz desta execução permitida; arquivo de config do agy proibido em
 * qualquer outro lugar; pastas de instalação do agy e do Node permitidas; config/estado do dono e pastas privadas de
 * outras execuções proibidos; o resto não importa. */
/** runRoots: as pastas deste lançamento (a bateria do duo passa várias; a sonda da Fase 0 passa só runRoot). foreignRoots:
 * pastas de outros lançamentos, proibidas. Pasta acima de uma raiz própria é só subida de pasta ("other"). */
export function tracePolicy({ home, appData, localAppData, runRoot, runRoots = runRoot ? [runRoot] : [], foreignRoots = [], agyPath, nodeDir, probeBase = localAppData && win32.join(localAppData, "duo-probe-win") }) {
  const low = (p) => String(p).toLowerCase().replace(/\\+$/, "");
  const inside = (path, base) => { if (!base) return false; const b = low(base); const q = low(path); return q === b || q.startsWith(`${b}\\`); };
  const partsUnder = (path, base) => (inside(path, base) && low(path) !== low(base) ? String(path).slice(String(base).replace(/\\+$/, "").length + 1).split("\\") : []);
  const firstUnder = (path, base) => (inside(path, base) && low(path) !== low(base) ? String(path).slice(String(base).replace(/\\+$/, "").length + 1).split("\\")[0] : null);
  const agyDir = agyPath ? win32.dirname(agyPath) : null;
  // Só o layout oficial (%LOCALAPPDATA%\agy\bin) libera a pasta acima de bin; outra pasta bin libera só ela mesma.
  const agyRoot = agyDir && localAppData && low(agyDir) === low(win32.join(localAppData, "agy", "bin")) ? win32.join(localAppData, "agy") : agyDir;
  return (path) => {
    if (!path) return "other";
    if (runRoots.some((r) => inside(path, r))) return "allowed";
    if (runRoots.some((r) => inside(r, path))) return "other";
    if (foreignRoots.some((r) => inside(path, r))) return "forbidden";
    if (CONFIG_FILE.test(win32.basename(path))) return "forbidden";
    if (inside(path, agyRoot) || inside(path, nodeDir)) return "allowed";
    // A pasta-mãe das execuções em si é só subida de pasta; o que há dentro dela (outras execuções) é proibido.
    if (inside(path, probeBase) && low(path) !== low(probeBase)) return "forbidden";
    const h = firstUnder(path, home);
    if (h && HOME_CONFIG.test(h)) return "forbidden";
    // Em AppData, qualquer nível conta: o estado do Codeium/Gemini pode morar dentro de outro app
    // (por exemplo Code\User\globalStorage\Codeium.codeium).
    for (const base of [appData, localAppData]) if (partsUnder(path, base).some((c) => CONFIG_DIR.test(c))) return "forbidden";
    return "other";
  };
}

/** policy(path) → "allowed" | "forbidden" | "other". Acesso proibido só com resultado de sucesso; caminho inexistente
 * vira "lookup" (o agy procurou e não achou); outra falha (acesso negado, compartilhamento) vira "failed". Sem a
 * coluna Result não há como saber se o acesso aconteceu: o rastreio fica incompleto. */
/** launchers: os processos que lançam o agy (o CLI do duo de cada comando), cada um { pid, image }; o formato antigo
 * (probePid, a sonda da Fase 0) vira um lançador só. Cada lançamento esperado se ancora no seu lançador (launch.launcher,
 * o PID; sem ele, o único lançador). policy(path, índice do lançamento) permite política por lançamento. */
export function createTraceAnalyzer({ launchers, probePid, launches, policy }) {
  const imageOf = (p) => win32.basename(String(p)).toLowerCase();
  const roots = (launchers ?? (probePid === undefined ? [] : [{ pid: probePid, image: null }])).map((l) => ({ pid: String(l.pid), image: l.image ? imageOf(l.image) : null }));
  if (!roots.length) throw new Error("rastreio sem lançador (launchers ou probePid)");
  const launcherOf = (l) => String(l.launcher ?? (roots.length === 1 ? roots[0].pid : ""));
  // Um registro por lançamento, na ordem: o Windows pode repetir o PID entre chamadas seguidas do spawnSync, e a sonda
  // também cria outros filhos (cmdkey, cmd, git). O lançamento só casa com o mesmo PID E o mesmo executável, criado pelo
  // seu lançador.
  const cover = launches.map((l) => ({ pid: String(l.pid), image: String(l.image).toLowerCase(), launcher: launcherOf(l), created: false, fs: 0, exited: false }));
  const isLauncher = (pid, image) => roots.some((r) => r.pid === pid && (!r.image || !image || r.image === imageOf(image)));
  const live = new Map(); // pid vivo → índice do lançamento de origem
  const hits = [];
  const lookups = [];
  const failed = [];
  const unknown = [];
  let idx = null;
  let rows = 0;
  let resultCol = -1;
  const startRoot = (launcher, pid, image) => {
    const i = cover.findIndex((c) => c.launcher === launcher && c.pid === pid && c.image === imageOf(image) && !c.created);
    if (i >= 0) { cover[i].created = true; live.set(pid, i); }
  };
  return {
    line(text) {
      const raw = text.replace(/^\uFEFF/, "");
      if (!raw.trim()) return;
      const cells = parseCsvLine(raw);
      if (!idx) {
        const col = (n) => cells.indexOf(n);
        idx = { time: col("Time of Day"), process: col("Process Name"), pid: col("PID"), op: col("Operation"), path: col("Path"), detail: col("Detail") };
        if (Object.values(idx).some((i) => i < 0)) throw new Error("CSV sem as colunas esperadas do Process Monitor (Time of Day, Process Name, PID, Operation, Path, Detail)");
        resultCol = col("Result");
        return;
      }
      rows++;
      const pid = cells[idx.pid];
      const op = cells[idx.op];
      const detail = cells[idx.detail] ?? "";
      const path = cells[idx.path] ?? "";
      const forbiddenHit = (origin) => {
        if (policy(path, origin) !== "forbidden") return;
        const result = resultCol >= 0 ? cells[resultCol] ?? "" : "";
        const ev = { time: cells[idx.time], process: cells[idx.process], pid, op, path, result };
        (SUCCESS.test(result) ? hits : NOT_FOUND.test(result) ? lookups : KNOWN_FAILURE.test(result) ? failed : unknown).push(ev);
      };
      if (op === "Process Create") {
        const child = /\bPID: (\d+)/.exec(detail)?.[1];
        if (child && isLauncher(pid, cells[idx.process]) && !live.has(pid)) startRoot(pid, child, path);
        else if (child && live.has(pid)) { forbiddenHit(live.get(pid)); live.set(child, live.get(pid)); }
        return;
      }
      if (op === "Process Start") {
        const parent = /Parent PID: (\d+)/.exec(detail)?.[1];
        if (parent && isLauncher(parent, null) && !live.has(pid) && !live.has(parent)) startRoot(parent, pid, cells[idx.process]);
        else if (parent && live.has(parent) && !live.has(pid)) live.set(pid, live.get(parent));
        return;
      }
      if (!live.has(pid)) return;
      const origin = live.get(pid);
      if (op === "Process Exit") {
        if (cover[origin].pid === pid && !cover[origin].exited) cover[origin].exited = true;
        live.delete(pid);
        return;
      }
      if (!path) return;
      // Qualquer operação com caminho proibido é evidência (inclusive Load Image e o executável de um filho); só
      // operações de arquivo contam como cobertura de acesso a arquivos.
      forbiddenHit(origin);
      if (!/^(Thread |Load Image|Reg|TCP|UDP|Profiling)/.test(op)) cover[origin].fs++;
    },
    result() {
      // Ajudante ainda vivo no fim da captura: o que ele fez depois ficou de fora.
      const pendingCount = (i) => [...live.values()].filter((v) => v === i).length;
      const missing = cover.map((c, i) => ({ pid: c.pid, image: c.image, ...(launchers ? { launcher: c.launcher } : {}), created: c.created, fs: c.fs, exited: c.exited, liveDescendants: pendingCount(i) - (c.created && !c.exited ? 1 : 0) }))
        .filter((m, i) => !(m.created && m.fs > 0 && m.exited && pendingCount(i) === 0));
      const verdict = hits.length ? "forbidden" : !idx || resultCol < 0 || unknown.length || missing.length ? "incomplete" : "ok";
      return { rows, hits, lookups, failed, unknown, missing, missingPids: missing.map((m) => m.pid), noResultColumn: !!idx && resultCol < 0, verdict };
    },
  };
}

/** Política de cada lançamento da bateria do duo: as próprias pastas permitidas, as dos outros lançamentos proibidas
 * (menos as que também são próprias). base: as opções comuns de tracePolicy. */
export function launchPolicies(base, launches) {
  const own = launches.map((l) => l.allowedRoots ?? []);
  const per = own.map((mine, i) => tracePolicy({ ...base, runRoots: mine, foreignRoots: own.flatMap((r, j) => (j === i ? [] : r)).filter((r) => !mine.some((m) => m.toLowerCase() === r.toLowerCase())) }));
  return (path, i) => per[i](path);
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
 * precisa de motivo de tempo: uma falha comum do comando (exit status) não distingue estouro de travamento. No Windows
 * esse motivo não vem na mensagem; classifyRun aceita no lugar o registro de vida do próprio hook (summarizeAlive). */
/** Os mesmos motivos para outro nome de hook no hooks.json (a bateria do duo troca o script do gate, chave "duo-gate"). */
export function hookReasons(name) {
  const n = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    deny: /denied by pre-tool hook: probe-deny/i,
    crash: new RegExp(`hook\\W+jsonhook__${n}_\\S*\\W+failed: command failed: exit status \\d+$`, "i"),
    garbage: new RegExp(`unmarshal result from hook jsonhook__${n}_`, "i"),
    timeout: new RegExp(`hook\\W+jsonhook__${n}_\\S*\\W+failed\\b.*(signal: killed|timed? ?out|deadline exceeded|context canceled)$`, "i"),
    any: new RegExp(`jsonhook__${n}_`, "i"),
    failed: new RegExp(`hook\\W+jsonhook__${n}_\\S*\\W+failed\\b`, "i"),
  };
}
const { any: ANY_HOOK_FAILURE, failed: HOOK_FAILED, ...PROBE_REASONS } = hookReasons("probe");
export const HOOK_REASON = PROBE_REASONS;
/** Folga da medição do corte: o relógio do agy começa antes do Node do hook subir, e o hook anota a cada 250 ms. */
const CUT_EARLY_MS = 1000;
const CUT_LATE_MS = 1000;
/** O hook confere o pai a cada 250 ms: o último instante com o pai vivo pode passar do limite por no máximo isso, com folga. */
const PARENT_ALIVE_SLACK_MS = 500;

/** Resume o <log>.alive do hook de tempo esgotado, por PID: último instante vivo, quando o pai sumiu e se respondeu. */
export function summarizeAlive(text) {
  const by = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    let t; try { t = JSON.parse(line); } catch { continue; }
    if (!Number.isInteger(t?.pid) || typeof t.aliveMs !== "number") continue;
    const s = by.get(t.pid) ?? { pid: t.pid, aliveMs: 0, parentGoneAtMs: null, lastParentAliveMs: 0, answered: false };
    s.aliveMs = Math.max(s.aliveMs, t.aliveMs);
    if (!t.parentGone) s.lastParentAliveMs = Math.max(s.lastParentAliveMs, t.aliveMs);
    if (t.parentGone) s.parentGoneAtMs ??= t.aliveMs;
    if (t.answered) s.answered = true;
    by.set(t.pid, s);
  }
  return [...by.values()];
}
const PATH_ARG = /path|file/i;

/** Resultado de uma execução de sonda. Arquivo ausente só prova a trava quando a escrita do caminho exato do alvo
 * (argumento de caminho resolvido contra a pasta de trabalho) chegou ao hook e o stream mostra a mesma escrita
 * terminando no erro típico daquele hook. */
/** Ferramentas que não gravam e que o hook pode registrar legitimamente (mesma lista de leitura do gate do duo). */
const KNOWN_NON_WRITE = new Set(["read_file", "view_file", "view_file_outline", "list_dir", "grep_search", "find_by_name", "finish"]);

export function classifyRun(hook, { target, workspace, fileExists, hookLines, steps, alive = [], hookTimeoutMs = 0, hookName = "probe" }, pathApi = win32) {
  const R = hookName === "probe" ? { ...HOOK_REASON, any: ANY_HOOK_FAILURE, failed: HOOK_FAILED } : hookReasons(hookName);
  const want = pathApi.resolve(workspace, target).toLowerCase();
  const isTarget = (args) => Object.entries(args ?? {}).some(([k, v]) => PATH_ARG.test(k) && typeof v === "string" && pathApi.resolve(workspace, v).toLowerCase() === want);
  const hookSaw = hookLines.some((l) => WRITE_TOOLS.has(l.toolName) && isTarget(l.args));
  const writes = steps.filter((s) => WRITE_TOOLS.has(s.tool) && isTarget(s.params));
  if (hook === "allow-log") {
    if (fileExists && hookSaw) return "pass";
    if (!hookLines.length && steps.some((s) => R.any.test(s.message))) return "hook-cmd-failed";
    // "Hook não rodou" quando a escrita do alvo aconteceu e o hook ou não registrou nada, ou só registrou chamadas
    // legíveis de ferramentas conhecidas que não gravam. Registro ilegível ou ferramenta desconhecida fica inconclusivo.
    const otherFile = (l) => WRITE_TOOLS.has(l.toolName) && Object.entries(l.args ?? {}).some(([k, v]) => PATH_ARG.test(k) && typeof v === "string") && !isTarget(l.args);
    const onlyUnrelated = hookLines.every((l) => !l.stdinError && (KNOWN_NON_WRITE.has(l.toolName) || otherFile(l)));
    if (onlyUnrelated && (fileExists || writes.some((s) => s.state === "DONE"))) return "hook-not-run";
    return "inconclusive";
  }
  if (fileExists || writes.some((s) => s.state === "DONE")) return "fail";
  const reason = R[hook];
  // O motivo vem antes do stderr do hook: texto que o próprio script imprimiu não conta como causa.
  const cause = (m) => m.split(/,?\s*stderr:/i)[0];
  if (hookSaw && writes.some((s) => s.state === "ERROR" && reason.test(cause(s.message)))) return "pass";
  // Windows: o agy corta o hook com "exit status 1", sem motivo de tempo. Vale como prova quando o próprio hook que viu
  // a escrita do alvo anotou que ficou vivo e sem responder até o limite configurado e foi cortado perto dele.
  if (hook === "timeout" && hookTimeoutMs > 0) {
    const cutNearLimit = (l) => alive.some((a) => {
      // Só o marcador de pai sumido prova o corte; o último batimento sozinho só prova que o hook estava vivo.
      const cutAt = a.parentGoneAtMs;
      return a.pid === l.pid && !a.answered && cutAt !== null && cutAt >= hookTimeoutMs - CUT_EARLY_MS && cutAt <= hookTimeoutMs + CUT_LATE_MS
        && (a.lastParentAliveMs ?? Infinity) <= hookTimeoutMs + PARENT_ALIVE_SLACK_MS;
    });
    const sawCut = hookLines.some((l) => WRITE_TOOLS.has(l.toolName) && isTarget(l.args) && cutNearLimit(l));
    if (sawCut && writes.some((s) => s.state === "ERROR" && R.failed.test(cause(s.message)))) return "pass";
  }
  return "inconclusive";
}
