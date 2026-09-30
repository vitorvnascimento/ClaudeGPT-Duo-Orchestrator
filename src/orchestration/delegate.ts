// Fluxo determinístico de uma delegação: valida, aplica restrições, aciona a CLI do executor,
// verifica o resultado de forma independente e registra estado e métricas. Não é um segundo cérebro.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { CODEX_EXEC_FLAGS, CLAUDE_FLAGS, probe, type Capabilities } from "../adapters/capabilities.js";
import { findModel, loadCatalog, type Catalog, type ModelInfo } from "../adapters/catalog.js";
import { collectCodexEvidence, sha256File } from "../adapters/codex-rollout.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
import { isPidAlive, runProcess } from "../adapters/process.js";
import { resolveExecutable } from "../adapters/resolve.js";
import { sanitizeEventLine } from "../adapters/sanitize.js";
import type { ExecutorAdapter, ParsedOutcome } from "../adapters/types.js";
import { ConfigError, loadConfig, type DuoConfig, type Provider } from "../config.js";
import { captureState, diffAgainstSnapshot, diffStates, dirtyPaths, headCommit, repoRoot, snapshotFiles, worktreeAdd, worktreePatch, type TreeState } from "../git.js";
import { authBlockReason, checkAuth, childEnv, codexConfiguredModel, defaultAuthPaths, type AuthPaths } from "../permissions/auth.js";
import { inScope, isDenied, validateScope, type ScopeEntry } from "../permissions/scope.js";
import { createStreamRedactor, redact, redactDeep } from "../redact.js";
import { loadSchema, validate } from "../schema.js";
import { transition } from "../state/machine.js";
import { ExecutorLock, newId, readJson, Store, writeJsonAtomic } from "../state/store.js";
import { isWriteKind, type AcceptanceResult, type DelegationRequest, type Run, type Task, type TaskState, type Verification } from "../state/types.js";
import { isAllowlisted, runAcceptance } from "./acceptance.js";
import { policyBlockReason } from "./policy.js";
import { buildExecutorPrompt } from "./prompt.js";
import { EFFORTS, selectEffort, tierOf, type Effort, type Tier } from "../adapters/tiers.js";
import { assessComplexity, TIERS, tierRank } from "./complexity.js";
import { selectModel, type ModelSelection } from "./select.js";
import { observeTaskQuota, quotaBlock, quotaStates } from "./quota.js";
import { deriveTags, evaluateCandidates, liveAvailability } from "./router.js";

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
  adaptive?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  authPaths?: AuthPaths;
};

export type DelegateOutcome = { exitCode: number; summary: Record<string, unknown>; verificationFailed?: boolean; quotaExceeded?: boolean };

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

function blockTask(task: Task, reason: string): void {
  if (task.state !== "blocked") transition(task, "blocked", reason);
  else { task.outcome = reason; task.updatedAt = new Date().toISOString(); }
}

const chainRoot = (task: Task): string => task.selection?.chainRoot ?? task.selection?.attemptOf ?? task.taskId;
const effortRank = (effort: string | null | undefined): number => EFFORTS.indexOf(effort as Effort);

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
    effort: { requested: req.effort ?? null },
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

function readRequest(cwd: string, requestPath: string, adaptiveEnabled: boolean): { ok: true; req: DelegationRequest } | { ok: false; out: DelegateOutcome } {
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
  if (req.brain === req.executor && !req.model && (!adaptiveEnabled || req.adaptive === false)) {
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
  if (task.effort?.requested && !(req.executor === "claude" ? caps.flags.effort : caps.flags.config)) {
    return { ok: false, reason: `esforço solicitado (${task.effort.requested}), mas esta versão do ${req.executor} não anuncia ${req.executor === "claude" ? "--effort" : "--config"}` };
  }
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
      blockTask(task, "interrompida: o processo da ponte não está mais ativo");
      store.saveTask(task);
    }
    if (task.pids.child && isPidAlive(task.pids.child)) {
      return invalid(`o executor da task ${task.taskId} ainda está ativo (pid ${task.pids.child}); rode duo cancel --run-id ${run.runId} antes de retomar`);
    }
    if (task.state !== "blocked") return invalid(`só tarefas em blocked podem ser retomadas (estado atual: ${task.state})`);
    const root = store.findTask(chainRoot(task)) ?? task;
    const saved = readJson<DelegationRequest>(join(root.artifactsDir, "request.json"));
    if (!saved) return invalid("request.json da task não encontrado");
    req = saved;
    resuming = task.base !== null;
  } else {
    if (!opts.requestPath) return invalid("informe --request <arquivo.json> ou --resume <taskId>");
    const parsed = readRequest(opts.cwd, opts.requestPath, cfg.routing.adaptive.enabled && opts.adaptive !== false);
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
      const latest = new Map<string, Task>();
      for (const prev of store.listTasks(run).filter((t) => t.taskKey === req.taskKey)) {
        const root = chainRoot(prev), last = latest.get(root);
        if (!last || (prev.selection?.attempt ?? 1) >= (last.selection?.attempt ?? 1)) latest.set(root, prev);
      }
      const reused = [...latest.values()].find((t) => t.state === "succeeded" && (store.findTask(chainRoot(t))?.requestHash ?? t.requestHash) === hash);
      if (reused) return { exitCode: EXIT.ok, summary: { ...summarize(reused), reused: true, note: "resultado já existente para este taskKey; nenhuma nova invocação" } };
      for (const prev of latest.values()) {
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
  const adaptive = cfg.routing.adaptive.enabled && req.adaptive !== false && opts.adaptive !== false;
  const scope = validateScope(projectRoot, req.scope.allowedPaths, cfg.scope.deny, { allowWholeProject: !isWriteKind(req.kind) });
  const entriesForSelection = scope.ok ? scope.entries : [];
  const tags = scope.ok ? deriveTags(projectRoot, entriesForSelection, true) : [];
  const assessment = assessComplexity(req, entriesForSelection, tags, cfg.routing.adaptive.lightMaxFiles);
  let target: Tier = assessment.tier;
  let escalateToMax = false;
  let previous: Task | null = null;
  const originalReq = req;
  const rootId = chainRoot(task);
  const chainTasks = () => store.listTasks(run).filter((t) => chainRoot(t) === rootId);
  const chainAttempt = () => Math.max(task.selection?.attempt ?? 1, ...chainTasks().map((t) => t.selection?.attempt ?? 1));
  let minimumEffort = EFFORTS[Math.max(-1, ...chainTasks().map((t) => effortRank(t.effort?.requested)))];
  const origin = task.selection?.origin ?? { model: originalReq.model ? "explicit" as const : "auto" as const, effort: originalReq.effort ? "explicit" as const : "auto" as const };
  let quotaChoice: ModelSelection | null = null;
  let fallbacks: NonNullable<Task["selection"]>["fallbacks"] = task.selection?.fallbacks;
  for (;;) {
    let execReq = { ...originalReq, executor: task.executor };
    const restoring = !!opts.resumeTaskId && previous === null && !!task.selection;
    if (restoring) {
      if (task.model.requested) execReq.model = task.model.requested;
      if (task.effort?.requested) execReq.effort = task.effort.requested as Effort;
      task.selection!.chainRoot ??= rootId;
      task.selection!.origin ??= origin;
    }
    if (adaptive && !restoring) {
      if (assessment.signals.includes("risk=high")) task.risk = "high";
      const candidates = evaluateCandidates(store, cfg, { kind: req.kind, tags, risk: req.risk ?? "medium", brain: req.brain, needs: req.needs, complexity: target }, liveAvailability(store, cfg, env, authPaths), catalog).evals;
      const chosen: ModelSelection | null = quotaChoice ?? (escalateToMax && previous?.model.requested ? { model: previous.model.requested, tier: previous.selection?.tier ?? "deep", effort: null, reason: ["deep sem nível acima: mesmo modelo, esforço máximo suportado"] } : origin.model === "auto" ? selectModel(catalog, cfg, task.executor, target, { candidates, floor: assessment.floor, needs: req.needs, minimumEffort, allowDowngrade: previous === null && !Object.values(quotaStates(store)).some((q) => q.status === "exhausted") }) : null);
      if (previous && origin.model === "explicit" && previous.model.requested) execReq.model = previous.model.requested;
      if (chosen) execReq.model = chosen.model;
      execReq.model ??= cfg.executors[task.executor].model ?? undefined;
      if (!execReq.model && task.executor === "codex") {
        try { execReq.model = codexConfiguredModel(authPaths, env) ?? undefined; }
        catch { /* padrão ilegível continua desconhecido; piso deep bloqueia abaixo */ }
      }
      const info: ModelInfo | null = execReq.model && catalog ? findModel(catalog, task.executor, execReq.model) : null;
      const actualTier: Tier = info ? tierOf(info, cfg).tier : execReq.model ? tierOf({ id: execReq.model, aliases: [], displayName: execReq.model }, cfg).tier : target;
      const explicitEffort = originalReq.effort && effortRank(originalReq.effort) >= effortRank(minimumEffort) ? originalReq.effort : null;
      const effort: DelegationRequest["effort"] | null = quotaChoice?.effort ?? explicitEffort ?? (info ? selectEffort(actualTier, info, { escalateToMax, minimum: minimumEffort }) : null);
      if (effort) execReq.effort = effort;
      task.model.requested = execReq.model ?? cfg.executors[task.executor].model ?? null;
      task.effort = { requested: execReq.effort ?? null };
      task.selection = { adaptive: true, tier: actualTier, complexitySignals: assessment.signals, model: task.model.requested, effort: task.effort.requested,
        reason: [...(quotaChoice ? ["fallback de cota: modelo equivalente selecionado", ...quotaChoice.reason] : originalReq.model ? ["model explícito preservado"] : chosen?.reason ?? ["catálogo/candidato indisponível: sem seleção automática de modelo ou esforço"]), ...(originalReq.effort ? ["effort explícito preservado"] : [])],
        attempt: previous ? chainAttempt() + 1 : task.selection?.attempt ?? 1, attemptOf: task.taskId === rootId ? null : rootId, chainRoot: rootId, origin,
        ...(fallbacks?.length ? { fallbacks } : {}),
        ...(previous && !quotaChoice ? { escalatedFrom: { model: previous.model.requested, effort: previous.effort?.requested ?? null, reason: previous.outcome ?? "verificação reprovou" } } : {}) };
      const pc = catalog?.providers[task.executor];
      if (!originalReq.model && !chosen && pc?.ok && !pc.stale && pc.models.length && scope.ok) {
        blockTask(task, "nenhum modelo automático elegível no nível-alvo ou acima; confira include/exclude, capacidade e uso extra");
        store.saveTask(task);
        return { exitCode: EXIT.blocked, summary: summarize(task) };
      }
      quotaChoice = null;
    }
    if (adaptive) {
      const model: string | null = task.model.requested;
      const info: ModelInfo | null = model && catalog ? findModel(catalog, task.executor, model) : null;
      const level: ReturnType<typeof tierOf> | null = model ? tierOf(info ?? { id: model, aliases: [], displayName: model }, cfg) : null;
      const belowEffort = assessment.floor === "deep" && origin.effort === "explicit" && effortRank(originalReq.effort) < effortRank("high");
      if (level && task.selection) task.selection.tier = level.tier;
      if ((level && tierRank(level.tier) < tierRank(assessment.floor)) || (assessment.floor === "deep" && (!level || level.presumed)) || belowEffort) {
        const candidates = evaluateCandidates(store, cfg, { kind: req.kind, tags, risk: req.risk ?? "medium", brain: req.brain, needs: req.needs, complexity: assessment.floor }, liveAvailability(store, cfg, env, authPaths), catalog).evals;
        const example = selectModel(catalog, cfg, task.executor, assessment.floor, { candidates, floor: assessment.floor, needs: req.needs, allowDowngrade: false })?.model;
        const reason = `risco/escopo exige nível ${assessment.floor}; ${model ?? "padrão da CLI desconhecido"} é ${level?.presumed ? "nível presumido (não confirmado)" : level?.tier ?? "nível desconhecido"}${belowEffort ? `; effort explícito ${originalReq.effort} abaixo de high` : ""}. Remova \`model\` para escolha automática ou peça um modelo de nível ${assessment.floor}${example ? ` (ex.: ${example})` : ""}${belowEffort ? " e effort high ou superior" : ""}`;
        task.selection?.reason.push(reason);
        blockTask(task, reason); store.saveTask(task);
        return { exitCode: EXIT.blocked, summary: summarize(task) };
      }
      if (effortRank(task.effort?.requested) < effortRank(minimumEffort)) {
        const reason = `nenhum esforço compatível com o mínimo ${minimumEffort} alcançado na cadeia; sem reduzir raciocínio`;
        task.selection?.reason.push(reason); blockTask(task, reason); store.saveTask(task);
        return { exitCode: EXIT.blocked, summary: summarize(task) };
      }
      if (effortRank(task.effort?.requested) > effortRank(minimumEffort)) minimumEffort = task.effort?.requested as Effort;
    }
    if (req.brain === task.executor && (!task.model.requested || !adaptive && !originalReq.model)) {
      blockTask(task, "delegar ao mesmo cliente exige model explícito ou seleção automática de outro modelo; faça você mesmo");
      store.saveTask(task);
      return { exitCode: EXIT.blocked, summary: summarize(task) };
    }
    if (adaptive && req.brain === task.executor && req.brainModel && task.model.requested && modelMatches(task.model.requested, catalog ? findModel(catalog, task.executor, req.brainModel)?.id ?? req.brainModel : req.brainModel)) {
      blockTask(task, "o modelo selecionado é o próprio cérebro; faça no cérebro");
      store.saveTask(task);
      return { exitCode: EXIT.blocked, summary: summarize(task) };
    }
    const quotaReason = quotaBlock(quotaStates(store)[task.executor], task.model.requested);
    if (quotaReason) {
      blockTask(task, `${task.executor}: ${quotaReason}; retome após o reset`);
      store.saveTask(task);
      return { exitCode: EXIT.blocked, summary: summarize(task) };
    }
    const gate = runGates(execReq, task, run, cfg, projectRoot, env, authPaths, catalog);
    if (!gate.ok) {
      blockTask(task, gate.reason);
      store.saveTask(task);
      store.telemetry({ event: "task_blocked", runId: run.runId, taskId: task.taskId, executor: task.executor, reason: gate.reason });
      return { exitCode: EXIT.blocked, summary: summarize(task) };
    }
    const { resolved, caps, entries } = gate.gates;
    task.tags = deriveTags(projectRoot, entries, adaptive);
    const execCatalog = catalog?.providers[task.executor];
    if (execCatalog?.stale && (task.model.requested || task.needs.includes("image_generation"))) {
      const note = `catálogo do ${task.executor} desatualizado (de ${execCatalog.staleSince}): modelo/capacidade não confirmados antes da execução`;
      if (!task.limitations.includes(note)) task.limitations.push(note);
    }
    transition(task, "approved", resuming ? "retomada aprovada após nova verificação" : "validação, política e autenticação aprovadas");
    store.saveTask(task);
    const lock = new ExecutorLock(projectRoot);
    const acquired = lock.acquire(task.taskId, run.runId);
    if (!acquired.ok) {
      blockTask(task, `outro executor está ativo neste projeto (${acquired.holder?.taskId ?? "?"}, pid ${acquired.holder?.pid ?? "?"}); o MVP permite um executor por vez`);
      store.saveTask(task);
      return { exitCode: EXIT.blocked, summary: summarize(task) };
    }
    let out: DelegateOutcome;
    try {
      const timeoutSec = opts.timeoutSecOverride ?? req.limits?.timeoutSec ?? cfg.limits.timeoutSec;
      const codexHome = env.CODEX_HOME ?? join(authPaths.home, ".codex");
      out = await execute({ req: execReq, task, run, cfg, store, projectRoot, env, lock, resolved, caps, entries, resuming, adaptive, timeoutSec, codexHome, ...(opts.signal ? { signal: opts.signal } : {}) });
    } finally { lock.release(); }
    if (!adaptive || (!out.verificationFailed && !out.quotaExceeded) || opts.signal?.aborted || store.loadRun(run.runId)?.cancelled) return out;
    if (chainAttempt() >= cfg.routing.adaptive.maxAttempts) {
      task.limitations.push(`sem nova tentativa: routing.adaptive.maxAttempts=${cfg.routing.adaptive.maxAttempts}`);
      store.saveTask(task);
      return { exitCode: out.exitCode, summary: summarize(task) };
    }
    if (task.isolation === "in-place" && (task.verification?.filesChangedActual.length
      || (task.base && diffStates(projectRoot, baseState(task), entries.map((e) => e.rel)).changed.some((p) => !p.startsWith(".duo/"))))) {
      task.limitations.push(`${out.quotaExceeded ? "fallback de cota não aplicado" : "escalada não aplicada"}: a tentativa alterou arquivos in-place; decida no cérebro`);
      store.saveTask(task);
      return { exitCode: out.exitCode, summary: summarize(task) };
    }
    let retryExecutor = task.executor;
    if (out.quotaExceeded) {
      if (task.executor === "codex") catalog = await loadCatalog(store, cfg, { env }).catch(() => catalog);
      const exhausted = quotaStates(store)[task.executor];
      const currentTier = task.selection?.tier ?? target;
      const evals = evaluateCandidates(store, cfg, { kind: req.kind, tags, risk: req.risk ?? "medium", brain: req.brain, needs: req.needs, complexity: currentTier }, liveAvailability(store, cfg, env, authPaths), catalog).evals;
      const providers: Provider[] = exhausted?.affectedModels ? [task.executor, task.executor === "claude" ? "codex" : "claude"] : [task.executor === "claude" ? "codex" : "claude"];
      let next: { executor: Provider; selected: ModelSelection } | null = null;
      for (const executor of providers) {
        const selected = selectModel(catalog, cfg, executor, currentTier, { candidates: evals, floor: currentTier, needs: req.needs, minimumEffort, allowDowngrade: false });
        if (selected) { next = { executor, selected }; break; }
      }
      if (!next) {
        task.outcome = `limite/cota do ${task.executor} esgotada até ${exhausted?.resetsAt ?? "reset desconhecido"}; nenhum modelo equivalente de nível ${currentTier} ou superior${minimumEffort ? ` com esforço >= ${minimumEffort}` : ""} estava disponível. Retome com duo delegate --resume ${task.taskId}.`;
        store.saveTask(task);
        return { exitCode: EXIT.blocked, summary: summarize(task) };
      }
      const from = { executor: task.executor, model: task.model.requested };
      fallbacks = [...(fallbacks ?? []), { from, to: { executor: next.executor, model: next.selected.model }, reason: "cota esgotada", resetsAt: exhausted?.resetsAt ?? null }];
      retryExecutor = next.executor;
      quotaChoice = next.selected;
      target = currentTier;
      escalateToMax = false;
    } else {
      const pc = catalog?.providers[task.executor];
      if (!pc?.ok || pc.stale) {
        task.limitations.push("escalada não aplicada: catálogo indisponível para confirmar o próximo modelo/esforço");
        store.saveTask(task);
        return { exitCode: out.exitCode, summary: summarize(task) };
      }
      const currentTier: Tier = task.selection?.tier ?? target;
      const nextTier: Tier | undefined = TIERS[tierRank(currentTier) + 1];
      target = nextTier ?? "deep";
      escalateToMax = !nextTier;
      // Fixações explícitas nunca são substituídas; só repetir se há um aumento real disponível.
      if (origin.model === "explicit" || escalateToMax) {
        const info: ModelInfo | null = task.model.requested && catalog ? findModel(catalog, task.executor, task.model.requested) : null;
        const nextEffort: DelegationRequest["effort"] | null = originalReq.effort ?? (info ? selectEffort("deep", info, { escalateToMax: true, minimum: minimumEffort }) : null);
        if (!nextEffort || effortRank(nextEffort) <= effortRank(task.effort?.requested)) return out;
        escalateToMax = true;
      }
    }
    previous = task;
    task = newTask(originalReq, run, store, cfg);
    task.executor = retryExecutor;
    task.requestHash = (store.findTask(rootId) ?? previous).requestHash;
    run.taskIds.push(task.taskId);
    store.saveRun(run);
    mkdirSync(task.artifactsDir, { recursive: true });
    writeJsonAtomic(join(task.artifactsDir, "request.json"), redactDeep(originalReq));
    store.saveTask(task);
    resuming = false;
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
  adaptive: boolean;
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
    blockTask(task, reason);
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
  const { env: execEnv } = childEnv(env, { DUO_DEPTH: "1", DUO_TASK_ID: task.taskId, DUO_RUN_ID: run.runId, DUO_ATTEMPT: String(task.selection?.attempt ?? 1) });
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
    effort: req.effort,
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
  const redactStdout = createStreamRedactor();
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
          const safe = sanitizeEventLine(task.executor, line, redactStdout);
          loggedBytes += safe.length + 1;
          appendFileSync(eventsPath, `${safe}\n`);
        }
      },
      onOversizeLine: () => {
        // A linha descartada não passou pelo redator, que pode ter perdido o início de um bloco PEM: falha fechado e para o log.
        if (loggedBytes < MAX_EVENT_LOG_BYTES) {
          appendFileSync(eventsPath, `${JSON.stringify({ redacted: "oversize-line", note: "linha acima do limite descartada; log de eventos interrompido" })}\n`);
        }
        loggedBytes = MAX_EVENT_LOG_BYTES;
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

  if (task.executor === "codex" && outcome.errorKind === "quota") {
    // Atualiza o escopo do limite após esgotar; a consulta opcional usa apenas o app-server do catálogo.
    await loadCatalog(store, cfg, { refresh: true, env }).catch(() => null);
  }
  observeTaskQuota(store, task.executor, outcome, task.model.requested);
  const [state, reason, verificationFailed] = decide(task, result, outcome, verification, violations, cancelledExternally, ctx.adaptive);
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
  const fallbackNote = state === "succeeded" && task.selection?.fallbacks?.length
    ? `; executado por ${task.executor}/${task.model.requested} após cota esgotada em ${task.selection.fallbacks.map((f) => `${f.from.executor}/${f.from.model}`).join(", ")}` : "";
  const quotaNote = outcome.errorKind === "quota" ? ` ${task.executor}: ${quotaBlock(quotaStates(store)[task.executor], task.model.requested) ?? "cota esgotada"}.` : "";
  transition(task, state, reason + quotaNote + fallbackNote);
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
  return { exitCode: exitFor(state), summary: summarize(task), ...(verificationFailed ? { verificationFailed: true } : {}),
    ...(state === "blocked" && outcome.errorKind === "quota" && !verification.staleBase ? { quotaExceeded: true } : {}) };
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
  adaptive: boolean,
): [TaskState, string, boolean?] {
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
    return ["blocked", `limite/cota do ${task.executor} atingido (${o.errorMessage ?? "sem detalhe"}). ${adaptive ? "A ponte procura um modelo equivalente disponível." : "Sem nova tentativa automática: aguarde o reset, execute no próprio cérebro ou prepare um handoff."}${partial}`];
  }
  if (o.errorKind === "auth") return ["blocked", `falha de autenticação no ${task.executor}: ${o.errorMessage ?? ""}. Nenhum método alternativo de cobrança foi tentado.`];
  if (o.errorKind === "model_unavailable") {
    const hint = /or newer is required|version_too_old/i.test(o.errorMessage ?? "") ? ` Atualize a CLI (${task.executor === "claude" ? "claude update" : "npm install -g @openai/codex"}) ou ajuste executors.${task.executor}.model.` : "";
    return ["failed", `modelo indisponível no ${task.executor} (${task.model.requested ?? "padrão"}): ${o.errorMessage ?? ""}${hint}`];
  }
  if (o.errorKind) return ["failed", `${o.errorKind}: ${o.errorMessage ?? ""}${o.reportErrors.length ? ` [${o.reportErrors.slice(0, 5).join("; ")}]` : ""}${partial}`];
  const rep = o.report;
  if (!rep) return ["failed", "sem relatório estruturado"];
  if (adaptive && v.staleBase) return ["failed", "o estado base mudou durante a execução (HEAD ou arquivos do escopo); resultado não integrado"];
  if ((rep.status === "blocked" || rep.status === "partial") && adaptive
    && /incapaz|incapacidade|capacidade|n[aã]o consigo|unable|cannot|complexidade|complexity/i.test(rep.blockedReason ?? rep.summary)
    && !/escopo|scope|decis[aã]o|decision|auth|quota|cota|timeout|permission|permiss[aã]o/i.test(rep.blockedReason ?? rep.summary)) {
    return ["failed", `executor reportou ${rep.status} por incapacidade: ${rep.blockedReason ?? rep.summary}`.slice(0, 600), true];
  }
  if (rep.status === "blocked" || rep.status === "partial") return ["blocked", `executor reportou ${rep.status}: ${rep.blockedReason ?? rep.summary}`.slice(0, 600)];
  if (rep.status === "failed") return ["failed", `executor reportou falha: ${rep.summary}`.slice(0, 600)];
  if (v.staleBase) return ["failed", "o estado base mudou durante a execução (HEAD ou arquivos do escopo); resultado não integrado"];
  if (task.needs.includes("image_generation") && !(v.images ?? []).length) {
    return ["failed", "nenhuma imagem válida (PNG/JPEG/WebP/GIF) foi gravada no escopo autorizado, apesar do relatório \"completed\""];
  }
  const failedAcceptance = v.acceptance.filter((a: AcceptanceResult) => !a.passed);
  if (adaptive && v.claimsMismatch.length) return ["failed", `overclaim: ${v.claimsMismatch.join("; ")}`, true];
  if (failedAcceptance.length) {
    return ["failed", `critério de aceite falhou apesar do relatório "completed": ${failedAcceptance.map((a) => `${a.name} (exit ${a.exitCode ?? a.skippedReason ?? "?"})`).join(", ")}`, failedAcceptance.every((a) => a.ran && a.exitCode !== null && !a.outputTail.endsWith("\n[timeout]"))];
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
    ...(task.effort ? { effort: task.effort } : {}),
    ...(task.selection ? { selection: task.selection } : {}),
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
