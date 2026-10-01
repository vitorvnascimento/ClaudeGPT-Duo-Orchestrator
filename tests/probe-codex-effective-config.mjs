// Manual, read-only validation after npm run build. No inference or account methods.
// Run outside the Codex sandbox: node tests/probe-codex-effective-config.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEffectiveCodexConfig } from "../dist/src/permissions/codex-effective-config.js";
import { childEnv, codexConflictsFromEffective } from "../dist/src/permissions/auth.js";
import { resolveExecutable } from "../dist/src/adapters/resolve.js";
import { CodexAdapter } from "../dist/src/adapters/codex.js";
import { probe, CODEX_EXEC_FLAGS } from "../dist/src/adapters/capabilities.js";
import { DEFAULT_CONFIG } from "../dist/src/config.js";

const cwd = process.cwd(), env = childEnv(process.env).env;
const resolved = resolveExecutable("codex", undefined, env);
const effective = await readEffectiveCodexConfig({ cwd, env, resolved });
if (!resolved.ok || !effective) {
  console.log("NOT_RUN: config/read indisponível; configuração real não verificada.");
  process.exitCode = 1;
} else {
  const artifactsDir = await mkdtemp(join(tmpdir(), "duo-config-plan-"));
  try {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.executors.codex.ignoreUserConfig = false;
    cfg.executors.codex.disableUserExtensions = true;
    const caps = probe(resolved, ["exec", "--help"], CODEX_EXEC_FLAGS, env);
    const plan = new CodexAdapter().plan({ resolved, caps, cfg, cwd, kind: "review", prompt: "", writableAbs: [],
      denyGlobs: [], acceptanceArgv: [], needs: [], model: null, resumeSessionId: null, artifactsDir, env }, effective);
    const enabled = codexConflictsFromEffective(effective, true);
    const disabled = codexConflictsFromEffective(effective, false);
    const overrides = plan.args.filter((arg) => /^mcp_servers\.[A-Za-z0-9_-]+\.enabled=false$/.test(arg));
    console.log(JSON.stringify({ providerNames: Object.keys(effective.providers), mcpNames: effective.mcpServers,
      allowLoopbackProxyTrue: enabled.conflicts, allowLoopbackProxyFalse: disabled.conflicts, overrides }, null, 2));
    if (enabled.conflicts.length || overrides.length !== effective.mcpServers.length) process.exitCode = 1;
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
}
