#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, loadConfig, type Provider } from "../config.js";
import { repoRoot } from "../git.js";
import { acceptTask, applyTask, cancelRun, refreshInterrupted } from "../orchestration/control.js";
import { delegate, EXIT } from "../orchestration/delegate.js";
import { writeHandoff } from "../orchestration/handoff.js";
import { formatCatalog, loadCatalog, type Capability } from "../adapters/catalog.js";
import { deriveTags, formatRecommendation, liveAvailability, recommend, type Risk } from "../orchestration/router.js";
import { validateScope } from "../permissions/scope.js";
import { codexConfiguredModel, defaultAuthPaths } from "../permissions/auth.js";
import { readEffectiveCodexConfig } from "../permissions/codex-effective-config.js";
import { resolveExecutable } from "../adapters/resolve.js";
import { loadSchema, validate } from "../schema.js";
import type { DelegationRequest, TaskKind } from "../state/types.js";
import { packageRoot } from "../paths.js";
import { Store } from "../state/store.js";
import { buildReport, formatReportText, quotaView, setQuota } from "../telemetry/report.js";
import { loadCliLatest, cliUpdateWarnings } from "../adapters/cli-latest.js";
import { tierOf, extraUsage } from "../adapters/tiers.js";
import { doctor, formatDoctor } from "./doctor.js";
import { applyInit, planInit, previewDiff } from "./init.js";
import { spawnSync } from "node:child_process";
import { acquireUpdateCheck, checkForUpdatesInBackground, compareVersions, currentVersion, installerEnv, refreshUpdateCache, releaseUpdateCheck, updateCheckDisabled, UPDATE_REPO } from "../update.js";

const HELP = `duo — ClaudeGPT - Duo Orchestrator by Fusic: ponte local entre Codex e Claude Code (CLIs oficiais, assinatura individual)

Uso:
  duo doctor [--json]                         diagnóstico sem inferência
  duo init [--brain claude|codex] [--apply] [--overwrite]
                                              gera config e skills do projeto (preview por padrão)
  duo delegate --request <arquivo.json> [--no-adaptive] executa um pedido do cérebro
  duo delegate --resume <taskId> [--timeout-sec N]
                                              retoma uma task bloqueada/interrompida (opcionalmente com mais tempo)
  duo models [--refresh] [--json]             modelos disponíveis nas contas conectadas (sem inferência)
  duo recommend --kind implement|review|test|investigate|asset [--needs image_generation] [--paths a,b]
                [--risk low|medium|high] [--brain claude|codex] [--brain-model <id>] [--json]
                                              melhor modelo disponível para a subtarefa (evidência, sem preferência de marca)
  duo status [--run-id <id>] [--json]
  duo report [--run-id <id>] [--json]         métricas determinísticas
  duo cancel --run-id <id>
  duo apply --task-id <id>                    integra patch de task em worktree
  duo accept --task-id <id> [--reject] [--note <texto>]
  duo handoff --to claude|codex [--run-id <id>] [--next <texto>]
  duo quota refresh
  duo quota show
  duo quota set --provider claude|codex [--used-percent N] [--resets-at ISO8601] [--note <texto>]
  duo update [--apply]                        procura nova versão (release pública, sem credenciais); --apply instala

Aviso automático de nova versão: no máximo 1 consulta por dia, em segundo plano. Desligar: DUO_NO_UPDATE_CHECK=1.

Códigos de saída de delegate: 0 succeeded, 1 failed, 2 pedido inválido, 3 blocked, 4 cancelled.`;

type Args = { _: string[]; flags: Record<string, string | true> };

const BOOLEAN_FLAGS = new Set(["json", "apply", "overwrite", "reject", "help", "version", "refresh", "check", "quiet", "no-adaptive"]);

/** Opções aceitas por comando: uma opção desconhecida é erro (evita flags ignoradas em silêncio). */
const COMMAND_FLAGS: Record<string, string[]> = {
  doctor: [],
  init: ["brain", "apply", "overwrite"],
  delegate: ["request", "resume", "timeout-sec", "no-adaptive"],
  models: ["refresh"],
  recommend: ["kind", "needs", "paths", "risk", "brain", "brain-model", "request"],
  status: ["run-id"],
  report: ["run-id"],
  cancel: ["run-id"],
  apply: ["task-id"],
  accept: ["task-id", "reject", "note"],
  handoff: ["to", "run-id", "next"],
  quota: ["provider", "used-percent", "resets-at", "note"],
  update: ["apply", "check", "quiet"],
};
const GLOBAL_FLAGS = ["json", "help", "version"];

export function unknownFlags(cmd: string, flags: Record<string, string | true>): string[] {
  const allowed = COMMAND_FLAGS[cmd];
  if (!allowed) return [];
  return Object.keys(flags).filter((k) => !allowed.includes(k) && !GLOBAL_FLAGS.includes(k));
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) out.flags[k] = inline;
      else if (BOOLEAN_FLAGS.has(k)) out.flags[k] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) throw new Error(`--${k} requer um valor`);
        out.flags[k] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function str(args: Args, k: string): string | undefined {
  const v = args.flags[k];
  return typeof v === "string" ? v : undefined;
}

function provider(v: string | undefined, flag: string): Provider {
  if (v !== "claude" && v !== "codex") throw new Error(`${flag} deve ser claude ou codex`);
  return v;
}

function projectRootOf(cwd: string): string {
  return repoRoot(cwd) ?? cwd;
}

function print(obj: unknown): void {
  process.stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const cwd = process.cwd();
  if (args.flags.version) {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
    print(pkg.version);
    return 0;
  }
  if (!cmd || args.flags.help || cmd === "help") {
    print(HELP);
    return cmd ? 0 : 2;
  }

  const unknown = unknownFlags(cmd, args.flags);
  if (unknown.length) {
    const accepted = [...(COMMAND_FLAGS[cmd] ?? []), ...GLOBAL_FLAGS].map((f) => `--${f}`).join(", ");
    throw new Error(`opção desconhecida para duo ${cmd}: ${unknown.map((f) => `--${f}`).join(", ")} (aceitas: ${accepted})`);
  }

  if (cmd !== "update") checkForUpdatesInBackground();

  switch (cmd) {
    case "update": {
      const quiet = Boolean(args.flags.quiet);
      if (quiet && process.env.DUO_UPDATE_WORKER !== "1" && updateCheckDisabled()) return 0;
      // O trabalhador em segundo plano já recebe a reserva de quem o disparou; a consulta explícita espera por ela.
      // Sem a reserva, consulta mesmo assim, mas não grava o cache (outro processo está gravando).
      const held = process.env.DUO_UPDATE_WORKER === "1" || (await acquireUpdateCheck());
      let cache;
      try {
        cache = await refreshUpdateCache(process.env, undefined, Date.now(), held);
      } finally {
        if (held) releaseUpdateCheck();
      }
      if (quiet) return 0;
      const current = currentVersion();
      const latest = cache.latest;
      if (args.flags.json) {
        print({ current, latest: latest?.version ?? null, updateAvailable: Boolean(latest && compareVersions(latest.version, current) > 0), checked: cache.ok });
        return 0;
      }
      if (!cache.ok && !latest) throw new Error(`não foi possível consultar as releases de ${UPDATE_REPO} (sem rede?)`);
      if (!latest || compareVersions(latest.version, current) <= 0) {
        print(`duo ${current} está atualizado${cache.ok ? "" : " (consulta falhou; usando o último resultado conhecido)"}.`);
        return 0;
      }
      // --ignore-scripts: o pacote não tem scripts de instalação; nada de terceiros roda na instalação.
      const install = ["install", "-g", "--ignore-scripts", latest.tarballUrl];
      if (!args.flags.apply || process.platform === "win32") {
        print(`Nova versão ${latest.version} (instalada: ${current}). Novidades: ${latest.pageUrl}\nPara instalar: duo update --apply\n  (equivale a: npm ${install.join(" ")})`);
        return 0;
      }
      print(`Instalando duo ${latest.version} a partir de ${latest.tarballUrl} ...`);
      const r = spawnSync("npm", install, { stdio: "inherit", shell: false, env: installerEnv() });
      if (r.status !== 0) throw new Error(`npm install falhou (código ${r.status ?? r.error?.message}); tente: npm ${install.join(" ")}`);
      print(`duo atualizado para ${latest.version}.`);
      return 0;
    }
    case "doctor": {
      const r = await doctor(cwd);
      print(args.flags.json ? r : formatDoctor(r));
      return 0;
    }
    case "init": {
      const root = repoRoot(cwd);
      if (!root) {
        print("duo init requer um repositório Git (rode `git init` você mesmo se desejar).");
        return 2;
      }
      const brain = provider(str(args, "brain") ?? "claude", "--brain");
      const plan = planInit(root, brain);
      for (const f of plan) print(previewDiff(root, f));
      if (!args.flags.apply) {
        print("\nPreview apenas. Rode novamente com --apply para criar os arquivos (conflitos exigem --overwrite; backups vão para .duo/backups/).");
        return 0;
      }
      const res = applyInit(root, plan, Boolean(args.flags.overwrite));
      print({ written: res.written, skippedConflicts: res.skipped, backups: res.backups });
      print(
        "\nPróximos passos: revise .duo/config.json (acceptance.allowedCommands e billing.acknowledgeUnverifiableExtraUsage) e rode `duo doctor`.",
      );
      return 0;
    }
    case "delegate": {
      const controller = new AbortController();
      let signals = 0;
      const onSignal = () => {
        signals++;
        if (signals === 1) controller.abort();
        else process.exit(EXIT.cancelled);
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      const requestPath = str(args, "request");
      const resumeTaskId = str(args, "resume");
      const timeoutRaw = str(args, "timeout-sec");
      const out = await delegate({
        cwd,
        ...(requestPath ? { requestPath } : {}),
        ...(resumeTaskId ? { resumeTaskId } : {}),
        ...(timeoutRaw !== undefined ? { timeoutSecOverride: Number(timeoutRaw) } : {}),
        signal: controller.signal,
        ...(args.flags["no-adaptive"] ? { adaptive: false } : {}),
      });
      print(out.summary);
      return out.exitCode;
    }
    case "models": {
      const root = projectRootOf(cwd);
      const store = new Store(root), cfg = loadConfig(root);
      const [catalog, latest] = await Promise.all([loadCatalog(store, cfg, { refresh: Boolean(args.flags.refresh) }), loadCliLatest(store, cfg)]);
      const warnings = cliUpdateWarnings(catalog.cliVersions, latest);
      const view = {
        ...catalog, cliLatest: latest, warnings,
        providers: Object.fromEntries(Object.entries(catalog.providers).map(([p, pc]) => [p, {
          ...pc,
          models: pc.models.map((m) => ({ ...m, ...tierOf(m, cfg), extraUsage: extraUsage(m), source: m.source ?? "discovered" })),
        }])),
      };
      print(args.flags.json ? view : [formatCatalog(catalog, cfg), ...warnings].join("\n"));
      return catalog.providers.claude.ok || catalog.providers.codex.ok ? 0 : 1;
    }
    case "recommend": {
      const root = projectRootOf(cwd);
      const cfg = loadConfig(root);
      const requestPath = str(args, "request");
      let request: DelegationRequest | undefined;
      if (requestPath) {
        const parsed: unknown = JSON.parse(readFileSync(resolve(cwd, requestPath), "utf8"));
        const errors = validate(loadSchema("delegation-request"), parsed);
        if (errors.length) throw new Error(`pedido fora do schema: ${errors.join("; ")}`);
        request = parsed as DelegationRequest;
      }
      const kind = str(args, "kind") ?? request?.kind;
      if (!kind || !["implement", "review", "test", "investigate", "asset"].includes(kind)) throw new Error("--kind deve ser implement, review, test, investigate ou asset");
      const needs = (str(args, "needs") ?? request?.needs?.join(",") ?? "").split(",").map((x) => x.trim()).filter(Boolean) as Capability[];
      if (needs.some((n) => !["code", "image_generation"].includes(n))) throw new Error("--needs aceita: code, image_generation");
      const brainModel = str(args, "brain-model") ?? request?.brainModel ?? null;
      const risk = (str(args, "risk") ?? request?.risk ?? "medium") as Risk;
      if (!["low", "medium", "high"].includes(risk)) throw new Error("--risk deve ser low, medium ou high");
      const brainArg = str(args, "brain") ?? request?.brain;
      const brain = brainArg === undefined ? null : provider(brainArg, "--brain");
      const paths = (str(args, "paths") ?? request?.scope.allowedPaths.join(",") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      let tags: string[] = [];
      let scopeEntries: { rel: string; isDir: boolean }[] = [];
      if (paths.length) {
        const scope = validateScope(root, paths, cfg.scope.deny, { allowWholeProject: true });
        if (!scope.ok) throw new Error(`--paths inválido: ${scope.errors.join("; ")}`);
        tags = deriveTags(root, scope.entries, cfg.routing.adaptive.enabled && request?.adaptive !== false);
        scopeEntries = scope.entries;
      }
      const store = new Store(root);
      let catalog = null;
      try {
        catalog = await loadCatalog(store, cfg);
      } catch {
        catalog = null;
      }
      const effective = await readEffectiveCodexConfig({ cwd: root, env: process.env, ignoreUserConfig: cfg.executors.codex.ignoreUserConfig,
        resolved: resolveExecutable("codex", cfg.executors.codex.command, process.env) });
      const defaults = { claude: null, codex: codexConfiguredModel(defaultAuthPaths(root), process.env, cfg.executors.codex.ignoreUserConfig, effective) };
      const rec = recommend(store, request?.adaptive === false ? { ...cfg, routing: { ...cfg.routing, adaptive: { ...cfg.routing.adaptive, enabled: false } } } : cfg, { kind: kind as TaskKind, tags, risk, brain, brainModel, needs, paths: scopeEntries, ...(request ? { objective: request.objective, acceptance: request.acceptance, complexity: request.complexity } : {}) }, await liveAvailability(store, cfg), catalog, defaults);
      store.telemetry({ event: "recommend", query: rec.query, decision: rec.decision });
      print(args.flags.json ? rec : formatRecommendation(rec));
      return 0;
    }
    case "status": {
      const store = new Store(projectRootOf(cwd));
      const interrupted = refreshInterrupted(store);
      const runId = str(args, "run-id");
      const runs = store.listRuns().filter((r) => !runId || r.runId === runId);
      const data = runs.map((r) => ({
        runId: r.runId,
        brain: r.brain,
        policy: r.policy,
        cancelled: r.cancelled,
        invocations: r.invocations,
        nextStep: r.nextStep,
        tasks: store.listTasks(r).map((t) => ({ taskId: t.taskId, executor: t.executor, kind: t.kind, state: t.state, outcome: t.outcome, updatedAt: t.updatedAt, ...(t.selection ? { selection: t.selection } : {}) })),
      }));
      if (args.flags.json) print({ interrupted, runs: data });
      else {
        if (!data.length) print("nenhum run registrado neste projeto");
        for (const r of data) {
          print(`${r.runId} cérebro=${r.brain} política=${r.policy} invocações=${r.invocations}${r.cancelled ? " CANCELADO" : ""}`);
          for (const t of r.tasks) print(`  ${t.taskId} ${t.executor}/${t.kind} ${t.state}${t.outcome ? ` — ${t.outcome.slice(0, 160)}` : ""}${t.selection ? `\n    seleção: ${JSON.stringify(t.selection)}` : ""}`);
        }
        for (const i of interrupted) print(`interrupção detectada: ${i.taskId}${i.orphanChild ? ` (executor órfão pid ${i.orphanChild})` : ""}`);
      }
      return 0;
    }
    case "report": {
      const r = buildReport(new Store(projectRootOf(cwd)), str(args, "run-id"));
      print(args.flags.json ? r : formatReportText(r));
      return 0;
    }
    case "cancel": {
      const runId = str(args, "run-id");
      if (!runId) throw new Error("informe --run-id");
      const r = await cancelRun(projectRootOf(cwd), runId);
      print(r);
      return r.ok ? 0 : 1;
    }
    case "apply": {
      const taskId = str(args, "task-id");
      if (!taskId) throw new Error("informe --task-id");
      const r = applyTask(projectRootOf(cwd), taskId);
      print(r);
      return r.ok ? 0 : 1;
    }
    case "accept": {
      const taskId = str(args, "task-id");
      if (!taskId) throw new Error("informe --task-id");
      const r = acceptTask(projectRootOf(cwd), taskId, !args.flags.reject, str(args, "note") ?? "");
      print(r);
      return r.ok ? 0 : 1;
    }
    case "handoff": {
      const to = provider(str(args, "to"), "--to");
      const r = writeHandoff(projectRootOf(cwd), to, str(args, "run-id"), str(args, "next"));
      print(r.content);
      print(`handoff salvo em ${r.path}`);
      return 0;
    }
    case "quota": {
      const store = new Store(projectRootOf(cwd));
      if (args._[1] === "refresh") {
        await loadCatalog(store, loadConfig(store.projectRoot), { refresh: true });
        print(quotaView(store));
        return 0;
      }
      if (args._[1] === "set") {
        const p = provider(str(args, "provider"), "--provider");
        const pct = str(args, "used-percent");
        const used = pct === undefined ? null : Number(pct);
        if (used !== null && (!Number.isFinite(used) || used < 0 || used > 100)) throw new Error("--used-percent deve estar entre 0 e 100");
        const resets = str(args, "resets-at") ?? null;
        if (resets !== null && Number.isNaN(Date.parse(resets))) throw new Error("--resets-at deve ser uma data ISO 8601");
        print(setQuota(store, { provider: p, usedPercent: used, resetsAt: resets, note: str(args, "note") ?? "" }, loadConfig(store.projectRoot).routing.adaptive.quotaWarnPercent));
        return 0;
      }
      print(quotaView(store));
      return 0;
    }
    default:
      print(`comando desconhecido: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`erro: ${e instanceof ConfigError || e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  },
);
