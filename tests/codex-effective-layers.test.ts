import { strict as assert } from "node:assert";
import { it } from "node:test";
import { resolveExecutable } from "../src/adapters/resolve.js";
import { codexConflictsFromEffective } from "../src/permissions/auth.js";
import { readEffectiveCodexConfig } from "../src/permissions/codex-effective-config.js";
import { FAKE_CODEX, makeSandbox } from "./helpers.js";

it("config/read: defaults serializados não são chaves explícitas; credenciais e campos desconhecidos continuam bloqueados", async () => {
  const sandbox = makeSandbox();
  try {
    const declared = { name: "Headroom", base_url: "http://127.0.0.1:8787/v1", requires_openai_auth: true, supports_websockets: true };
    const serialized = { ...declared, wire_api: "responses", env_key: null, http_headers: null, env_http_headers: null, query_params: null, supports_standalone_web_search: false };
    const read = (provider: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const env = { ...sandbox.env,
        FAKE_CODEX_CONFIG: JSON.stringify({ model_provider: "headroom", model_providers: { headroom: provider } }),
        FAKE_CODEX_LAYERS: JSON.stringify([{ name: { type: "user" }, config: { model_providers: { headroom: { ...declared, ...extra } } } }]),
      };
      return readEffectiveCodexConfig({ cwd: sandbox.root, env, resolved: resolveExecutable("codex", ["node", FAKE_CODEX], env) });
    };
    const defaults = await read(serialized);
    assert.ok(defaults);
    assert.deepEqual(codexConflictsFromEffective(defaults, true).conflicts, []);
    for (const key of ["env_key", "http_headers", "env_http_headers", "query_params", "future_credential", "supports_standalone_web_search"]) {
      // Explicit keys survive even when Codex's typed result drops unknown fields or serializes null.
      const explicit = await read(serialized, { [key]: "SECRET_MUST_NOT_SURVIVE" });
      assert.ok(explicit);
      assert.ok(codexConflictsFromEffective(explicit, true).conflicts.length, key);
      assert.ok(explicit.providers.headroom!.keys.includes(key));
      assert.doesNotMatch(JSON.stringify(explicit), /SECRET_MUST_NOT_SURVIVE/);
      // A non-null effective credential cannot be hidden by incomplete layer metadata.
      const runtime = await read({ ...serialized, [key]: "SECRET_MUST_NOT_SURVIVE" });
      assert.ok(runtime && codexConflictsFromEffective(runtime, true).conflicts.length, key);
    }
    defaults.providers.headroom!.keys.push("mutated");
    assert.ok(!(await read(serialized))?.providers.headroom!.keys.includes("mutated"), "cache snapshots cannot be changed by callers");
  } finally { sandbox.cleanup(); }
});
