import { strict as assert } from "node:assert";
import { afterEach, it } from "node:test";
import { catalogPath } from "../src/adapters/catalog.js";
import { loadConfig } from "../src/config.js";
import { assessComplexity } from "../src/orchestration/complexity.js";
import { applyTask } from "../src/orchestration/control.js";
import { delegate } from "../src/orchestration/delegate.js";
import { deriveTags, recommend } from "../src/orchestration/router.js";
import { Store, writeJsonAtomic } from "../src/state/store.js";
import { adaptiveCatalog } from "./adaptive-catalog.js";
import { baseRequest, makeSandbox, type Sandbox } from "./helpers.js";

let s: Sandbox;
afterEach(() => s?.cleanup());
const ok = { criteria: ["verificado"], commands: [{ name: "ok", argv: ["node", "-e", "process.exit(0)"] }] };
const req = (extra: Record<string, unknown> = {}) => baseRequest("claude", { adaptive: true, risk: "high", acceptance: ok, ...extra });
const run = (request: Record<string, unknown>, fake: Record<string, string> = {}) => delegate({ cwd: s.root, requestPath: s.request(request), env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1", ...fake }, authPaths: s.authPaths });
const cache = () => {
  const c = structuredClone(adaptiveCatalog); c.discoveredAt = new Date().toISOString();
  return c;
};
const save = (c: typeof adaptiveCatalog) => writeJsonAtomic(catalogPath(new Store(s.root)), c);

it("rodada 2 achado 2: reserva automática stale não contorna uso extra/include/exclude/capacidade", async () => {
  s = makeSandbox({ executors: { claude: { model: "claude-fable-5-1[1m]" } } });
  const c = cache(); c.providers.claude.stale = true; save(c);
  const out = await run(req({ brain: "codex", executor: "claude", risk: "medium" }));
  assert.equal(out.summary.state, "blocked"); assert.equal(s.execCalls().length, 0);
  assert.match(String(out.summary.outcome), /confirm|catálogo|elegib/i);
  s.config({ executors: { claude: { model: "claude-sonnet-5-5" } }, routing: { exclude: ["claude:claude-sonnet-5-5"] } });
  const excluded = await run(req({ brain: "codex", executor: "claude", risk: "medium" }));
  assert.equal(excluded.summary.state, "blocked"); assert.equal(s.execCalls().length, 0);
});

it("rodada 2 achado 2: cadastro manual de modelo não confirma elegibilidade automática", async () => {
  s = makeSandbox({ executors: { codex: { model: "gpt-custom-sol" } }, routing: { include: ["codex:gpt-custom-sol"], extraModels: ["codex:gpt-custom-sol"] } });
  save(cache());
  const out = await run(req({ risk: "medium" }));
  assert.equal(out.summary.state, "blocked"); assert.equal(s.execCalls().length, 0);
});

it("rodada 2 achado 3: sensibilidade após 2000 arquivos e em caminhos ignorados exige deep", () => {
  s = makeSandbox();
  for (let i = 0; i < 2000; i++) s.write(`src/a${String(i).padStart(4, "0")}.ts`, "");
  s.write("src/z/auth/login.ts", "");
  const entries = [{ rel: "src", isDir: true }];
  const assess = () => assessComplexity({ kind: "implement", risk: "low" }, entries, deriveTags(s.root, entries, true));
  assert.equal(assess().floor, "deep");
  s.write(".gitignore", ".duo/\nsrc/z/\n");
  assert.equal(assess().floor, "deep");
});

it("rodada 2 achado 3: inspeção incompleta exige deep e explica a incerteza", () => {
  s = makeSandbox();
  const entries = [{ rel: "missing", isDir: true }];
  const a = assessComplexity({ kind: "implement", risk: "low" }, entries, deriveTags(s.root, entries, true));
  assert.equal(a.floor, "deep"); assert.match(a.signals.join(" "), /incompleta/);
});

it("rodada 2 achado 4: deep sem esforço high anunciado bloqueia antes de executar", async () => {
  s = makeSandbox(); const c = cache();
  c.providers.codex.models.find((m) => m.id === "gpt-6-astra")!.efforts = ["low", "medium"]; save(c);
  const out = await run(req({ model: "gpt-6-astra" }));
  assert.equal(out.summary.state, "blocked"); assert.equal(s.execCalls().length, 0);
  assert.match(String(out.summary.outcome), /esforço|effort/);
});

it("rodada 2 achado 4: deep com catálogo ausente ou stale não herda effort da configuração", async () => {
  s = makeSandbox({ executors: { codex: { model: "gpt-6-astra" } } });
  const absent = await run(req(), { FAKE_NO_CATALOG: "1" });
  assert.equal(absent.summary.state, "blocked"); assert.equal(s.execCalls().length, 0);
  const c = cache(); c.providers.codex.stale = true; save(c);
  const stale = await run(req({ model: "gpt-6-astra", effort: "high" }));
  assert.equal(stale.summary.state, "blocked"); assert.equal(s.execCalls().length, 0);
});

it("rodada 2 achado 4: recommend não sugere deep sem esforço confirmado", () => {
  s = makeSandbox(); const c = cache();
  for (const p of Object.values(c.providers)) for (const m of p.models) m.efforts = ["low", "medium"];
  const r = recommend(new Store(s.root), loadConfig(s.root), { kind: "implement", tags: [], risk: "high", brain: "claude" }, () => ({ available: true, reasons: [] }), c);
  assert.equal(r.decision.action, "judgment"); assert.equal(r.decision.executor, null);
  assert.match(r.decision.why.join(" "), /esforço|confirm/i);
});

it("rodada 2 achado 4: retomada deep refaz confirmação e não usa catálogo stale", async () => {
  s = makeSandbox();
  const first = await run(req(), { FAKE_REPORT: JSON.stringify({ status: "blocked", blockedReason: "Precisa de decisão do cérebro" }) });
  assert.equal(first.summary.state, "blocked"); assert.equal(s.execCalls().length, 1);
  const c = cache(); c.providers.codex.stale = true; save(c);
  const resumed = await delegate({ cwd: s.root, resumeTaskId: String(first.summary.taskId), env: { ...s.env, FAKE_ADAPTIVE_CATALOG: "1" }, authPaths: s.authPaths });
  assert.equal(resumed.summary.state, "blocked"); assert.equal(s.execCalls().length, 1);
  assert.match(String(resumed.summary.outcome), /confirm|stale/);
});

for (const provider of ["claude", "codex"] as const) it(`rodada 2 achado 5: modelo nativo inferior no ${provider} falha sem integrar ou escalar`, async () => {
  s = makeSandbox({ routing: { adaptive: { maxAttempts: 3 } }, limits: { maxDelegationsPerRun: 5 } });
  const model = provider === "claude" ? "claude-opus-5-5" : "gpt-6-astra";
  const native = provider === "claude" ? "claude-haiku-4-5-20251001" : "gpt-6-luna";
  const out = await run(req({ brain: provider === "claude" ? "codex" : "claude", executor: provider, model, isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: native, FAKE_ROLLOUT_MODEL: native,
    FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed"); assert.equal(s.execCalls().length, 1);
  assert.match(String(out.summary.outcome), new RegExp(`modelo efetivo ${native} abaixo do piso deep`));
  assert.equal(applyTask(s.root, String(out.summary.taskId)).ok, false);
  assert.equal(s.read("src/app.ts"), "export const app = 1;\n");
});

it("rodada 2 achado 5: Claude init inferior é interrompido cedo", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-haiku-4-5-20251001", FAKE_CLAUDE_INIT_DELAY_MS: "4000",
    FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed");
  assert.equal(s.read("src/app.ts"), "export const app = 1;\n");
});

for (const fake of [{ FAKE_NO_ROLLOUT: "1" }, { FAKE_ROLLOUT_MODEL: "gpt-future-astra" }, { FAKE_ROLLOUT_EFFORT: "low" }] as Record<string, string>[]) it(`rodada 2 achado 5: deep rejeita evidência nativa não confirmável ${Object.keys(fake)[0]}`, async () => {
  s = makeSandbox();
  const out = await run(req({ model: "gpt-6-astra" }), fake);
  assert.equal(out.summary.state, "failed"); assert.equal(s.execCalls().length, 1);
  assert.match(String(out.summary.outcome), /modelo efetivo .*piso deep/);
  const t = new Store(s.root).findTask(String(out.summary.taskId))!;
  assert.equal(t.verification?.acceptance.length, 0);
});

it("rodada 9 achado 1: variante paga [1m] informada pelo cliente não passa como o modelo pedido", async () => {
  s = makeSandbox({ routing: { include: ["claude:claude-opus-5-5"] }, billing: { acknowledgeUnverifiableExtraUsage: { claude: true } } });
  // Catálogo com Opus normal e Opus[1m] (variante com créditos), como na reprodução do review.
  const c = cache();
  const opus = c.providers.claude.models.find((m) => m.id === "claude-opus-5-5")!;
  c.providers.claude.models.push({ ...opus, id: "claude-opus-5-5[1m]", displayName: "Opus (1M context)", description: "Draws from usage credits · $4/$20 per Mtok", vendorRecommended: false });
  save(c);
  const out = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-opus-5-5[1m]",
    FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
  assert.match(String(out.summary.outcome), /créditos extras|uso extra/);
  assert.equal(applyTask(s.root, String(out.summary.taskId)).ok, false);
  assert.equal(s.read("src/app.ts"), "export const app = 1;\n");
});

it("rodada 9 achado 2: execução no próprio modelo do cérebro falha mesmo quando a seleção escolheu outro", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "codex", brainModel: "gpt-6-astra", executor: "codex", risk: "medium", complexity: "standard", isolation: "worktree" }), {
    FAKE_ROLLOUT_MODEL: "gpt-6-astra", FAKE_ROLLOUT_EFFORT: "high",
    FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
  assert.match(String(out.summary.outcome), /próprio modelo do cérebro/);
  assert.equal(applyTask(s.root, String(out.summary.taskId)).ok, false);
});

it("rodada 10 achado 1: uso final em outro modelo não passa só porque o init informou o modelo certo", async () => {
  s = makeSandbox();
  const write = JSON.stringify({ "src/app.ts": "export const app = 2;\n" });
  const swapped = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-opus-5-5", FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-sonnet-5-5": { outputTokens: 900 } }), FAKE_WRITE: write,
  });
  assert.equal(swapped.summary.state, "failed", JSON.stringify(swapped.summary));
  assert.match(String(swapped.summary.outcome), /uso registrado/);
  const paid = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-opus-5-5", FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-opus-5-5": {}, "claude-fable-5-1[1m]": { costUSD: 1 } }), FAKE_WRITE: write,
  });
  assert.equal(paid.summary.state, "failed", JSON.stringify(paid.summary));
  assert.match(String(paid.summary.outcome), /créditos extras/);
  // Uso auxiliar legítimo do próprio cliente (Haiku) junto do modelo principal não reprova a entrega.
  const aux = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-opus-5-5", FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-opus-5-5": {}, "claude-haiku-4-5-20251001": {} }), FAKE_WRITE: write,
  });
  assert.equal(aux.summary.state, "succeeded", JSON.stringify(aux.summary));
});

it("rodada 10 achado 2: esforço incompatível com o nível do modelo efetivo é recusado antes de invocar", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "claude", executor: "codex", risk: "medium", model: "gpt-6-astra", effort: "low", isolation: "worktree" }));
  assert.equal(out.summary.state, "blocked", JSON.stringify(out.summary));
  assert.equal(s.execCalls().length, 0, "nenhuma invocação desperdiçada");
  assert.match(String(out.summary.outcome), /esforço|effort/);
});

it("rodada 10 achado 3: alias explícito de modelo pago autorizado não é tratado como troca", async () => {
  s = makeSandbox({ billing: { acknowledgeUnverifiableExtraUsage: { claude: true } } });
  const c = cache();
  const fable = c.providers.claude.models.find((m) => m.id === "claude-fable-5-1[1m]")!;
  fable.aliases = ["fable[1m]"];
  save(c);
  const out = await run(req({ brain: "codex", executor: "claude", model: "fable[1m]", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-fable-5-1[1m]", FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
});

it("rodada 11: identidade de modelo única — alias de família, sufixo de data e variante paga", async () => {
  const { sameModelIdentity, findModel, modelKey } = await import("../src/adapters/catalog.js");
  const c = cache();
  // Sufixo de data é o mesmo modelo, nos dois sentidos, e encontra os metadados do catálogo.
  assert.equal(modelKey("claude-opus-5-5-20260901"), "claude-opus-5-5");
  assert.equal(findModel(c, "claude", "claude-opus-5-5-20260901")?.id, "claude-opus-5-5");
  assert.equal(findModel(c, "claude", "claude-haiku-4-5")?.id, "claude-haiku-4-5-20251001");
  assert.ok(sameModelIdentity(c, "claude", "claude-opus-5-5-20260901", "claude-opus-5-5"));
  assert.ok(sameModelIdentity(null, "claude", "claude-opus-5-5", "claude-opus-5-5-20260901"));
  // Variante paga nunca é o modelo base, em nenhum modo.
  for (const mode of ["strict", "loose"] as const) {
    assert.ok(!sameModelIdentity(c, "claude", "claude-sonnet-5-5", "claude-sonnet-5-5[1m]", mode));
    assert.ok(!sameModelIdentity(null, "claude", "sonnet", "claude-sonnet-5-5[1m]", mode), `alias não autoriza variante paga (${mode})`);
  }
  // Alias de família não resolvido: nunca vale como identidade exata (estrito); só bloqueia (solto).
  assert.ok(!sameModelIdentity(null, "claude", "sonnet", "claude-sonnet-5-5", "strict"));
  assert.ok(sameModelIdentity(null, "claude", "sonnet", "claude-sonnet-5-5", "loose"));
  // Alias resolvido pelo catálogo compara pelo ID resolvido: 'opus' → 5-5 não casa com Opus 4-6.
  const withAlias = cache();
  withAlias.providers.claude.models.find((m) => m.id === "claude-opus-5-5")!.aliases = ["opus"];
  assert.ok(!sameModelIdentity(withAlias, "claude", "opus", "claude-opus-4-6", "loose"));
  assert.ok(sameModelIdentity(withAlias, "claude", "opus", "claude-opus-5-5-20260901", "loose"));
});

it("rodada 11 achado 1: alias não resolvido não autoriza variante paga", async () => {
  s = makeSandbox({ billing: { acknowledgeUnverifiableExtraUsage: { claude: true } } });
  const out = await run(req({ brain: "codex", executor: "claude", risk: "medium", model: "sonnet", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-sonnet-5-5[1m]", FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  // Com catálogo, o alias é recusado antes de executar; sem ele, a variante paga é reprovada depois. Nunca succeeded.
  assert.ok(["blocked", "failed"].includes(String(out.summary.state)), JSON.stringify(out.summary));
  assert.equal(applyTask(s.root, String(out.summary.taskId)).ok, false);
  // Sem catálogo: a confirmação nativa usa a identidade estrita, e o alias não vale como pedido exato da variante.
  const { sameModelIdentity } = await import("../src/adapters/catalog.js");
  assert.equal(sameModelIdentity(null, "claude", "sonnet", "claude-sonnet-5-5[1m]", "strict"), false);
});

it("rodada 11 achado 2: cérebro com sufixo de data ainda é reconhecido como o próprio cérebro", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "claude", brainModel: "claude-opus-5-5-20260901", executor: "claude", risk: "medium", model: "claude-sonnet-5-5", effort: "high", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-opus-5-5", FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
  assert.equal(applyTask(s.root, String(out.summary.taskId)).ok, false);
});

it("rodada 11 achado 3: troca nativa para modelo deep com esforço medium é reprovada", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "codex", executor: "claude", risk: "medium", model: "claude-sonnet-5-5", effort: "medium", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-opus-5-5", FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
  assert.match(String(out.summary.outcome), /esforço|effort/);
});

it("auditoria: pedido [1m] autorizado passa quando o cliente registra o nome servido sem a variante", async () => {
  const { reportedMatchesRequested } = await import("../src/adapters/catalog.js");
  const c = cache();
  assert.ok(reportedMatchesRequested(c, "claude", "claude-fable-5-1[1m]", "claude-fable-5-1"), "relatório pode omitir [1m]");
  assert.ok(!reportedMatchesRequested(c, "claude", "claude-opus-5-5", "claude-opus-5-5[1m]"), "relatório nunca acrescenta [1m]");
  assert.ok(!reportedMatchesRequested(c, "claude", "claude-fable-5-1[1m]", "claude-opus-5-5"), "outro modelo não casa");
  s = makeSandbox({ routing: { include: ["claude:claude-fable-5-1[1m]"] }, billing: { acknowledgeUnverifiableExtraUsage: { claude: true } } });
  const write = JSON.stringify({ "src/app.ts": "export const app = 2;\n" });
  const ok = await run(req({ brain: "codex", executor: "claude", model: "claude-fable-5-1[1m]", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-fable-5-1[1m]", FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-fable-5-1": {}, "claude-haiku-4-5-20251001": {} }), FAKE_WRITE: write,
  });
  assert.equal(ok.summary.state, "succeeded", JSON.stringify(ok.summary));
  const initWithout = await run(req({ brain: "codex", executor: "claude", model: "claude-fable-5-1[1m]", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-fable-5-1", FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-fable-5-1": {} }), FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 3;\n" }),
  });
  assert.equal(initWithout.summary.state, "succeeded", JSON.stringify(initWithout.summary));
});

it("auditoria: uso registrado na variante [1m] de um pedido base continua reprovado", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5", isolation: "worktree" }), {
    FAKE_CLAUDE_REPORTED_MODEL: "claude-opus-5-5", FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-opus-5-5[1m]": { costUSD: 1 } }), FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
});

it("rodada 12: fallback da CLI no meio do turno para modelo abaixo do piso reprova a entrega", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5", isolation: "worktree" }), {
    FAKE_CLAUDE_FALLBACK: "claude-sonnet-5-5",
    FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-opus-5-5": {}, "claude-sonnet-5-5": {} }),
    FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
  assert.match(String(out.summary.outcome), /claude-sonnet-5-5/);
  assert.equal(applyTask(s.root, String(out.summary.taskId)).ok, false);
  assert.equal(s.read("src/app.ts"), "export const app = 1;\n");
});

it("rodada 12: fluxo principal em Opus com Haiku auxiliar no uso continua aprovado", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5", isolation: "worktree" }), {
    FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-opus-5-5": { outputTokens: 900 }, "claude-haiku-4-5-20251001": { outputTokens: 20 } }),
    FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
});

it("rodada 12: resposta do assistente em um modelo sem uso registrado nele é contraditória e reprova", async () => {
  s = makeSandbox();
  const out = await run(req({ brain: "codex", executor: "claude", model: "claude-opus-5-5", isolation: "worktree" }), {
    FAKE_CLAUDE_MODEL_USAGE: JSON.stringify({ "claude-sonnet-5-5": {} }),
    FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }),
  });
  assert.equal(out.summary.state, "failed", JSON.stringify(out.summary));
  assert.match(String(out.summary.outcome), /uso registrado/);
});
