import { strict as assert } from "node:assert";
// (regressão da validação real no fim do arquivo: sandbox do Codex sem config/read)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { codexConfigConflicts, codexMcpServerNames } from "../src/permissions/auth.js";

// Valid TOML: each escaped triple quote stays inside its multiline string.
export const MASKED_REMOTE = [
  'model_provider = "remote"',
  'developer_instructions = """',
  '\\"""',
  'model_provider = "openai"',
  '"""',
  'instructions = """',
  '\\"""',
  'model_provider = "openai"',
  '"""',
  '[model_providers.remote]',
  'base_url = "https://remote.example/v1"',
  'requires_openai_auth = true',
].join("\n");

for (const [name, toml, mcp] of [
  ["rodada 17: duas strings multilinha com aspas escapadas", MASKED_REMOTE, false],
  ["fallback recusa até model_provider multilinha oficial", 'model_provider = """openai"""', false],
  ["fallback recusa MCP inline", 'mcp_servers = { x = { command = "x" } }', true],
  ["fallback recusa tabela MCP quoted", '["mcp_servers".x]\ncommand = "x"', true],
] as const) {
  it(name, () => {
    const root = mkdtempSync(join(tmpdir(), "duo-fallback-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), toml);
      const paths = { home, projectRoot: root, claudeManagedSettings: [] };
      assert.ok(codexConfigConflicts(paths, {}, true).conflicts.length, name);
      if (mcp) assert.ok(codexMcpServerNames({}, home, root).unsupported.length, name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
