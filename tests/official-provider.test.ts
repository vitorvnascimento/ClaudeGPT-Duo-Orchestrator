import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { resolveExecutable } from "../src/adapters/resolve.js";
import { codexConfigConflicts, codexConflictsFromEffective } from "../src/permissions/auth.js";
import { readEffectiveCodexConfig } from "../src/permissions/codex-effective-config.js";
import { makeSandbox } from "./helpers.js";

const casos: Array<{ nome: string; provider: Record<string, unknown>; toml: string; permitido: boolean }> = [
  { nome: "sem URL", provider: {}, toml: "", permitido: true },
  ...["https://api.openai.com/v1", "https://api.openai.com/v1/", "https://chatgpt.com/backend-api/codex", "https://chatgpt.com/backend-api/codex/"].map((url) => ({ nome: url, provider: { base_url: url }, toml: `base_url = "${url}"`, permitido: true })),
  ...["https://remote.example/v1", "http://127.0.0.1:8787/v1", "https://user@api.openai.com/v1", "https://api.openai.com/v1?x=1", "https://api.openai.com/v1#x", "https://api.openai.com/v1/extra", "https://api.openai.com.evil/v1", "https://chatgpt.com/backend-api"].map((url) => ({ nome: url, provider: { base_url: url }, toml: `base_url = "${url}"`, permitido: false })),
  { nome: "wire_api diferente", provider: { wire_api: "chat" }, toml: 'wire_api = "chat"', permitido: false },
  { nome: "wire_api inválido", provider: { wire_api: 123 }, toml: "wire_api = 123", permitido: false },
  ...["env_key", "experimental_bearer_token", "http_headers", "env_http_headers", "query_params", "auth", "gateway_oauth", "aws", "model_catalog_url", "campo_futuro"].map((key) => ({ nome: key, provider: { [key]: "VALOR_PRIVADO" }, toml: `${key} = "VALOR_PRIVADO"`, permitido: false })),
];

for (const caso of casos) {
  it(`provedor oficial: ${caso.nome}`, async () => {
    const s = makeSandbox();
    try {
      const provider = { name: "OpenAI", requires_openai_auth: true, ...caso.provider };
      s.env.FAKE_CODEX_CONFIG = JSON.stringify({ model_provider: "headroom", model_providers: { headroom: provider } });
      const resolved = resolveExecutable("codex", ["node", join(process.cwd(), "tests/fixtures/fake-codex.mjs")], s.env);
      assert.ok(resolved.ok);
      const effective = await readEffectiveCodexConfig({ cwd: s.root, env: s.env, resolved });
      assert.ok(effective);
      const verdict = codexConflictsFromEffective(effective);
      assert.equal(verdict.conflicts.length === 0, caso.permitido);
      assert.doesNotMatch(JSON.stringify([effective, verdict]), /VALOR_PRIVADO/);
      writeFileSync(join(s.home, ".codex/config.toml"), ['model_provider = "headroom"', "[model_providers.headroom]", 'name = "OpenAI"', "requires_openai_auth = true", caso.toml].join("\n"));
      const fallback = codexConfigConflicts(s.authPaths, s.env);
      assert.equal(fallback.conflicts.length === 0, caso.permitido);
      assert.doesNotMatch(JSON.stringify(fallback), /VALOR_PRIVADO/);
    } finally { s.cleanup(); }
  });
}

for (const auth of [false, undefined, "true", null]) {
  it(`requer autenticação exatamente true: ${String(auth)}`, async () => {
    const s = makeSandbox();
    try {
      const provider = auth === undefined ? {} : { requires_openai_auth: auth };
      s.env.FAKE_CODEX_CONFIG = JSON.stringify({ model_provider: "headroom", model_providers: { headroom: provider } });
      const resolved = resolveExecutable("codex", ["node", join(process.cwd(), "tests/fixtures/fake-codex.mjs")], s.env);
      assert.ok(resolved.ok);
      const effective = await readEffectiveCodexConfig({ cwd: s.root, env: s.env, resolved });
      assert.ok(!effective || codexConflictsFromEffective(effective).conflicts.length > 0);
      const line = auth === undefined ? "" : `requires_openai_auth = ${auth === "true" ? '"true"' : String(auth)}`;
      writeFileSync(join(s.home, ".codex/config.toml"), `model_provider = "headroom"\n[model_providers.headroom]\n${line}\n`);
      assert.ok(codexConfigConflicts(s.authPaths, s.env).conflicts.length);
    } finally { s.cleanup(); }
  });
}

it("tabela inativa real, seleção por perfil e tabelas em projeto", async () => {
  const s = makeSandbox();
  try {
    const provider = { name: "OpenAI", wire_api: "responses", requires_openai_auth: true };
    s.env.FAKE_CODEX_CONFIG = JSON.stringify({ model_provider: "openai", model_providers: { headroom: provider } });
    const resolved = resolveExecutable("codex", ["node", join(process.cwd(), "tests/fixtures/fake-codex.mjs")], s.env);
    assert.ok(resolved.ok);
    const effective = await readEffectiveCodexConfig({ cwd: s.root, env: s.env, resolved });
    assert.ok(effective);
    assert.deepEqual(codexConflictsFromEffective(effective).conflicts, []);
    const project = join(s.root, ".codex/config.toml");
    mkdirSync(join(s.root, ".codex"), { recursive: true });
    writeFileSync(project, '[profiles.work]\nmodel_provider = "headroom"\n[model_providers.headroom]\nname = "OpenAI"\nwire_api = "responses"\nrequires_openai_auth = true\n');
    assert.deepEqual(codexConfigConflicts(s.authPaths, s.env).conflicts, []);
  } finally { s.cleanup(); }
});

it("camadas preservam credenciais explícitas e ignoram somente defaults não explícitos", async () => {
  const s = makeSandbox();
  try {
    const provider = { name: "OpenAI", base_url: null, requires_openai_auth: true, wire_api: "responses", env_key: null, experimental_bearer_token: null, http_headers: null, query_params: null };
    s.env.FAKE_CODEX_CONFIG = JSON.stringify({ model_provider: "headroom", model_providers: { headroom: provider } });
    const resolved = resolveExecutable("codex", ["node", join(process.cwd(), "tests/fixtures/fake-codex.mjs")], s.env);
    assert.ok(resolved.ok);
    for (const [layerProvider, permitido] of [[{ name: "OpenAI", requires_openai_auth: true }, true], [{ name: "OpenAI", requires_openai_auth: true, env_key: null }, false], [{ name: "OpenAI", requires_openai_auth: true, campo_futuro: null }, false], [{ name: "OpenAI", requires_openai_auth: true, base_url: null }, false], [{ name: "OpenAI", requires_openai_auth: true, wire_api: null }, false]] as const) {
      const env = { ...s.env, FAKE_CODEX_LAYERS: JSON.stringify([{ config: { model_providers: { headroom: layerProvider } } }]) };
      const effective = await readEffectiveCodexConfig({ cwd: s.root, env, resolved });
      assert.ok(effective);
      assert.equal(codexConflictsFromEffective(effective).conflicts.length === 0, permitido);
    }
    const semCamadas = await readEffectiveCodexConfig({ cwd: s.root, env: s.env, resolved });
    assert.ok(semCamadas);
    assert.ok(codexConflictsFromEffective(semCamadas).conflicts.length);
    const invalidas = await readEffectiveCodexConfig({ cwd: s.root, env: { ...s.env, FAKE_CODEX_LAYERS: JSON.stringify([{ config: null }]) }, resolved });
    assert.equal(invalidas, null);
    const divididas = await readEffectiveCodexConfig({ cwd: s.root, env: { ...s.env, FAKE_CODEX_LAYERS: JSON.stringify([
      { config: { model_providers: { headroom: { env_key: "VALOR_PRIVADO" } } } },
      { config: { model_providers: { headroom: { requires_openai_auth: true } } } },
    ]) }, resolved });
    assert.ok(divididas);
    assert.ok(codexConflictsFromEffective(divididas).conflicts.length);
    assert.doesNotMatch(JSON.stringify(divididas), /VALOR_PRIVADO/);
    for (const campo of [{ base_url: "https://remote.example/v1" }, { wire_api: "chat" }]) {
      const incompleta = await readEffectiveCodexConfig({ cwd: s.root, env: { ...s.env,
        FAKE_CODEX_CONFIG: JSON.stringify({ model_provider: "headroom", model_providers: { headroom: { requires_openai_auth: true } } }),
        FAKE_CODEX_LAYERS: JSON.stringify([{ config: { model_providers: { headroom: { requires_openai_auth: true, ...campo } } } }]),
      }, resolved });
      assert.ok(incompleta);
      assert.ok(codexConflictsFromEffective(incompleta).conflicts.length);
    }
  } finally { s.cleanup(); }
});

it("fallback mantém precedência e erros das camadas system, usuário e projeto", () => {
  const s = makeSandbox();
  try {
    const system = join(s.tmp, "system.toml");
    const user = join(s.home, ".codex/config.toml");
    const project = join(s.root, ".codex/config.toml");
    s.authPaths.codexSystemConfig = system;
    mkdirSync(join(s.root, ".codex"), { recursive: true });
    writeFileSync(system, 'model_provider = "headroom"\n[model_providers.headroom]\nrequires_openai_auth = true\nbase_url = "https://api.openai.com/v1"\n');
    writeFileSync(user, '[model_providers.headroom]\nwire_api = "responses"\n');
    writeFileSync(project, '[profiles.work]\nmodel_provider = "headroom"\n');
    assert.deepEqual(codexConfigConflicts(s.authPaths, s.env).conflicts, []);
    writeFileSync(system, 'model_provider = "headroom"\n[model_providers.headroom]\nrequires_openai_auth = true\nenv_key = "VALOR_PRIVADO"\n');
    assert.ok(codexConfigConflicts(s.authPaths, s.env).conflicts.length);
    writeFileSync(system, 'model_provider = "headroom"\n[model_providers.headroom]\nrequires_openai_auth = true\nbase_url = 1\n');
    assert.ok(codexConfigConflicts(s.authPaths, s.env).conflicts.length);
    writeFileSync(system, 'model_provider = "headroom"\n[model_providers.headroom]\nrequires_openai_auth = true\nbase_url = "https://remote.example/v1"\n');
    writeFileSync(project, '[model_providers.headroom]\nbase_url = "https://api.openai.com/v1"\n');
    assert.ok(codexConfigConflicts(s.authPaths, s.env).conflicts.length);
  } finally { s.cleanup(); }
});

it("fallback conserva credenciais e erros em overlays e recusa formas TOML não suportadas", () => {
  const s = makeSandbox();
  try {
    const user = join(s.home, ".codex/config.toml");
    const project = join(s.root, ".codex/config.toml");
    mkdirSync(join(s.root, ".codex"), { recursive: true });
    writeFileSync(user, 'model_provider = "headroom"\n[model_providers.headroom]\nrequires_openai_auth = true\nenv_key = "VALOR_PRIVADO"\n');
    writeFileSync(project, '[model_providers.headroom]\nrequires_openai_auth = true\n');
    assert.ok(codexConfigConflicts(s.authPaths, s.env).conflicts.length);
    writeFileSync(user, 'model_provider = "headroom"\n[model_providers.headroom]\nrequires_openai_auth = true\n');
    for (const linha of ['[model_providers.headroom.http_headers]\nAuthorization = "VALOR_PRIVADO"', '[model_providers.headroom]\nquery_params.key = "VALOR_PRIVADO"', '[model_providers.headroom]\nbase_url = 123', 'model_providers.headroom.env_key = "VALOR_PRIVADO"', 'x = "sem fechamento']) {
      writeFileSync(project, linha);
      const result = codexConfigConflicts(s.authPaths, s.env);
      assert.ok(result.conflicts.length, linha);
      assert.doesNotMatch(JSON.stringify(result), /VALOR_PRIVADO/);
    }
  } finally { s.cleanup(); }
});
