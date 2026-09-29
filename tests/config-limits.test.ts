import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConfigError, configPath, DEFAULT_CONFIG, loadConfig } from "../src/config.js";

describe("limites numéricos da config", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function writeLimits(limits: Record<string, unknown>): string {
    root ??= mkdtempSync(join(tmpdir(), "duo-config-limits-"));
    mkdirSync(join(root, ".duo"), { recursive: true });
    writeFileSync(configPath(root), JSON.stringify({ limits }));
    return root;
  }

  it("aceita os defaults sem arquivo e com overrides vazios", () => {
    root = mkdtempSync(join(tmpdir(), "duo-config-limits-"));
    assert.deepEqual(loadConfig(root), DEFAULT_CONFIG);
    assert.deepEqual(loadConfig(writeLimits({})), DEFAULT_CONFIG);
  });

  const ranges = [
    { field: "timeoutSec", minimum: 1, maximum: 86400 },
    { field: "acceptanceTimeoutSec", minimum: 1, maximum: 86400 },
    { field: "maxOutputBytes", minimum: 1, maximum: 1024 * 1024 * 1024 },
    { field: "maxPromptBytes", minimum: 1, maximum: 1024 * 1024 * 1024 },
    { field: "maxSnapshotBytes", minimum: 1, maximum: 1024 * 1024 * 1024 },
  ] as const;

  for (const [field, value] of [
    ["timeoutSec", 7200],
    ["acceptanceTimeoutSec", 7200],
    ["maxSnapshotBytes", 209715200],
  ] as const) {
    it(`preserva o valor legado ${value} em limits.${field}`, () => {
      assert.equal(loadConfig(writeLimits({ [field]: value })).limits[field], value);
    });
  }

  for (const { field, minimum, maximum } of ranges) {
    it(`aceita as fronteiras de limits.${field}`, () => {
      for (const value of [minimum, maximum]) {
        assert.equal(loadConfig(writeLimits({ [field]: value })).limits[field], value);
      }
    });

    for (const [label, value] of [
      ["zero", 0],
      ["negativo", -5],
      ["string", "abc"],
      ["string numérica", "10"],
      ["NaN serializado como null", NaN],
      ["fracionário", minimum + 0.5],
      ["acima do teto", maximum + 1],
      ["overflow de timer", 2_147_484],
    ] as const) {
      if (label === "overflow de timer" && field !== "timeoutSec" && field !== "acceptanceTimeoutSec") continue;
      it(`rejeita ${label} em limits.${field}`, () => {
        assert.throws(() => loadConfig(writeLimits({ [field]: value })), (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.ok(error.message.includes(`limits.${field}`));
          return true;
        });
      });
    }

  }

  it("acumula todos os campos inválidos no mesmo ConfigError", () => {
    const limits = Object.fromEntries(ranges.map(({ field }) => [field, 0]));
    assert.throws(() => loadConfig(writeLimits(limits)), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      for (const { field } of ranges) assert.ok(error.message.includes(`limits.${field}`));
      return true;
    });
  });
});
