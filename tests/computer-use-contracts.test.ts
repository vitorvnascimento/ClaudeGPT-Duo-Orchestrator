import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { executorSchemaForCli, writeExecutorSchema } from "../src/adapters/report-schema.js";
import type { Capability } from "../src/adapters/catalog.js";
import { ConfigError, configPath, DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { loadSchema, validate } from "../src/schema.js";
import type { DelegationRequest, ExecutorReport, Task } from "../src/state/types.js";

const request: DelegationRequest = {
  version: 1,
  brain: "claude",
  executor: "codex",
  kind: "implement",
  objective: "Implement the requested contracts",
  reason: "user_requested",
  rationale: "Bounded implementation task",
  scope: { allowedPaths: ["src/config.ts"] },
  acceptance: { criteria: ["Typecheck passes"] },
};
const report: ExecutorReport = {
  status: "completed",
  summary: "Contracts implemented",
  filesChanged: [],
  testsRun: [],
  limitations: [],
  blockedReason: null,
};

describe("computer-use contracts", () => {
  it("defaults to disabled for absent, old and empty computerUse configs", () => {
    const root = mkdtempSync(join(tmpdir(), "duo-cu-config-"));
    try {
      assert.equal(DEFAULT_CONFIG.computerUse.enabled, false);
      assert.equal(loadConfig(root).computerUse.enabled, false);
      mkdirSync(join(root, ".duo"));
      for (const config of [{}, { computerUse: {} }]) {
        writeFileSync(configPath(root), JSON.stringify(config));
        assert.equal(loadConfig(root).computerUse.enabled, false);
      }
      const loaded = loadConfig(root);
      loaded.computerUse.enabled = true;
      assert.equal(loadConfig(root).computerUse.enabled, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only literal boolean enabled and rejects malformed computerUse sections", () => {
    const root = mkdtempSync(join(tmpdir(), "duo-cu-config-"));
    try {
      mkdirSync(join(root, ".duo"));
      for (const enabled of [false, true]) {
        writeFileSync(configPath(root), JSON.stringify({ computerUse: { enabled } }));
        assert.equal(loadConfig(root).computerUse.enabled, enabled);
      }
      const invalid = ["true", "false", 0, 1, null, [], {}].map((enabled) => ({ enabled }));
      for (const computerUse of [...invalid, null, [], true, "true", 1]) {
        writeFileSync(configPath(root), JSON.stringify({ computerUse }));
        assert.throws(() => loadConfig(root), (err: unknown) =>
          err instanceof ConfigError && /computerUse\.enabled/.test(err.message));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves old requests and accepts computer_use with app names or bundle IDs", () => {
    const schema = loadSchema("delegation-request");
    const capability: Capability = "computer_use";
    const cuRequest: DelegationRequest = { ...request, needs: ["code", capability], apps: ["Safari", "com.apple.TextEdit"] };
    const taskFields: Pick<Task, "needs" | "apps"> = { needs: [capability], apps: cuRequest.apps };
    assert.deepEqual(validate(schema, request), []);
    assert.deepEqual(validate(schema, cuRequest), []);
    assert.deepEqual(validate(schema, { ...cuRequest, ...taskFields }), []);
    assert.ok(validate(schema, { ...cuRequest, needs: ["unknown"] }).length > 0);
    assert.deepEqual(validate(schema, { ...cuRequest, apps: Array(20).fill("a".repeat(200)) }), []);
  });

  it("rejects absent, empty, oversized or mistyped app lists and entries", () => {
    const schema = loadSchema("delegation-request");
    for (const apps of ["Safari", null, [1], [null], [""], ["   "], ["a".repeat(201)], Array(21).fill("Safari")]) {
      assert.ok(validate(schema, { ...request, needs: ["computer_use"], apps }).length > 0, JSON.stringify(apps));
    }
    assert.ok(validate(schema, { ...request, needs: ["computer_use"], apps: [] }).length);
    assert.ok(validate(schema, { ...request, needs: ["computer_use"] }).length);
  });

  it("keeps appsUsed optional in bridge reports and validates bounded entries", () => {
    const schema = loadSchema("executor-report");
    assert.deepEqual(validate(schema, report), []);
    for (const appsUsed of [[], ["Safari", "com.apple.TextEdit"], Array(20).fill("a".repeat(200))]) {
      const cuReport: ExecutorReport = { ...report, appsUsed };
      assert.deepEqual(validate(schema, cuReport), []);
    }
    for (const appsUsed of [null, "Safari", [1], [null], [""], ["   "], ["a".repeat(201)], Array(21).fill("Safari")]) {
      assert.ok(validate(schema, { ...report, appsUsed }).length > 0, JSON.stringify(appsUsed));
    }
  });

  it("omits appsUsed from non-CU CLI schemas and requires it in CU CLI schemas", () => {
    const cuSchema = executorSchemaForCli(true);
    assert.ok(cuSchema.required?.includes("appsUsed"));
    assert.deepEqual(validate(cuSchema, { ...report, appsUsed: [] }), []);
    assert.ok(validate(cuSchema, report).length > 0);
    assert.ok(validate(cuSchema, { ...report, appsUsed: [""] }).length > 0);
    for (const schema of [executorSchemaForCli(), executorSchemaForCli(false), cuSchema]) {
      assert.equal(schema.$schema, undefined);
      assert.equal(schema.$id, undefined);
      assert.equal(schema.title, undefined);
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required!].sort(), Object.keys(schema.properties!).sort());
    }
    for (const schema of [executorSchemaForCli(), executorSchemaForCli(false)]) {
      assert.equal(Object.hasOwn(schema.properties!, "appsUsed"), false);
      assert.deepEqual(validate(schema, report), []);
      assert.ok(validate(schema, { ...report, appsUsed: [] }).length > 0);
    }
    assert.deepEqual(validate(loadSchema("executor-report"), report), []);
    assert.deepEqual(validate(loadSchema("executor-report"), { ...report, appsUsed: ["Safari"] }), []);
  });

  it("writes both CLI schema modes and preserves the default for existing callers", () => {
    const dir = mkdtempSync(join(tmpdir(), "duo-cu-schema-"));
    try {
      const defaultPath = writeExecutorSchema(dir);
      assert.deepEqual(JSON.parse(readFileSync(defaultPath, "utf8")), executorSchemaForCli());
      for (const computerUse of [true, false]) {
        const path = writeExecutorSchema(dir, computerUse);
        assert.equal(path, defaultPath);
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), executorSchemaForCli(computerUse));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
