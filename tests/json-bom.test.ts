// Regressão offline dos arquivos JSON editáveis; CLIs de IA são apenas fixtures locais.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs = require("node:fs");
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCatalog } from "../src/adapters/catalog.js";
import { doctor } from "../src/cli/doctor.js";
import { planInit } from "../src/cli/init.js";
import { loadConfig } from "../src/config.js";
import { delegate } from "../src/orchestration/delegate.js";
import { packageRoot } from "../src/paths.js";
import { loadSchema, schemaPath, validate } from "../src/schema.js";
import { Store } from "../src/state/store.js";
import { currentVersion } from "../src/update.js";
import { baseRequest, CLI, makeSandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

function setup(): Sandbox {
  sb = makeSandbox();
  return sb;
}

function cli(s: Sandbox, args: string[], preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : []), CLI, ...args], {
    cwd: s.root, env: s.env, encoding: "utf8",
  });
}

describe("JSON de entrada com BOM UTF-8", () => {
  it("delegate aceita BOM e preserva U+FEFF no objetivo", async () => {
    const s = setup();
    const objective = "Revisar\uFEFF src/app.ts sem editar.";
    const requestPath = s.request(baseRequest("claude", { kind: "review", objective }));
    writeFileSync(requestPath, `\uFEFF${fs.readFileSync(requestPath, "utf8")}`);
    const out = await delegate({ cwd: s.root, requestPath, env: s.env, authPaths: s.authPaths });
    assert.equal(out.exitCode, 0, JSON.stringify(out.summary));
    assert.equal(new Store(s.root).findTask(String(out.summary.taskId))?.objective, objective);
    assert.equal(s.execCalls().length, 1);
  });

  it("delegate mantém a validação de sintaxe e schema", async () => {
    const s = setup();
    const path = s.request({});
    const valid = JSON.stringify(baseRequest("claude"));
    for (const content of ["\uFEFF{", `\uFEFF\uFEFF${valid}`, ` \uFEFF${valid}`, `${valid}\uFEFF`]) {
      writeFileSync(path, content);
      const out = await delegate({ cwd: s.root, requestPath: path, env: s.env, authPaths: s.authPaths });
      assert.equal(out.exitCode, 2);
      assert.match(String(out.summary.error), /pedido não é JSON válido/);
    }
    writeFileSync(path, '\uFEFF{"version":1}');
    const out = await delegate({ cwd: s.root, requestPath: path, env: s.env, authPaths: s.authPaths });
    assert.equal(out.exitCode, 2);
    assert.equal(out.summary.error, "pedido fora do schema");
    assert.equal(s.execCalls().length, 0);
  });

  it("recommend aceita o mesmo pedido com e sem BOM e continua recusando entradas inválidas", () => {
    const s = setup();
    const content = JSON.stringify(baseRequest("claude", { objective: "Revisar\uFEFF arquivo" }));
    const path = s.request({});
    let expected: unknown;
    for (const prefix of ["", "\uFEFF"]) {
      writeFileSync(path, prefix + content);
      const result = cli(s, ["recommend", "--request", path, "--json"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout) as { query: unknown; decision: unknown };
      if (!prefix) expected = { query: report.query, decision: report.decision };
      else assert.deepEqual({ query: report.query, decision: report.decision }, expected);
    }
    for (const content of ["\uFEFF{", "\uFEFF\uFEFF{}", '\uFEFF{"version":1}']) {
      writeFileSync(path, content);
      const result = cli(s, ["recommend", "--request", path, "--json"]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
    }
    assert.equal(s.execCalls().length, 0);
  });

  it("init reconhece o script test no package.json com BOM", () => {
    const s = setup();
    const config = () => JSON.parse(planInit(s.root, "codex").find((f) => f.rel === ".duo/config.json")!.content);
    const content = JSON.stringify({ scripts: { test: "node --test" } });
    writeFileSync(join(s.root, "package.json"), content);
    const expected = config();
    writeFileSync(join(s.root, "package.json"), `\uFEFF${content}`);
    assert.deepEqual(config(), expected);
    assert.deepEqual(config().acceptance.allowedCommands, [["npm", "test"]]);
    writeFileSync(join(s.root, "package.json"), "\uFEFF{");
    assert.deepEqual(config().acceptance.allowedCommands, []);
  });

  it("versão lê package.json com BOM sem modificar o manifesto da instalação", (t) => {
    const s = setup();
    const path = join(packageRoot(), "package.json");
    const version = "1.2.3\uFEFFlocal";
    const content = `\uFEFF${JSON.stringify({ version })}`;
    const original = fs.readFileSync;
    try {
      t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) =>
        String(args[0]) === path ? content : original(...args)) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      assert.equal(currentVersion(), version);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    const preload = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.readFileSync;
fs.readFileSync = (...args) => String(args[0]) === ${JSON.stringify(path)} ? ${JSON.stringify(content)} : original(...args);
syncBuiltinESMExports();`;
    const result = cli(s, ["--version"], preload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
  });

  it("schemas locais aceitam um BOM e preservam strings e validação", (t) => {
    const original = fs.readFileSync;
    const schema = { type: "string", const: "antes\uFEFFdepois" };
    const contents = [JSON.stringify(schema), `\uFEFF${JSON.stringify(schema)}`, "\uFEFF{", "\uFEFF\uFEFF{}", " \uFEFF{}", "{}\uFEFF"];
    const paths = contents.map((_, i) => schemaPath(`json-bom-${i}`));
    try {
      t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
        const index = paths.indexOf(String(args[0]));
        return index >= 0 ? contents[index] : original(...args);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      assert.deepEqual(loadSchema("json-bom-1"), loadSchema("json-bom-0"));
      assert.deepEqual(validate(loadSchema("json-bom-1"), schema.const), []);
      assert.ok(validate(loadSchema("json-bom-1"), "antesdepois").length > 0);
      for (let i = 2; i < contents.length; i++) assert.throws(() => loadSchema(`json-bom-${i}`), SyntaxError);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("doctor reconhece hooks e MCP com BOM e preserva U+FEFF nos nomes", async () => {
    const s = setup();
    mkdirSync(join(s.root, ".claude"), { recursive: true });
    const files = [join(s.home, ".claude", "settings.json"), join(s.root, ".claude", "settings.json"), join(s.root, ".mcp.json")];
    const contents = [{ hooks: { "Pre\uFEFFToolUse": [] } }, { hooks: { PostToolUse: [] } }, { mcpServers: { "local\uFEFFserver": {} } }];
    const audit = async () => (await doctor(s.root, s.env, s.authPaths)).audit as Record<string, unknown>;
    files.forEach((file, i) => writeFileSync(file, JSON.stringify(contents[i])));
    const expected = await audit();
    files.forEach((file, i) => writeFileSync(file, `\uFEFF${JSON.stringify(contents[i])}`));
    assert.deepEqual(await audit(), expected);
    assert.deepEqual(expected.claudeUserHooks, ["Pre\uFEFFToolUse"]);
    assert.deepEqual(expected.claudeProjectHooks, ["PostToolUse"]);
    assert.deepEqual(expected.projectMcpServers, ["local\uFEFFserver"]);
    files.forEach((file) => writeFileSync(file, "\uFEFF{"));
    const invalid = await audit();
    for (const key of ["claudeUserHooks", "claudeProjectHooks", "projectMcpServers"]) assert.deepEqual(invalid[key], []);
    assert.equal(s.execCalls().length, 0);
  });

  it("catálogo inclui modelo configurado em settings.json com BOM e ignora JSON inválido", async () => {
    const s = setup();
    const path = join(s.home, ".claude", "settings.json");
    const model = "claude-bom-local";
    const catalog = () => loadCatalog(new Store(s.root), loadConfig(s.root), { env: s.env });
    writeFileSync(path, JSON.stringify({ model }));
    const expected = (await catalog()).providers.claude.models;
    writeFileSync(path, `\uFEFF${JSON.stringify({ model })}`);
    const models = (await catalog()).providers.claude.models;
    assert.deepEqual(models, expected);
    assert.equal(models.find((m) => m.id === model)?.source, "user-config");
    writeFileSync(path, "\uFEFF{");
    assert.ok(!(await catalog()).providers.claude.models.some((m) => m.id === model));
    assert.equal(s.execCalls().length, 0);
  });
});
