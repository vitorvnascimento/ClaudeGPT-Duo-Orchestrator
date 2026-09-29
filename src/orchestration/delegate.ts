// Fluxo determinístico de uma delegação: valida, aplica restrições, aciona a CLI do executor,
// verifica o resultado de forma independente e registra estado e métricas. Não é um segundo cérebro.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { CODEX_EXEC_FLAGS, CLAUDE_FLAGS, probe, type Capabilities } from "../adapters/capabilities.js";
import { findModel, loadCatalog, type Catalog } from "../adapters/catalog.js";
import { collectCodexEvidence, sha256File } from "../adapters/codex-rollout.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
import { isPidAlive, runProcess } from "../adapters/process.js";
import { resolveExecutable } from "../adapters/resolve.js";
import { sanitizeEventLine } from "../adapters/sanitize.js";
import type { ExecutorAdapter, ParsedOutcome } from "../adapters/types.js";
import { ConfigError, loadConfig, type DuoConfig, type Provider } from "../config.js";
import { captureState, diffAgainstSnapshot, diffStates, dirtyPaths, headCommit, repoRoot, snapshotFiles, worktreeAdd, worktreePatch, type TreeState } from "../git.js";
import { authBlockReason, checkAuth, childEnv, defaultAuthPaths, type AuthPaths } from "../permissions/auth.js";
import { inScope, isDenied, validateScope, type ScopeEntry } from "../permissions/scope.js";
import { redact, redactDeep } from "../redact.js";
import { loadSchema, validate } from "../schema.js";
import { transition } from "../state/machine.js";
import { ExecutorLock, newId, readJson, Store, writeJsonAtomic } from "../state/store.js";
import { isWriteKind, type AcceptanceResult, type DelegationRequest, type Run, type Task, type TaskState, type Verification } from "../state/types.js";
import { isAllowlisted, runAcceptance } from "./acceptance.js";
import { policyBlockReason } from "./policy.js";
import { buildExecutorPrompt } from "./prompt.js";
import { deriveTags } from "./router.js";

export const EXIT = { ok: 0, failed: 1, invalid: 2, blocked: 3, cancelled: 4 } as const;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_EVENT_LOG_BYTES = 2 * 1024 * 1024;

export const ADAPTERS: Record<Provider, ExecutorAdapter> = { claude: new ClaudeAdapter(), codex: new CodexAdapter() };

export type DelegateOptions = {
  cwd: string;
  requestPath?: string;
  resumeTaskId?: string;
  /** Sobrescreve o timeout desta invocação (útil ao retomar após timeout). Limitado a 10–3600 s. */
  timeoutSecOverride?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  authPaths?: AuthPaths;
};

export type DelegateOutcome = { exitCode: number; summary: Record<string, unknown> };

function invalid(message: string, details: string[] = [], exitCode: number = EXIT.invalid): DelegateOutcome {
  return { exitCode, summary: { state: "rejected", error: message, ...(details.length ? { details } : {}) } };
}

function stableHash(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex").slice(0, 16);
}

function exitFor(state: TaskState): number {
  return state === "succeeded" ? EXIT.ok : state === "blocked" ? EXIT.blocked : state === "cancelled" ? EXIT.cancelled : EXIT.failed;
}

function newTask(req: DelegationRequest, run: Run, store: Store, cfg: DuoConfig): Task {
  const taskId = newId("task");
  const now = new Date().toISOString();
  const { runId: _r, taskKey: _k, ...hashable } = req;
  return {
    taskId,
    runId: run.runId,
    ...(req.taskKey ? { taskKey: req.taskKey } : {}),
    state: "planned",
    history: [{ at: now, from: null, to: "planned", reason: "pedido recebido do cérebro" }],
    createdAt: now,
    updatedAt: now,
    brain: req.brain,
    executor: req.executor,
    kind: req.kind,
    objective: req.objective,
    reason: req.reason,
    rationale: req.rationale,
    risk: req.risk ?? "medium",
    brainModel: req.brainModel ?? null,
    tags: [],
    needs: req.needs ?? [],
    isolation: req.isolation ?? "in-place",
    scope: req.scope.allowedPaths,
    constraints: req.constraints ?? [],
    acceptanceCriteria: req.acceptance.criteria,
    acceptanceCommands: req.acceptance.commands ?? [],
    requestHash: stableHash(hashable),
    base: null,
    model: { requested: req.model ?? cfg.executors[req.executor].model ?? null, reported: null, reportedSource: "unavailable" },
    native: { sessionId: null },
    pids: { bridge: null, child: null },
    invocations: 0,
    artifactsDir: store.taskDir(run.runId, taskId),
    worktree: null,
    applied: false,
    executorReport: null,
    verification: null,
    metrics: null,
    outcome: null,
    limitations: [],
  };
}

function newRun(req: DelegationRequest, cfg: DuoConfig): Run {
  const now = new Date().toISOString();
  return { runId: newId("run"), brain: req.brain, policy: cfg.policy, createdAt: now, updatedAt: now, cancelled: false, invocations: 0, taskIds: [], decisions: [], nextStep: null };
}

function readRequest(cwd: string, requestPath: string): { ok: true; req: DelegationRequest } | { ok: false; out: DelegateOutcome } {
  const p = resolve(cwd, requestPath);
  let raw: string;
  try {
    if (statSync(p).size > MAX_REQUEST_BYTES) return { ok: false, out: invalid(`pedido maior que ${MAX_REQUEST_BYTES} bytes`) };
    raw = readFileSync(p, "utf8");
  } catch (e) {
    return { ok: false, out: invalid(`não foi possível ler o pedido: ${(e as Error).message}`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, out: invalid(`pedido não é JSON válido: ${(e as Error).message}`) };
  }
  const errors = validate(loadSchema("delegation-request"), parsed);
  if (errors.length) return { ok: false, out: invalid("pedido fora do schema", errors) };
  const req = parsed as DelegationRequest;
  if (req.brain === req.executor && !req.model) {
    return { ok: false, out: invalid(`delegar ao mesmo cliente (${req.brain}) exige "model" explícito (outro modelo da mesma conta); sem isso, faça você mesmo`) };
  }
  if (req.brainModel && req.model && req.brain === req.executor && req.brainModel.toLowerCase() === req.model.toLowerCase()) {
    return { ok: false, out: invalid(`o modelo pedido (${req.model}) é o próprio cérebro; faça você mesmo em vez de delegar`) };
  }
  if (req.needs?.includes("image_generation") && req.kind !== "asset") {
    return { ok: false, out: invalid('needs=["image_generation"] exige kind="asset"') };
  }
  return { ok: true, req };
}

type Gates = { resolved: ReturnType<typeof resolveExecutable> & { ok: true }; caps: Capabilities; entries: ScopeEntry[] };

function runGates(
  req: DelegationRequest,
  task: Task,
  run: Run,
  cfg: DuoConfig,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  authPaths: AuthPaths,
  catalog: Catalog | null,
): { ok: true; gates: Gates } | { ok: false; reason: string } {
  const policy = policyBlockReason(req, cfg, run);
  if (policy) return { ok: false, reason: `política: ${policy}` };

  const readOnly = !isWriteKind(req.kind);
  const scope = validateScope(projectRoot, req.scope.allowedPaths, cfg.scope.deny, { allowWholeProject: readOnly });
  if (!scope.ok) return { ok: false, reason: `escopo inválido: ${scope.errors.join("; ")}` };

  for (const c of req.acceptance.commands ?? []) {
    if (!isAllowlisted(c.argv, cfg.acceptance.allowedCommands)) {
      return { ok: false, reason: `comando de aceite "${c.name}" (${c.argv.join(" ")}) não está em acceptance.allowedCommands de .duo/config.json` };
    }
  }

  const resolved = resolveExecutable(req.executor, cfg.executors[req.executor].command, env);
  if (!resolved.ok) return { ok: false, reason: `executor indisponível: ${resolved.reason}` };
  const { env: probeEnv } = childEnv(env);
  const caps = req.executor === "claude" ? probe(resolved, ["--help"], CLAUDE_FLAGS, probeEnv) : probe(resolved, ["exec", "--help"], CODEX_EXEC_FLAGS, probeEnv);
  if (caps.missingRequired.length) {
    return { ok: false, reason: `versão ${caps.version ?? "desconhecida"} do ${req.executor} não anuncia recursos obrigatórios: ${caps.missingRequired.join(", ")}` };
  }
  if (task.model.requested && !caps.flags.model) return { ok: false, reason: `modelo solicitado, mas esta versão do ${req.executor} não anuncia --model` };
  if (task.needs.includes("image_generation") && req.executor === "codex" && !caps.flags.enable) {
    return { ok: false, reason: "esta versão do codex não anuncia --enable, necessário para ligar image_generation" };
  }

  const pc = catalog?.providers[req.executor];
  // Catálogo desatualizado (fontes atuais falharam) não bloqueia: a CLI confirma o modelo na execução.
  if (pc?.ok && !pc.stale) {
    if (task.model.requested && !findModel(catalog as Catalog, req.executor, task.model.requested)) {
      return { ok: false, reason: `modelo ${task.model.requested} não está disponível na conta do ${req.executor}; disponíveis: ${pc.models.map((m) => m.id).join(", ")} (duo models --refresh atualiza a lista)` };
    }
    if (task.needs.includes("image_generation") && !pc.tools.includes("image_generation")) {
      return { ok: false, reason: `o ${req.executor} desta conta não oferece geração de imagem; escolha um executor com essa capacidade (duo models)` };
    }
  } else if (task.needs.includes("image_generation") && req.executor === "claude") {
    return { ok: false, reason: "o Claude Code não gera imagens raster; use um executor com image_generation (duo models)" };
  }

  const auth = checkAuth(req.executor, resolved, cfg, authPaths, env);
  const authReason = authBlockReason(auth);
  if (authReason) return { ok: false, reason: `autenticação/cobrança: ${authReason}` };

  return { ok: true, gates: { resolved, caps, entries: scope.entries } };
}

function normalizeClaimed(execCwd: string, p: string): string {
  const abs = resolve(execCwd, p);
  const rel = relative(execCwd, abs).split(sep).join("/");
  return rel.startsWith("..") ? p : rel;
}

export async function delegate(opts: DelegateOptions): Promise<DelegateOutcome> {
  const env = opts.env ?? process.env;
  if (opts.timeoutSecOverride !== undefined && (!Number.isInteger(opts.timeoutSecOverride) || opts.timeoutSecOverride < 10 || opts.timeoutSecOverride > 3600)) {
    return invalid("--timeout-sec deve ser um inteiro entre 10 e 3600");
  }
  if (Number(env.DUO_DEPTH ?? "0") >= 1) {
    return invalid("delegação recursiva bloqueada: este processo é um executor (profundidade 1)", [], EXIT.blocked);
  }
  const top = repoRoot(opts.cwd);
  if (!top) return invalid("duo delegate requer um repositório Git (o estado base é registrado pelo Git)");
  const projectRoot = realpathSync(top);
  let cfg: DuoConfig;
  try {
    cfg = loadConfig(projectRoot);
  } catch (e) {
    return invalid((e as ConfigError).message);
  }
  const store = new Store(projectRoot);
  const authPaths = opts.authPaths ?? defaultAuthPaths(projectRoot, env);

  let req: DelegationRequest;
  let task: Task;
  let run: Run;
  let resuming = false;

  if (opts.resumeTaskId) {
    const found = store.findTask(opts.resumeTaskId);
    if (!found) return invalid(`task não encontrada: ${opts.resumeTaskId}`);
    task = found;
    const r = store.loadRun(task.runId);
    if (!r) return invalid(`run ausente para a task ${task.taskId}`);
    run = r;
    if (task.state === "running") {
      if (task.pids.bridge && isPidAlive(task.pids.bridge)) return invalid(`task ${task.taskId} ainda está em execução (pid ${task.pids.bridge})`);
      transition(task, "blocked", "interrompida: o processo da ponte não está mais ativo");
      store.saveTask(task);
    }
    if (task.pids.child && isPidAlive(task.pids.child)) {
      return invalid(`o executor da task ${task.taskId} ainda está ativo (pid ${task.pids.child}); rode duo cancel --run-id ${run.runId} antes de retomar`);
    }
    if (task.state !== "blocked") return invalid(`só tarefas em blocked podem ser retomadas (estado atual: ${task.state})`);
    const saved = readJson<DelegationRequest>(join(task.artifactsDir, "request.json"));
    if (!saved) return invalid("request.json da task não encontrado");
    req = saved;
    resuming = task.base !== null;
  } else {
    if (!opts.requestPath) return invalid("informe --request <arquivo.json> ou --resume <taskId>");
    const parsed = readRequest(opts.cwd, opts.requestPath);
    if (!parsed.ok) return parsed.out;
    req = parsed.req;
    if (req.runId) {
      const r = store.loadRun(req.runId);
      if (!r) return invalid(`run não encontrado: ${req.runId}`);
      run = r;
    } else {
      run = newRun(req, cfg);
    }
    let retryOf: string | undefined;
    if (req.taskKey) {
      const { runId: _r, taskKey: _k, ...hashable } = req;
      const hash = stableHash(hashable);
      for (const prev of store.listTasks(run).filter((t) => t.taskKey === req.taskKey)) {
        if (prev.state === "succeeded" && prev.requestHash === hash) {
          return { exitCode: EXIT.ok, summary: { ...summarize(prev), reused: true, note: "resultado já existente para este taskKey; nenhuma nova invocação" } };
        }
        if (prev.state === "running" || prev.state === "approved") return invalid(`taskKey ${req.taskKey} já está em execução (${prev.taskId})`);
        if (prev.state === "blocked") return invalid(`taskKey ${req.taskKey} está bloqueada (${prev.taskId}); use duo delegate --resume ${prev.taskId}`);
        retryOf = prev.taskId;
      }
    }
    task = newTask(req, run, store, cfg);
    if (retryOf) task.retryOf = retryOf;
    run.taskIds.push(task.taskId);
    store.saveRun(run);
    mkdirSync(task.artifactsDir, { recursive: true });
    writeJsonAtomic(join(task.artifactsDir, "request.json"), redactDeep(req));
    store.saveTask(task);
  }

  let catalog: Catalog | null = null;
  try {
    catalog = await loadCatalog(store, cfg, { env });
  } catch {
    catalog = null; // sem catálogo, a disponibilidade do modelo é confirmada na execução
  }
  const gate = runGates(req, task, run, cfg, projectRoot, env, authPaths, catalog);
  if (!gate.ok) {
    transition(task, "blocked", gate.reason);
    store.saveTask(task);
    store.telemetry({ event: "task_blocked", runId: run.runId, taskId: task.taskId, executor: task.executor, reason: gate.reason });
    return { exitCode: EXIT.blocked, summary: summarize(task) };
  }
  const { resolved, caps, entries } = gate.gates;
  task.tags = deriveTags(projectRoot, entries);
  const execCatalog = catalog?.providers[req.executor];
  if (execCatalog?.stale && (task.model.requested || task.needs.includes("image_generation"))) {
    const note = `catálogo do ${req.executor} desatualizado (de ${execCatalog.staleSince}): modelo/capacidade não confirmados antes da execução`;
    if (!task.limitations.includes(note)) task.limitations.push(note);
  }
  transition(task, "approved", resuming ? "retomada aprovada após nova verificação" : "validação, política e autenticação aprovadas");
  store.saveTask(task);

  const lock = new ExecutorLock(projectRoot);
  const acquired = lock.acquire(task.taskId, run.runId);
  if (!acquired.ok) {
    transition(task, "blocked", `outro executor está ativo neste projeto (${acquired.holder?.taskId ?? "?"}, pid ${acquired.holder?.pid ?? "?"}); o MVP permite um executor por vez`);
    store.saveTask(task);
    return { exitCode: EXIT.blocked, summary: summarize(task) };
  }

  try {
    const timeoutSec = opts.timeoutSecOverride ?? req.limits?.timeoutSec ?? cfg.limits.timeoutSec;
    const codexHome = env.CODEX_HOME ?? join(authPaths.home, ".codex");
    return await execute({ req, task, run, cfg, store, projectRoot, env, lock, resolved, caps, entries, resuming, timeoutSec, codexHome, ...(opts.signal ? { signal: opts.signal } : {}) });
  } finally {
    lock.release();
  }
}

type ExecCtx = {
  req: DelegationRequest;
  task: Task;
  run: Run;
  cfg: DuoConfig;
  store: Store;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  lock: ExecutorLock;
  resolved: Gates["resolved"];
  caps: Capabilities;
  entries: ScopeEntry[];
  resuming: boolean;
  timeoutSec: number;
  codexHome: string;
  signal?: AbortSignal;
};

async function execute(ctx: ExecCtx): Promise<DelegateOutcome> {
  const { req, task, run, cfg, store, projectRoot, env, lock, entries } = ctx;
  const scopeRels = entries.map((e) => e.rel);
  const snapshotDir = join(task.artifactsDir, "snapshot");
  const worktreeMode = task.isolation === "worktree";
  const block = (reason: string): DelegateOutcome => {
    transition(task, "blocked", reason);
    store.saveTask(task);
    return { exitCode: EXIT.blocked, summary: summarize(task) };
  };

  // Estado base (preservado entre tentativas para que a retomada não repita mudanças).
  let alreadyModified: string[] = [];
  if (!task.base) {
    const state = captureState(projectRoot, scopeRels);
    const dirtyInScope = dirtyPaths(projectRoot).filter((p) => !p.startsWith(".duo/") && inScope(p, entries));
    if (worktreeMode) {
      if (!state.head) return block("isolation=worktree requer ao menos um commit");
      if (dirtyInScope.length) return block(`isolation=worktree requer o escopo sem alterações não commitadas (${dirtyInScope.join(", ")}); use in-place ou faça commit`);
    } else if (isWriteKind(task.kind)) {
      const snap = snapshotFiles(projectRoot, state.scopeFiles, snapshotDir, cfg.limits.maxSnapshotBytes);
      if (snap.skipped.length) task.limitations.push(`snapshot excedeu o limite; diff exato indisponível para: ${snap.skipped.join(", ")}`);
    }
    task.base = { head: state.head, dirtyInScope, hashes: state.hashes };
  } else if (!worktreeMode) {
    alreadyModified = diffStates(projectRoot, baseState(task), scopeRels).changed.filter((p) => !p.startsWith(".duo/"));
  }

  let execCwd = projectRoot;
  if (worktreeMode) {
    const wt = join(store.base, "worktrees", task.taskId);
    if (!existsSync(wt)) {
      const r = worktreeAdd(projectRoot, wt, task.base.head as string);
      if (!r.ok) return block(`falha ao criar worktree: ${redact(r.stderr.slice(0, 300))}`);
    } else if (ctx.resuming) {
      alreadyModified = worktreePatch(wt, task.base.head as string).files;
    }
    task.worktree = wt;
    execCwd = realpathSync(wt);
  }

  const prompt = buildExecutorPrompt(task, {
    dirtyInScope: task.base.dirtyInScope,
    resume: ctx.resuming ? { alreadyModified } : null,
    worktree: worktreeMode,
    ...(req.context?.interfaces ? { interfaces: req.context.interfaces } : {}),
    ...(req.context?.decisions ? { decisions: req.context.decisions } : {}),
    ...(req.context?.notes ? { notes: req.context.notes } : {}),
  });
  const promptBytes = Buffer.byteLength(prompt);
  if (promptBytes > cfg.limits.maxPromptBytes) {
    return block(`contexto de ${promptBytes} bytes excede limits.maxPromptBytes (${cfg.limits.maxPromptBytes}); reduza o contexto sem remover requisitos`);
  }
  writeFileSync(join(task.artifactsDir, "prompt.txt"), redact(prompt));

  const writes = isWriteKind(task.kind);
  const { env: execEnv } = childEnv(env, { DUO_DEPTH: "1", DUO_TASK_ID: task.taskId, DUO_RUN_ID: run.runId });
  const adapter = ADAPTERS[task.executor];
  let plan: ReturnType<ExecutorAdapter["plan"]>;
  try {
    plan = adapter.plan({
    resolved: ctx.resolved,
    caps: ctx.caps,
    cfg,
    cwd: execCwd,
    kind: task.kind,
    prompt,
    writableAbs: writes ? entries.map((e) => ({ abs: join(execCwd, ...e.rel.split("/")), isDir: e.isDir })) : [],
    denyGlobs: cfg.scope.deny,
    acceptanceArgv: task.acceptanceCommands.map((c) => c.argv),
    needs: task.needs,
    model: task.model.requested,
    resumeSessionId: ctx.resuming ? task.native.sessionId : null,
    artifactsDir: task.artifactsDir,
    env: execEnv,
    });
  } catch (e) {
    return block(`não foi possível montar a invocação do ${task.executor}: ${(e as Error).message}`);
  }
  writeJsonAtomic(join(task.artifactsDir, "invocation.json"), redactDeep({ command: plan.command, args: plan.args, cwd: plan.cwd, enforced: plan.enforced }));

  transition(task, "running", ctx.resuming ? "retomando execução" : "executor iniciado");
  task.invocations++;
  task.pids = { bridge: process.pid, child: null };
  run.invocations++;
  store.saveRun(run);
  store.saveTask(task);
  store.telemetry({ event: "task_started", runId: run.runId, taskId: task.taskId, brain: task.brain, executor: task.executor, kind: task.kind, resumed: ctx.resuming });

  const parser = adapter.parser();
  const eventsPath = join(task.artifactsDir, "events.jsonl");
  let loggedBytes = 0;
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess({
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
      env: plan.env,
      stdin: plan.stdin,
      timeoutMs: ctx.timeoutSec * 1000,
      maxOutputBytes: cfg.limits.maxOutputBytes,
      firstSignal: plan.firstSignal,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onSpawn: (pid) => {
        task.pids.child = pid;
        store.saveTask(task);
      },
      onLine: (line) => {
        parser.onLine(line);
        if (loggedBytes < MAX_EVENT_LOG_BYTES) {
          const safe = sanitizeEventLine(task.executor, line);
          loggedBytes += safe.length + 1;
          appendFileSync(eventsPath, `${safe}\n`);
        }
      },
    });
  } catch (e) {
    // Falha ao registrar o andamento (ex.: disco cheio): o executor já foi encerrado; a task não pode ficar "running".
    task.pids.child = null;
    try {
      return block(`falha ao registrar o andamento do executor (${(e as Error).message}); o executor foi encerrado`);
    } catch {
      throw e;
    }
  }
  if (result.stderrTail) writeFileSync(join(task.artifactsDir, "stderr.txt"), redact(result.stderrTail));
  const lastMessage = plan.lastMessagePath && existsSync(plan.lastMessagePath) ? readFileSync(plan.lastMessagePath, "utf8") : null;
  const outcome = parser.finish(lastMessage);
  const lockIntact = lock.intact();
  const cancelledExternally = store.loadRun(run.runId)?.cancelled === true;

  if (outcome.sessionId) task.native.sessionId = outcome.sessionId;
  task.model.reported = outcome.reportedModel;
  task.model.reportedSource = outcome.reportedModel ? "native" : "unavailable";
  // O JSONL do codex exec não informa o modelo; o rollout da própria sessão sim (e traz os IDs de resposta do servidor).
  const codexEvidence = task.executor === "codex" ? collectCodexEvidence(ctx.codexHome, task.native.sessionId, Date.now() - result.durationMs) : null;
  if (task.executor === "codex") {
    task.evidence = { codex: codexEvidence };
    if (codexEvidence?.model && !task.model.reported) {
      task.model.reported = codexEvidence.model;
      task.model.reportedSource = "native";
      task.model.reportedVia = "codex-rollout";
    }
    const expectedSandbox = isWriteKind(task.kind) ? "workspace-write" : "read-only";
    if (codexEvidence?.sandbox && codexEvidence.sandbox !== expectedSandbox) {
      task.limitations.push(`o rollout do codex registrou sandbox ${codexEvidence.sandbox}, esperado ${expectedSandbox}`);
    }
  }
  task.executorReport = outcome.report;
  if (loggedBytes >= MAX_EVENT_LOG_BYTES) task.limitations.push("log de eventos truncado em 2 MiB (parsing continuou sobre o stream completo)");
  if (outcome.unknownTypes.length) task.limitations.push(`eventos desconhecidos ignorados: ${outcome.unknownTypes.join(", ")}`);

  const verification = verify(ctx, execCwd, outcome, lockIntact);
  task.verification = verification;
  if (verification.images?.length) {
    const generated = new Set((codexEvidence?.generatedImages ?? []).map((g) => g.sha256));
    const images = verification.images.map((img) => {
      const sha256 = sha256File(join(execCwd, img.path));
      return { path: img.path, sha256, generatedByExecutorTool: generated.has(sha256) };
    });
    task.evidence = { ...(task.evidence ?? {}), images };
  }

  const processOk = !result.timedOut && !result.cancelled && !result.outputLimitExceeded && !result.spawnError && !cancelledExternally;
  const violations = [...verification.outOfScope, ...verification.deniedTouched];
  if (processOk && lockIntact && violations.length === 0 && !outcome.errorKind && outcome.report?.status === "completed" && !verification.staleBase) {
    verification.acceptance = await runAcceptance(task.acceptanceCommands, cfg, execCwd, childEnv(env, { DUO_DEPTH: "1" }).env, ctx.signal);
  }
  for (const w of [...new Set(outcome.warnings)].slice(0, 5)) task.limitations.push(`aviso do ${task.executor}: ${w}`);
  if (task.model.requested && task.model.reported && !modelMatches(task.model.requested, task.model.reported)) {
    task.limitations.push(`modelo solicitado ${task.model.requested}, mas o cliente informou ${task.model.reported}`);
  }
  if (outcome.rateLimit?.isUsingOverage === true) {
    task.limitations.push(`o cliente ${task.executor} informou uso extra (overage) ativo nesta execução; pode haver cobrança além da assinatura`);
  }
  if (task.acceptanceCommands.length === 0) task.limitations.push("sem comandos de aceite: verificação limitada a escopo, diff e relatório estruturado");

  const [state, reason] = decide(task, result, outcome, verification, violations, cancelledExternally);
  task.pids.child = null;
  task.metrics = {
    wallMs: result.durationMs,
    promptBytes,
    promptTokensEstimate: { value: Math.ceil(promptBytes / 4), source: "local-estimate", method: "bytes/4 (heurística local, não é contagem do fornecedor)" },
    native: {
      source: outcome.usage ? "native" : "unavailable",
      provider: task.executor,
      capturedAt: new Date().toISOString(),
      usage: outcome.usage,
      cacheSemantics: outcome.cacheSemantics,
      costUsdClientEstimate: outcome.costUsd,
      numTurns: outcome.numTurns,
      durationMs: outcome.durationMs,
      rateLimit: outcome.rateLimit,
    },
    events: { ...outcome.events, oversize: result.oversizeLines },
  };
  transition(task, state, reason);
  store.saveTask(task);
  store.telemetry({
    event: "task_finished",
    runId: run.runId,
    taskId: task.taskId,
    brain: task.brain,
    executor: task.executor,
    kind: task.kind,
    state,
    outcome: reason,
    resumed: ctx.resuming,
    retryOf: task.retryOf ?? null,
    wallMs: result.durationMs,
    acceptanceRan: verification.acceptance.filter((a) => a.ran).length,
    acceptancePassed: verification.acceptance.filter((a) => a.passed).length,
    filesChanged: verification.filesChangedActual.length,
    usage: outcome.usage,
    usageSource: outcome.usage ? "native" : "unavailable",
    costUsdClientEstimate: outcome.costUsd,
    rateLimit: outcome.rateLimit,
    requestedModel: task.model.requested,
    reportedModel: task.model.reported,
  });
  return { exitCode: exitFor(state), summary: summarize(task) };
}

/** Aliases (opus, sonnet) casam por família; IDs completos exigem igualdade de prefixo. */
export function modelMatches(requested: string, reported: string): boolean {
  const r = requested.toLowerCase();
  const got = reported.toLowerCase();
  if (/^(opus|sonnet|haiku|fable)$/.test(r)) return got.includes(r);
  return got === r || got.startsWith(`${r}-`) || got.startsWith(`${r}[`);
}

/** Confere a assinatura binária de uma imagem e, quando possível, as dimensões. */
export function imageInfo(abs: string): { format: string; bytes: number; width: number | null; height: number | null } | null {
  let b: Buffer;
  try {
    b = readFileSync(abs);
  } catch {
    return null;
  }
  if (b.length < 16) return null;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: "png", bytes: b.length, width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { format: "jpeg", bytes: b.length, width: null, height: null };
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { format: "webp", bytes: b.length, width: null, height: null };
  if (b.subarray(0, 6).toString("latin1").startsWith("GIF8")) return { format: "gif", bytes: b.length, width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  return null;
}

function baseState(task: Task): TreeState {
  return { head: task.base?.head ?? null, hashes: task.base?.hashes ?? {}, scopeFiles: [] };
}

function verify(ctx: ExecCtx, execCwd: string, outcome: ParsedOutcome, lockIntact: boolean): Verification {
  const { task, projectRoot, entries, cfg } = ctx;
  const scopeRels = entries.map((e) => e.rel);
  const readOnly = !isWriteKind(task.kind);
  let changed: string[];
  let diffPath: string | null = null;
  let patchPath: string | null = null;
  let staleBase = false;

  if (task.worktree) {
    const p = worktreePatch(execCwd, task.base?.head as string);
    changed = p.files;
    if (p.patch) {
      patchPath = join(task.artifactsDir, "changes.patch");
      writeFileSync(patchPath, p.patch);
      diffPath = patchPath;
    }
    const mainChanged = diffStates(projectRoot, baseState(task), scopeRels).changed.filter((x) => !x.startsWith(".duo/") && inScope(x, entries));
    staleBase = headCommit(projectRoot) !== task.base?.head || mainChanged.length > 0;
  } else {
    changed = diffStates(projectRoot, baseState(task), scopeRels).changed.filter((x) => !x.startsWith(".duo/"));
    const inScopeChanged = changed.filter((x) => inScope(x, entries));
    const diff = diffAgainstSnapshot(projectRoot, join(task.artifactsDir, "snapshot"), inScopeChanged);
    if (diff) {
      diffPath = join(task.artifactsDir, "changes.diff");
      writeFileSync(diffPath, redact(diff));
    }
    staleBase = headCommit(projectRoot) !== task.base?.head;
  }

  const deniedTouched = changed.filter((x) => isDenied(x, cfg.scope.deny) !== null);
  const images =
    task.kind === "asset" || task.needs.includes("image_generation")
      ? changed.filter((x) => inScope(x, entries)).flatMap((rel) => {
          const info = imageInfo(join(execCwd, ...rel.split("/")));
          return info ? [{ path: rel, ...info }] : [];
        })
      : undefined;
  const outOfScope = readOnly ? changed : changed.filter((x) => !inScope(x, entries) && !deniedTouched.includes(x));
  const claimed = new Set((outcome.report?.filesChanged ?? []).map((p) => normalizeClaimed(execCwd, p)));
  const actual = new Set(changed);
  const claimsMismatch = [
    ...[...claimed].filter((p) => !actual.has(p)).map((p) => `declarado mas não alterado: ${p}`),
    ...[...actual].filter((p) => !claimed.has(p)).map((p) => `alterado mas não declarado: ${p}`),
  ];
  return {
    filesChangedActual: changed,
    outOfScope,
    deniedTouched,
    claimsMismatch: outcome.report ? claimsMismatch : [],
    acceptance: [],
    staleBase,
    lockIntact,
    partialWork: changed.length > 0,
    diffPath,
    patchPath,
    ...(images ? { images } : {}),
  };
}

function decide(
  task: Task,
  r: Awaited<ReturnType<typeof runProcess>>,
  o: ParsedOutcome,
  v: Verification,
  violations: string[],
  cancelledExternally: boolean,
): [TaskState, string] {
  const partial = v.partialWork ? " Há trabalho parcial no escopo (ver diff); nada foi revertido." : "";
  if (r.cancelled || cancelledExternally) return ["cancelled", `cancelado pelo usuário.${partial}`];
  if (r.timedOut) return ["blocked", `timeout do executor; processo encerrado.${partial} Retome com duo delegate --resume ${task.taskId}.`];
  if (r.outputLimitExceeded) return ["failed", `saída do executor excedeu limits.maxOutputBytes; processo encerrado.${partial}`];
  if (r.spawnError) return ["failed", `falha ao iniciar o executor: ${r.spawnError}`];
  if (!v.lockIntact) return ["failed", "o lock de executor único foi removido ou trocado durante a execução; resultado não integrado"];
  if (violations.length) {
    return ["failed", `violação de escopo: ${violations.join(", ")}. As alterações não foram revertidas automaticamente; revise antes de integrar.`];
  }
  if (o.errorKind === "quota") {
    return ["blocked", `limite/cota do ${task.executor} atingido (${o.errorMessage ?? "sem detalhe"}). Sem nova tentativa automática: aguarde o reset, execute no próprio cérebro ou prepare um handoff.${partial}`];
  }
  if (o.errorKind === "auth") return ["blocked", `falha de autenticação no ${task.executor}: ${o.errorMessage ?? ""}. Nenhum método alternativo de cobrança foi tentado.`];
  if (o.errorKind === "model_unavailable") {
    const hint = /or newer is required|version_too_old/i.test(o.errorMessage ?? "") ? ` Atualize a CLI (${task.executor === "claude" ? "claude update" : "npm install -g @openai/codex"}) ou ajuste executors.${task.executor}.model.` : "";
    return ["failed", `modelo indisponível no ${task.executor} (${task.model.requested ?? "padrão"}): ${o.errorMessage ?? ""}${hint}`];
  }
  if (o.errorKind) return ["failed", `${o.errorKind}: ${o.errorMessage ?? ""}${o.reportErrors.length ? ` [${o.reportErrors.slice(0, 5).join("; ")}]` : ""}${partial}`];
  const rep = o.report;
  if (!rep) return ["failed", "sem relatório estruturado"];
  if (rep.status === "blocked" || rep.status === "partial") return ["blocked", `executor reportou ${rep.status}: ${rep.blockedReason ?? rep.summary}`.slice(0, 600)];
  if (rep.status === "failed") return ["failed", `executor reportou falha: ${rep.summary}`.slice(0, 600)];
  if (v.staleBase) return ["failed", "o estado base mudou durante a execução (HEAD ou arquivos do escopo); resultado não integrado"];
  if (task.needs.includes("image_generation") && !(v.images ?? []).length) {
    return ["failed", "nenhuma imagem válida (PNG/JPEG/WebP/GIF) foi gravada no escopo autorizado, apesar do relatório \"completed\""];
  }
  const failedAcceptance = v.acceptance.filter((a: AcceptanceResult) => !a.passed);
  if (failedAcceptance.length) {
    return ["failed", `critério de aceite falhou apesar do relatório "completed": ${failedAcceptance.map((a) => `${a.name} (exit ${a.exitCode ?? a.skippedReason ?? "?"})`).join(", ")}`];
  }
  return ["succeeded", task.worktree ? `concluído e verificado no worktree; integre com duo apply --task-id ${task.taskId}` : "concluído e verificado"];
}

export function summarize(task: Task): Record<string, unknown> {
  const v = task.verification;
  const next: string[] = [];
  if (task.state === "succeeded" && task.worktree && !task.applied) next.push(`duo apply --task-id ${task.taskId}`);
  if (task.state === "succeeded" && v?.diffPath) next.push(`revisar o diff: ${v.diffPath}`);
  if (task.state === "blocked") next.push(`corrigir a causa e retomar: duo delegate --resume ${task.taskId}`);
  if (task.state === "succeeded" || task.state === "failed") next.push(`registrar decisão: duo accept --task-id ${task.taskId} [--reject] --note "..."`);
  return {
    taskId: task.taskId,
    runId: task.runId,
    state: task.state,
    outcome: task.outcome,
    brain: task.brain,
    executor: task.executor,
    kind: task.kind,
    summary: task.executorReport?.summary ?? null,
    executorStatus: task.executorReport?.status ?? null,
    filesChanged: v?.filesChangedActual ?? [],
    outOfScope: v?.outOfScope ?? [],
    deniedTouched: v?.deniedTouched ?? [],
    claimsMismatch: v?.claimsMismatch ?? [],
    acceptance: (v?.acceptance ?? []).map((a) => ({ name: a.name, ran: a.ran, passed: a.passed, exitCode: a.exitCode, ...(a.skippedReason ? { skippedReason: a.skippedReason } : {}) })),
    diff: v?.diffPath ?? null,
    ...(v?.images ? { images: v.images } : {}),
    worktree: task.worktree,
    model: task.model,
    ...(task.evidence ? { evidence: summarizeEvidence(task.evidence) } : {}),
    invocations: task.invocations,
    metrics: task.metrics
      ? { wallMs: task.metrics.wallMs, nativeUsage: task.metrics.native.usage, nativeSource: task.metrics.native.source, costUsdClientEstimate: task.metrics.native.costUsdClientEstimate }
      : null,
    limitations: task.limitations,
    taskFile: join(task.artifactsDir, "task.json"),
    next,
  };
}

/** Resumo das provas para o cérebro: sem caminhos internos longos além do necessário. */
function summarizeEvidence(e: NonNullable<Task["evidence"]>): Record<string, unknown> {
  const c = e.codex;
  return {
    ...(e.codex !== undefined
      ? {
          codexSession: c
            ? { model: c.model, modelProvider: c.modelProvider, originator: c.originator, cliVersion: c.cliVersion, sandbox: c.sandbox, effort: c.effort, serverResponseIds: c.responseIds, tools: c.tools, rollout: c.file }
            : "rollout não encontrado (formato não contratual)",
        }
      : {}),
    ...(e.images ? { images: e.images } : {}),
  };
}
