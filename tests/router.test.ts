// Roteador por evidência: histórico sintético, sem invocar modelos.
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { Provider } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { outcomeOf, recommend, type AvailabilityFn } from "../src/orchestration/router.js";
import { Store } from "../src/state/store.js";
import type { Run, Task } from "../src/state/types.js";
import { makeSandbox, type Sandbox } from "./helpers.js";
import { adaptiveCatalog } from "./adaptive-catalog.js";

let sb: Sandbox | null = null;
afterEach(() => {
  sb?.cleanup();
  sb = null;
});

type Seed = { executor: Provider; model?: string | null; kind?: Task["kind"]; tags?: string[]; ok: boolean; overclaim?: boolean; rejected?: boolean; wallMs?: number; infra?: boolean };

let seq = 0;
function seed(store: Store, items: Seed[]): void {
  const runId = `run-seed-${String(++seq).padStart(6, "0")}`;
  const run: Run = { runId, brain: "claude", policy: "economico", createdAt: "2026-01-01T00:00:00Z", updatedAt: "", cancelled: false, invocations: items.length, taskIds: [], decisions: [], nextStep: null };
  items.forEach((it, i) => {
    const taskId = `task-seed-${seq}-${String(i).padStart(4, "0")}`;
    run.taskIds.push(taskId);
    const t = {
      taskId, runId, state: it.infra ? "blocked" : it.ok ? "succeeded" : "failed", history: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      brain: it.executor === "claude" ? "codex" : "claude", executor: it.executor, kind: it.kind ?? "implement", tags: it.tags ?? ["ts"], risk: "medium",
      model: { requested: it.model === undefined ? (it.executor === "claude" ? "claude-opus-5-5" : null) : it.model, reported: null, reportedSource: "unavailable" },
      executorReport: it.infra ? null : { status: it.ok || it.overclaim ? "completed" : "failed", summary: "", filesChanged: [], testsRun: [], limitations: [], blockedReason: null },
      verification: { acceptance: [{ name: "t", argv: ["x"], ran: true, passed: it.ok, exitCode: it.ok ? 0 : 1, durationMs: 1, outputTail: "" }] },
      metrics: { wallMs: it.wallMs ?? 30_000 }, outcome: it.infra ? "limite/cota do x atingido" : null,
      ...(it.rejected ? { accepted: { at: "", accepted: false, note: "ruim" } } : {}),
    } as unknown as Task;
    store.saveTask(t);
  });
  store.saveRun(run);
}

const allUp: AvailabilityFn = () => ({ available: true, reasons: [] });

describe("recomendação adaptativa", () => {
  it("prefere nível-alvo disponível em outra conta antes de subir", () => {
    sb = makeSandbox({ routing: { include: ["claude:claude-opus-5-5", "codex:gpt-6.1-sol"] } });
    const r = recommend(new Store(sb.root), loadConfig(sb.root), { kind: "implement", tags: [], risk: "medium", brain: null }, allUp, adaptiveCatalog);
    assert.equal(r.selection?.model, "gpt-6.1-sol"); assert.equal(r.selection?.tier, "standard");
  });
  it("sem paths/aceite o piso é standard; risco/tag sensível exige deep", () => {
    sb = makeSandbox(); const store = new Store(sb.root), cfg = loadConfig(sb.root);
    const q = { kind: "implement" as const, tags: ["ts"], risk: "low" as const, brain: null };
    const standard = recommend(store, cfg, q, allUp, adaptiveCatalog);
    assert.equal(standard.decision.tier, "standard"); assert.equal(standard.selection?.tier, "standard");
    for (const query of [{ ...q, risk: "high" as const }, { ...q, tags: ["auth"] }, { ...q, paths: [{ rel: "db/schema.sql", isDir: false }] }]) {
      assert.equal(recommend(store, cfg, query, allUp, adaptiveCatalog).decision.tier, "deep");
    }
  });
  it("melhor evidência entre fornecedores no nível; cérebro deep recomenda delegar light", () => {
    sb = makeSandbox(); const store = new Store(sb.root), cfg = loadConfig(sb.root);
    const q = { kind: "implement" as const, tags: ["ts"], risk: "low" as const, brain: "claude" as const, brainModel: "claude-opus-5-5", objective: "Adicionar constante", paths: [{ rel: "src/app.ts", isDir: false }], acceptance: { criteria: ["ok"], commands: [{ name: "ok", argv: ["node", "-e", "process.exit(0)"] }] } };
    seed(store, Array.from({ length: 4 }, () => ({ executor: "codex" as const, model: "gpt-6-luna", ok: true })));
    const r = recommend(store, cfg, q, allUp, adaptiveCatalog);
    assert.equal(r.decision.action, "delegate"); assert.equal(r.decision.model, "gpt-6-luna"); assert.equal(r.decision.effort, "low");
    seed(store, Array.from({ length: 9 }, () => ({ executor: "claude" as const, model: "claude-haiku-4-5-20251001", ok: true })));
    const selfProvider = recommend(store, cfg, q, allUp, adaptiveCatalog);
    assert.equal(selfProvider.decision.action, "delegate"); assert.equal(selfProvider.decision.model, "claude-haiku-4-5-20251001");
    assert.ok(selfProvider.decision.why.some((w) => w.includes("economiza a cota do seu modelo")));
  });
  it("redução só dentro dos pisos; extra não ganha por evidência sem ack+include", () => {
    sb = makeSandbox(); const store = new Store(sb.root), cfg = loadConfig(sb.root);
    seed(store, Array.from({ length: 12 }, () => ({ executor: "codex" as const, model: "gpt-6-luna", ok: true })));
    const q = { kind: "implement" as const, tags: ["ts"], risk: "low" as const, brain: null, objective: "Adicionar constante", complexity: "standard" as const, paths: [{ rel: "src/app.ts", isDir: false }], acceptance: { criteria: ["ok"], commands: [{ name: "ok", argv: ["node", "-e", "process.exit(0)"] }] } };
    assert.equal(recommend(store, cfg, q, allUp, adaptiveCatalog).selection?.tier, "light");
    assert.notEqual(recommend(store, cfg, { ...q, acceptance: { criteria: ["ok"] } }, allUp, adaptiveCatalog).selection?.tier, "light");
    seed(store, Array.from({ length: 15 }, () => ({ executor: "claude" as const, model: "claude-fable-5-1[1m]", ok: true })));
    const high = recommend(store, cfg, { ...q, risk: "high" }, allUp, adaptiveCatalog);
    assert.notEqual(high.selection?.model, "claude-fable-5-1[1m]");
  });
});

describe("roteador por evidência", () => {
  it("sem histórico: decide por julgamento e sugere exploração em baixo risco", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "low", brain: "claude" }, allUp);
    assert.equal(r.decision.action, "judgment");
    assert.equal(r.decision.confidence, "baixa");
    assert.match(r.explore ?? "", /baixo risco/);
  });

  it("Codex com histórico melhor e cérebro Claude → delegar ao Codex (sem clubismo)", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    seed(store, [
      ...Array.from({ length: 4 }, () => ({ executor: "codex" as const, ok: true })),
      ...Array.from({ length: 4 }, (_, i) => ({ executor: "claude" as const, ok: i === 0 })),
    ]);
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "claude" }, allUp);
    assert.equal(r.decision.action, "delegate");
    assert.equal(r.decision.executor, "codex");
  });

  it("melhor histórico é do próprio cliente do cérebro → fazer você mesmo", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    seed(store, [
      ...Array.from({ length: 4 }, () => ({ executor: "claude" as const, ok: true })),
      ...Array.from({ length: 4 }, () => ({ executor: "codex" as const, ok: false })),
    ]);
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "claude" }, allUp);
    assert.equal(r.decision.action, "self");
    assert.equal(r.decision.executor, "claude");
    const r2 = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "codex" }, allUp);
    assert.equal(r2.decision.action, "delegate");
    assert.equal(r2.decision.executor, "claude");
    assert.equal(r2.decision.model, "claude-opus-5-5");
  });

  it("declarar sucesso e reprovar na verificação pesa contra; rejeição do cérebro conta como falha", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    seed(store, [
      ...Array.from({ length: 3 }, () => ({ executor: "codex" as const, ok: false, overclaim: true })),
      { executor: "claude", ok: true, rejected: true },
    ]);
    const tasks = store.listRuns().flatMap((r) => store.listTasks(r));
    assert.equal(outcomeOf(tasks.find((t) => t.executor === "claude") as Task), "failure");
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: null }, allUp);
    const codex = r.candidates.find((c) => c.executor === "codex");
    assert.ok(codex && codex.score < 0.2);
    assert.ok(codex?.reasons.some((x) => x.includes("declarou sucesso")));
  });

  it("falhas de infraestrutura (cota/login) não contam contra o modelo", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    seed(store, Array.from({ length: 5 }, () => ({ executor: "codex" as const, ok: false, infra: true })));
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "claude" }, allUp);
    assert.equal(r.candidates.find((c) => c.executor === "codex")?.evidence.n, 0);
  });

  it("usa o bucket mais específico com amostra suficiente e recua quando falta", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    seed(store, [
      ...Array.from({ length: 3 }, () => ({ executor: "codex" as const, ok: true, tags: ["py"] })),
      ...Array.from({ length: 3 }, () => ({ executor: "codex" as const, ok: false, tags: ["ts"] })),
    ]);
    const cfg = loadConfig(sb.root);
    const py = recommend(store, cfg, { kind: "implement", tags: ["py"], risk: "medium", brain: null }, allUp).candidates.find((c) => c.executor === "codex");
    assert.match(py?.evidence.bucket ?? "", /tags=py/);
    assert.equal(py?.evidence.successes, 3);
    const css = recommend(store, cfg, { kind: "implement", tags: ["css"], risk: "medium", brain: null }, allUp).candidates.find((c) => c.executor === "codex");
    assert.equal(css?.evidence.bucket, "kind=implement");
    assert.equal(css?.evidence.n, 6);
  });

  it("modelos diferentes do mesmo cliente são candidatos distintos", () => {
    sb = makeSandbox({ routing: { candidates: [{ executor: "claude", model: "claude-opus-5-5" }, { executor: "claude", model: "sonnet" }] } });
    const store = new Store(sb.root);
    seed(store, [
      ...Array.from({ length: 3 }, () => ({ executor: "claude" as const, model: "sonnet", ok: false })),
      ...Array.from({ length: 3 }, () => ({ executor: "claude" as const, model: "claude-opus-5-5", ok: true })),
    ]);
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "codex" }, allUp);
    assert.equal(r.decision.action, "delegate");
    assert.equal(r.decision.model, "claude-opus-5-5");
  });

  it("empate técnico desempata pelo menor tempo mediano (eficiência)", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    seed(store, [
      ...Array.from({ length: 3 }, () => ({ executor: "claude" as const, ok: true, wallMs: 90_000 })),
      ...Array.from({ length: 3 }, () => ({ executor: "codex" as const, ok: true, wallMs: 20_000 })),
    ]);
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: null }, allUp);
    assert.equal(r.candidates[0]?.executor, "codex");
  });

  it("candidato indisponível não é recomendado; sem nenhum disponível, o cérebro faz", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    seed(store, Array.from({ length: 4 }, () => ({ executor: "codex" as const, ok: true })));
    const codexDown: AvailabilityFn = (e) => (e === "codex" ? { available: false, reasons: ["não autenticado"] } : { available: true, reasons: [] });
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "claude" }, codexDown);
    assert.notEqual(r.decision.executor, "codex");
    const none = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "claude" }, () => ({ available: false, reasons: ["x"] }));
    assert.equal(none.decision.action, "self");
  });

  it("preferência declarada entra como bônus limitado e identificado", () => {
    sb = makeSandbox({ routing: { priors: [{ executor: "codex", kind: "implement", bonus: 0.15, note: "gosto do Codex para scripts" }] } });
    const store = new Store(sb.root);
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: [], risk: "medium", brain: null }, allUp);
    const codex = r.candidates.find((c) => c.executor === "codex");
    assert.equal(codex?.prior.bonus, 0.15);
    assert.ok(codex?.reasons.some((x) => x.includes("preferência declarada")));
  });
});

describe("disponibilidade dentro do sandbox do Codex", () => {
  it("login ilegível no sandbox não vira indisponibilidade", async () => {
    const { liveAvailability } = await import("../src/orchestration/router.js");
    sb = makeSandbox();
    const store = new Store(sb.root);
    const cfg = loadConfig(sb.root);
    const inSandbox = liveAvailability(store, cfg, { ...sb.env, FAKE_AUTH: "none", CODEX_SANDBOX: "seatbelt" }, sb.authPaths)("claude");
    assert.equal(inSandbox.available, true);
    assert.ok(inSandbox.reasons.some((r) => r.includes("sandbox")));
    const outside = liveAvailability(store, cfg, { ...sb.env, FAKE_AUTH: "none" }, sb.authPaths)("claude");
    assert.equal(outside.available, false);
    const apiKey = liveAvailability(store, cfg, { ...sb.env, FAKE_AUTH: "api_key", CODEX_SANDBOX: "seatbelt" }, sb.authPaths)("claude");
    assert.equal(apiKey.available, false);
  });
});

describe("catálogo das contas no roteador", async () => {
  const { parseClaudeInitialize, parseCodexModels, parseCodexFeatures } = await import("../src/adapters/catalog.js");
  const claudeModels = parseClaudeInitialize({
    account: { email: "x@y.z" },
    models: [
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Most efficient" },
      { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Older model" },
    ],
  });
  const tools = parseCodexFeatures("apps  stable  true\nimage_generation   stable   true\n");
  const codexModels = parseCodexModels(
    { models: [
      { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier intelligence", priority: 1, visibility: "list" },
      { slug: "gpt-6-sol", display_name: "GPT-6-Sol", description: "Workhorse", priority: 2, visibility: "list" },
      { slug: "gpt-5.5", display_name: "GPT-5.5", description: "Legacy coding model.", priority: 12, visibility: "list" },
      { slug: "codex-auto-review", display_name: "Auto Review", description: "x", priority: 43, visibility: "hide" },
    ] },
    tools,
  );
  const catalog = {
    discoveredAt: new Date().toISOString(),
    cliVersions: { claude: null, codex: null },
    providers: {
      claude: { ok: true, source: "t", tools: [], models: claudeModels },
      codex: { ok: true, source: "t", tools, models: codexModels },
    },
  };

  it("interpreta os catálogos: alias, recomendado, legado, ocultos e ferramenta de imagem", () => {
    assert.deepEqual(claudeModels.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5", "claude-opus-4-6"]);
    assert.deepEqual(claudeModels[0]?.aliases, ["opus"]);
    assert.equal(claudeModels[0]?.vendorRecommended, true);
    assert.equal(claudeModels[2]?.legacy, true);
    assert.ok(!JSON.stringify(claudeModels).includes("x@y.z"));
    assert.deepEqual(codexModels.map((m) => m.id), ["gpt-6-astra", "gpt-6-sol", "gpt-5.5"]);
    assert.equal(codexModels[0]?.vendorRecommended, true);
    assert.equal(codexModels[2]?.legacy, true);
    assert.ok(codexModels.every((m) => m.capabilities.includes("image_generation")));
    assert.deepEqual(parseCodexFeatures("image_generation  stable  false\n"), []);
  });

  it("arte: só modelos com geração de imagem concorrem; cérebro Claude delega ao gpt-6-astra", () => {
    sb = makeSandbox();
    const r = recommend(new Store(sb.root), loadConfig(sb.root), { kind: "asset", tags: ["png"], risk: "low", brain: "claude", brainModel: "claude-opus-5-5", needs: ["image_generation"] }, allUp, catalog);
    assert.ok(r.candidates.every((c) => c.executor === "codex"));
    assert.equal(r.decision.action, "delegate");
    assert.equal(r.decision.executor, "codex");
    assert.equal(r.decision.model, "gpt-6-astra");
    assert.ok(r.notes.some((n) => n.includes("sem image_generation")));
  });

  it("arte com cérebro Codex: se ele já é o gpt-6-astra faz sozinho; se é outro modelo, delega ao gpt-6-astra", () => {
    sb = makeSandbox();
    const cfg = loadConfig(sb.root);
    const q = { kind: "asset" as const, tags: [], risk: "low" as const, brain: "codex" as const, needs: ["image_generation" as const] };
    const self = recommend(new Store(sb.root), cfg, { ...q, brainModel: "gpt-6-astra" }, allUp, catalog);
    assert.equal(self.decision.action, "self");
    const other = recommend(new Store(sb.root), cfg, { ...q, brainModel: "gpt-6-sol" }, allUp, catalog);
    assert.equal(other.decision.action, "delegate");
    assert.equal(other.decision.executor, "codex");
    assert.equal(other.decision.model, "gpt-6-astra");
  });

  it("código sem histórico: julgamento mostrando o melhor de cada conta", () => {
    sb = makeSandbox();
    const r = recommend(new Store(sb.root), loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "codex" }, allUp, catalog);
    assert.equal(r.decision.action, "judgment");
    assert.ok(r.decision.why.some((w) => w.includes("claude/claude-sonnet-5") && w.includes("codex/gpt-6-sol")));
  });

  it("evidência por modelo decide entre modelos do mesmo fornecedor; tarefas sem model contam para o padrão", () => {
    sb = makeSandbox();
    const store = new Store(sb.root);
    seed(store, [
      ...Array.from({ length: 3 }, () => ({ executor: "codex" as const, model: null, ok: true })),
      ...Array.from({ length: 3 }, () => ({ executor: "codex" as const, model: "gpt-6-sol", ok: false })),
    ]);
    const r = recommend(store, loadConfig(sb.root), { kind: "implement", tags: ["ts"], risk: "medium", brain: "claude" }, allUp, catalog, { claude: null, codex: "gpt-6-astra" });
    const astra = r.candidates.find((c) => c.model === "gpt-6-astra");
    assert.equal(astra?.evidence.n, 3);
    assert.equal(r.decision.action, "delegate");
    assert.equal(r.decision.model, "gpt-6-astra");
  });

  it("include/exclude da config restringem os modelos considerados", () => {
    sb = makeSandbox({ routing: { exclude: ["codex:gpt-6-astra"] } });
    const r = recommend(new Store(sb.root), loadConfig(sb.root), { kind: "asset", tags: [], risk: "low", brain: "claude", needs: ["image_generation"] }, allUp, catalog);
    assert.ok(!r.candidates.some((c) => c.model === "gpt-6-astra"));
    assert.equal(r.decision.model, "gpt-6-sol");
  });
});
