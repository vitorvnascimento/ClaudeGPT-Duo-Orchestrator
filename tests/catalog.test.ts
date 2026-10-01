// Descoberta de modelos: cadeia de fontes (app-server estável → debug models → último catálogo bom → config).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { catalogPath, catalogTtlMs, cachedCatalog, findModel, invalidateCatalog, checkCodexCatalogContract, discover, loadCatalog, validateModelListPage, type Catalog } from "../src/adapters/catalog.js";
import { isPidAlive } from "../src/adapters/process.js";
import { loadConfig } from "../src/config.js";
import { delegate } from "../src/orchestration/delegate.js";
import { Store, writeJsonAtomic } from "../src/state/store.js";
import { baseRequest, CLI, FAKE_CODEX, makeSandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | null = null;
afterEach(() => {
  sb?.cleanup();
  sb = null;
});

const HOUR = 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fresh(): Sandbox {
  sb = makeSandbox();
  return sb;
}

function disc(s: Sandbox, env: Record<string, string> = {}, previous: Catalog | null = null, opts = {}) {
  return discover(loadConfig(s.root), s.root, { ...s.env, ...env }, previous, opts);
}

function cli(s: Sandbox, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: s.root, env: { ...s.env, ...env }, encoding: "utf8" });
}

describe("catálogo: fonte estável (codex app-server)", () => {
  it("usa model/list com paginação e os campos tipados: isDefault, sucessor declarado e imageGeneration", async () => {
    const s = fresh();
    const c = await disc(s);
    const cx = c.providers.codex;
    assert.equal(cx.ok, true, JSON.stringify(cx));
    assert.equal(cx.sourceKind, "codex-app-server");
    assert.equal(cx.stable, true);
    // 2 páginas, modelo oculto excluído
    assert.deepEqual(cx.models.map((m) => m.id), ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"]);
    assert.equal(cx.models.find((m) => m.vendorRecommended)?.id, "gpt-6-astra");
    const old = cx.models.find((m) => m.id === "gpt-5.5");
    assert.equal(old?.legacy, true, "sucessor declarado marca legado mesmo sem 'legacy' na descrição");
    assert.equal(old?.upgradeTo, "gpt-5.6-sol");
    assert.equal(old?.retirementAt, new Date(1792004400 * 1000).toISOString());
    assert.deepEqual(old?.efforts, ["low", "high"]);
    assert.deepEqual(cx.tools, ["image_generation"]);
    assert.ok(cx.models.every((m) => m.capabilities.includes("image_generation")));
    assert.equal(c.providers.claude.sourceKind, "claude-initialize");
    assert.equal(catalogTtlMs(c), 6 * HOUR);
    assert.ok(!s.log().some((e) => e.cmd === "debug-models"), "fallback não deve ser chamado quando a fonte estável funciona");
  });

  it("notificações do servidor (account/updated com e-mail) e dados do ambiente nunca vão para o cache", async () => {
    const s = fresh();
    const store = new Store(s.root);
    await loadCatalog(store, loadConfig(s.root), { env: s.env });
    const raw = readFileSync(catalogPath(store), "utf8");
    assert.ok(!raw.includes("pessoa-secreta@example.com"));
    assert.ok(!raw.includes("fake-codex-home"));
  });

  it("sem modelProvider/capabilities/read, a ferramenta de imagem vem do features list", async () => {
    const s = fresh();
    const on = (await disc(s, { FAKE_APPSERVER: "nocaps" })).providers.codex;
    assert.equal(on.sourceKind, "codex-app-server");
    assert.deepEqual(on.tools, ["image_generation"]);
    assert.ok(on.attempts?.some((a) => /capabilities\/read indisponível/.test(a)));
    const off = (await disc(s, { FAKE_APPSERVER: "nocaps", FAKE_NO_IMAGE_GEN: "1" })).providers.codex;
    assert.deepEqual(off.tools, []);
  });

  it("valida o formato de cada página e aceita campos extras", () => {
    const m = { id: "x", displayName: "X", hidden: false, isDefault: true, campoNovo: 1 };
    assert.deepEqual(validateModelListPage({ data: [m], nextCursor: null }), { data: [m], nextCursor: null });
    assert.throws(() => validateModelListPage({ items: [] }), /falta data/);
    assert.throws(() => validateModelListPage({ data: [{ id: "x", displayName: "X", hidden: "no", isDefault: true }] }), /data\[0\]\.hidden/);
    assert.throws(() => validateModelListPage({ data: [], nextCursor: 5 }), /nextCursor/);
  });
});

describe("catálogo: fallbacks", () => {
  it("app-server ausente → debug models, marcado como fallback frágil, com o motivo e revalidação em 1 h", async () => {
    const s = fresh();
    const c = await disc(s, { FAKE_APPSERVER: "off" });
    const cx = c.providers.codex;
    assert.equal(cx.ok, true);
    assert.equal(cx.sourceKind, "codex-debug-models");
    assert.equal(cx.stable, false);
    assert.match(cx.attempts?.[0] ?? "", /app-server model\/list: .*unrecognized subcommand/);
    assert.deepEqual(cx.models.map((m) => m.id), ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"]);
    assert.equal(catalogTtlMs(c), HOUR);
  });

  it("formato inesperado no model/list cai para o fallback em vez de gerar catálogo errado", async () => {
    const s = fresh();
    const cx = (await disc(s, { FAKE_APPSERVER: "badshape" })).providers.codex;
    assert.equal(cx.sourceKind, "codex-debug-models");
    assert.match(cx.attempts?.[0] ?? "", /formato inesperado de model\/list/);
  });

  it("app-server que não responde expira, é encerrado e cai para o fallback", async () => {
    const s = fresh();
    const cx = (await disc(s, { FAKE_APPSERVER: "hang" }, null, { appServerTimeoutMs: 500 })).providers.codex;
    assert.equal(cx.sourceKind, "codex-debug-models");
    assert.match(cx.attempts?.[0] ?? "", /sem resposta/);
    const pid = s.log().find((e) => e.cmd === "app-server")?.pid as number;
    assert.ok(pid > 0);
    for (let i = 0; i < 30 && isPidAlive(pid); i++) await sleep(100);
    assert.equal(isPidAlive(pid), false, "o app-server não pode sobrar");
  });

  it("todas as fontes falham → último catálogo bom, desatualizado, e a ponte não bloqueia modelo fora dele", async () => {
    const s = fresh();
    const store = new Store(s.root);
    const cfg = loadConfig(s.root);
    const good = await loadCatalog(store, cfg, { env: s.env });
    const down = await loadCatalog(store, cfg, { env: { ...s.env, FAKE_NO_CATALOG: "1" }, refresh: true });
    const cx = down.providers.codex;
    assert.equal(cx.ok, true);
    assert.equal(cx.stale, true);
    assert.equal(cx.staleSince, good.discoveredAt);
    assert.equal(cx.attempts?.length, 2, JSON.stringify(cx.attempts));
    assert.equal(down.providers.claude.stale, true);
    assert.equal(catalogTtlMs(down), HOUR);
    // Uma segunda falha preserva a data original do catálogo bom.
    const again = await loadCatalog(store, cfg, { env: { ...s.env, FAKE_NO_CATALOG: "1" }, refresh: true });
    assert.equal(again.providers.codex.staleSince, good.discoveredAt);

    const out = await delegate({
      cwd: s.root,
      requestPath: s.request(baseRequest("claude", { model: "gpt-6-nova", brainModel: "claude-opus-5-5" })),
      env: { ...s.env, FAKE_NO_CATALOG: "1", FAKE_WRITE: JSON.stringify({ "src/app.ts": "export const app = 2;\n" }) },
      authPaths: s.authPaths,
    });
    assert.equal(out.summary.state, "succeeded", JSON.stringify(out.summary));
    assert.ok((out.summary.limitations as string[]).some((l) => /catálogo do codex desatualizado/.test(l)));
    const t = new Store(s.root).findTask(String(out.summary.taskId));
    assert.equal(t?.brainModel, "claude-opus-5-5", "o modelo do cérebro fica registrado na task");
  });

  it("dentro do sandbox do Codex pula o app-server; fora dele o catálogo é refeito pela fonte estável na hora", async () => {
    const s = fresh();
    const store = new Store(s.root);
    const cfg = loadConfig(s.root);
    const inside = await loadCatalog(store, cfg, { env: { ...s.env, CODEX_SANDBOX: "seatbelt" } });
    assert.equal(inside.discoveredInSandbox, true);
    assert.equal(inside.providers.codex.sourceKind, "codex-debug-models");
    assert.match(inside.providers.codex.attempts?.[0] ?? "", /app-server pulado: dentro do sandbox/);
    assert.ok(!s.log().some((e) => e.method === "model/list"), "a descoberta via model/list não deve ser iniciada no sandbox");
    assert.ok(s.log().some((e) => e.method === "config/read"), "a leitura local da configuração tem fallback próprio");
    const outside = await loadCatalog(store, cfg, { env: s.env });
    assert.equal(outside.discoveredInSandbox, undefined);
    assert.equal(outside.providers.codex.sourceKind, "codex-app-server");
  });

  it("último catálogo bom com mais de 30 dias não é usado: vale routing.candidates", async () => {
    const s = fresh();
    const good = await disc(s);
    const old: Catalog = { ...good, discoveredAt: new Date(Date.now() - 31 * 24 * HOUR).toISOString() };
    const c = await disc(s, { FAKE_NO_CATALOG: "1" }, old);
    assert.equal(c.providers.codex.ok, false);
    assert.equal(c.providers.codex.stale, undefined);
  });
});

describe("contrato da fonte estável", () => {
  it("confere métodos e campos no schema gerado localmente e aponta mudança", () => {
    const s = fresh();
    assert.deepEqual(checkCodexCatalogContract(process.execPath, [FAKE_CODEX], s.env), { ok: true, problems: [] });
    const drift = checkCodexCatalogContract(process.execPath, [FAKE_CODEX], { ...s.env, FAKE_SCHEMA: "drift" });
    assert.equal(drift.ok, false);
    assert.match(drift.problems.join("; "), /método model\/list fora da superfície estável/);
  });

  it("duo models e duo doctor mostram a origem de cada conta e o estado do contrato", () => {
    const s = fresh();
    const models = cli(s, ["models"]);
    assert.equal(models.status, 0, models.stderr);
    assert.match(models.stdout, /codex app-server model\/list/);
    assert.match(models.stdout, /legado → gpt-5\.6-sol, aposentadoria \d{4}-\d{2}-\d{2}/);
    const doc = cli(s, ["doctor"]);
    assert.equal(doc.status, 0, doc.stderr);
    assert.match(doc.stdout, /codex: 4 modelos \+ image_generation via app-server model\/list \(estável\)/);
    assert.match(doc.stdout, /contrato do catálogo \(app-server model\/list, superfície estável\): ok/);
    const drift = cli(s, ["doctor"], { FAKE_SCHEMA: "drift" });
    assert.match(drift.stdout, /aviso: contrato do catálogo mudou \(método model\/list fora da superfície estável\)/);
    const fallback = cli(s, ["models", "--refresh"], { FAKE_APPSERVER: "off" });
    assert.match(fallback.stdout, /aviso: fonte frágil \(fallback\)/);
    assert.match(fallback.stdout, /fonte que falhou: app-server model\/list/);
  });
});

describe("CLI: opções desconhecidas", () => {
  it("opção inexistente é recusada listando as aceitas; --json vale em qualquer comando", () => {
    const s = fresh();
    const bad = cli(s, ["doctor", "--cwd", "/tmp"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /opção desconhecida para duo doctor: --cwd \(aceitas: --json, --help, --version\)/);
    const typo = cli(s, ["recommend", "--kind", "implement", "--brain-modle", "x"]);
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /--brain-modle/);
    assert.equal(cli(s, ["models", "--json"]).status, 0);
  });
});

describe("cache por versão e modelos configurados", () => {
  it("cada atualização de CLI invalida antes de 6 h; versões iguais usam cache", async () => {
    const s = fresh(), store = new Store(s.root), cfg = loadConfig(s.root);
    const env = { ...s.env, FAKE_CLAUDE_VERSION: "2.1.283", FAKE_CODEX_VERSION: "0.157.1" };
    const count = () => s.log().filter((c) => c.cmd === "initialize" || (c.method === "model/list" && c.hasCursor !== true)).length;
    const first = await loadCatalog(store, cfg, { env });
    assert.deepEqual(first.cliVersions, { claude: "2.1.283", codex: "0.157.1" });
    await loadCatalog(store, cfg, { env });
    assert.equal(count(), 2);
    env.FAKE_CLAUDE_VERSION = "2.1.285";
    assert.equal((await loadCatalog(store, cfg, { env })).cliVersions.claude, "2.1.285");
    assert.equal(count(), 4);
    env.FAKE_CODEX_VERSION = "0.159.2";
    assert.equal((await loadCatalog(store, cfg, { env })).cliVersions.codex, "0.159.2");
    assert.equal(count(), 6);
    assert.deepEqual(cachedCatalog(store)?.cliVersions, { claude: "2.1.285", codex: "0.159.2" });
    invalidateCatalog(store);
    invalidateCatalog(store);
    assert.equal(existsSync(catalogPath(store)), false);
    await loadCatalog(store, cfg, { env });
    assert.equal(count(), 8);
  });

  it("cache legado sem versões e cache de 6 h são redescobertos", async () => {
    const s = fresh(), store = new Store(s.root), cfg = loadConfig(s.root);
    const first = await loadCatalog(store, cfg, { env: s.env });
    const { cliVersions: _v, ...legacy } = first;
    writeJsonAtomic(catalogPath(store), legacy);
    await loadCatalog(store, cfg, { env: s.env });
    assert.equal(s.log().filter((c) => c.cmd === "initialize").length, 2);
    writeJsonAtomic(catalogPath(store), { ...first, discoveredAt: new Date(Date.now() - 6 * HOUR).toISOString() });
    await loadCatalog(store, cfg, { env: s.env });
    assert.equal(s.log().filter((c) => c.cmd === "initialize").length, 3);
  });

  it("model dos arquivos e extraModels entram sem duplicar IDs/aliases; releitura sem expirar cache", async () => {
    const s = fresh(), store = new Store(s.root);
    s.config({ routing: { extraModels: ["claude:opus", "claude:custom-opus", "codex:gpt-6.1-sol", "codex:GPT-6.1-SOL"] } });
    const claudeFile = join(s.home, ".claude", "settings.json"), codexFile = join(s.home, ".codex", "config.toml");
    writeFileSync(claudeFile, JSON.stringify({ model: "custom-opus", env: { ANTHROPIC_API_KEY: "não ler nem gravar" } }));
    writeFileSync(codexFile, 'model = "gpt-6.1-sol"\n[profiles.other]\nmodel = "ignore-me"\n');
    const cfg = loadConfig(s.root);
    const c = await loadCatalog(store, cfg, { env: s.env });
    assert.equal(c.providers.claude.models.filter((m) => m.id === "custom-opus").length, 1);
    assert.equal(c.providers.claude.models.filter((m) => m.id === "opus").length, 0);
    assert.equal(c.providers.codex.models.filter((m) => m.source === "user-config").length, 1);
    assert.deepEqual(findModel(c, "codex", "gpt-6.1-sol")?.efforts, []);
    assert.equal(findModel(c, "claude", "custom-opus")?.source, "user-config");
    assert.equal(findModel(c, "claude", "opus")?.source, "discovered");
    assert.equal(findModel(c, "codex", "ignore-me"), null);
    assert.ok(!readFileSync(catalogPath(store), "utf8").includes("não ler"));
    writeFileSync(claudeFile, '{"model":"new-haiku"}');
    const next = await loadCatalog(store, cfg, { env: s.env });
    assert.equal(findModel(next, "claude", "new-haiku")?.source, "user-config");
    assert.equal(s.log().filter((c) => c.cmd === "initialize").length, 1);
    assert.equal(readFileSync(claudeFile, "utf8"), '{"model":"new-haiku"}');
  });

  it("JSON/TOML inválidos não quebram e modelos removidos não permanecem no cache", async () => {
    const s = fresh(), store = new Store(s.root), cfg = loadConfig(s.root);
    const claudeFile = join(s.home, ".claude", "settings.json"), codexFile = join(s.home, ".codex", "config.toml");
    writeFileSync(claudeFile, '{"model":"custom-opus"}');
    writeFileSync(codexFile, 'model = "custom-sol"');
    s.env.FAKE_CODEX_CONFIG = JSON.stringify({ model: "custom-sol" });
    const first = await loadCatalog(store, cfg, { env: s.env });
    assert.ok(findModel(first, "claude", "custom-opus"));
    assert.ok(findModel(first, "codex", "custom-sol"));
    for (const invalid of ["{", "null", '{"model":1}', '{"model":"foo\\u001b[31m"}']) {
      writeFileSync(claudeFile, invalid);
      writeFileSync(codexFile, 'model = "unterminated\n[broken');
      s.env.FAKE_CONFIG_READ = "off";
      const c = await loadCatalog(store, cfg, { env: s.env });
      assert.ok(c.providers.claude.models.every((m) => m.source === "discovered"));
      assert.ok(c.providers.codex.models.every((m) => m.source === "discovered"));
    }
  });
});
