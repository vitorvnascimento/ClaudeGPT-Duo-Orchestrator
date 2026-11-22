# Verified `agy` facts (Antigravity CLI 1.5.3, macOS) — 2026-11-22

Task 0 of `docs/superpowers/plans/2026-11-22-gemini-executor.md`. Redacted native transcripts: `tests/fixtures/agy/*.ndjson` (paths replaced by `/WORKSPACE`, `/SCRATCH`, `/HOME`). Not yet captured: quota and auth error streams, a schema-valid report. Every fact below was observed with the real `agy` and model `gemini-3.8-flash-low` in a throwaway git repo. Outputs are trimmed; no secrets recorded.

**Gate result (second round, same day): candidate PASS on macOS, with a design change.** The containment the spec asked of "session rules" is achievable, but through a workspace **PreToolUse hook** plus a **private HOME**, not through `--settings` permission rules. The spec and plan must be amended before Task 1 (see "Design consequences"). The first round (STOP) is kept below each fact where it still matters.

## verified versions
None yet. 1.5.3 becomes eligible only after the amended Task 0 checks are written into the battery and pass (the list holds exact version + platform pairs).

## stdin-form — POSITIVE
`agy -p= --input-format stream-json --output-format stream-json --model <id> [...]` with one NDJSON line on stdin:
`{"event":"user","message":{"role":"user","content":"<prompt>"}}`.
`-p` needs a value (`-p` last → `flag needs an argument: -p`; `-p --model` → "took --model as its prompt"); `-p=` (empty) plus stream-json reads the prompt from stdin. Missing `event` → `stream input message is missing the "event" field`.

## stream-events — POSITIVE
Output events: `init` (`conversation_id`, `model`, `cwd`, `tools` [60 names], `permission_mode`), `step_update` (`step_index`, `state` ACTIVE/DONE/ERROR, `step_type` user_input/agent_response/tool, `text_delta`, `tool_name`, `tool_info.parameters`, `tool_info.error.message`, `usage`), `result` (`conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, `usage`, `denied_actions`, `error`, `finished_reason`). Denials can appear only as tool `ERROR` steps with an empty `denied_actions` (`deny-wins-over-allow.ndjson`, `hook-gate-allows-only-target.ndjson`).

## hook-gate — POSITIVE (replaces rule-syntax as the client layer)
`agy` loads `.agents/hooks.json` from the workspace. Format: top-level keys are hook names; `PreToolUse` takes `[{"matcher": "*", "hooks": [{"type": "command", "command": "...", "timeout": N}]}]`. The hook receives JSON on stdin (`toolCall.name`, `toolCall.args`, `modelName`, `cwd`, `workspacePaths`, `conversationId`, `hookEventName`) and prints `{"decision": "allow"|"deny"|"ask"|"force_ask", "reason": "..."}`.
- With a hook that allows only `write_file` to `<ws>/ok.txt`: `ok.txt` written; `other.txt`, `run_command pwd` and `search_web` each failed with `tool call denied by pre-tool hook: duo-hook` (`hook-gate-allows-only-target.ndjson`). Same result under a private HOME.
- **Fails closed**, three separate cases, no file written in any: exit 1 → `JSON hook ... failed: command failed: exit status 1` (`hook-crash-fails-closed.ndjson`); exit 0 with non-JSON output → `failed to unmarshal result from hook ... via protojson` (`hook-invalid-json-fails-closed.ndjson`); timeout → `signal: killed` (`hook-timeout-fails-closed.ndjson`).
- **Observed coverage** (calls actually attempted and denied): `write_file`, `run_command`, `search_web` (`hook-gate-allows-only-target.ndjson`), `invoke_subagent` (step `subagent` → `ERROR`, `subagents: []`, none started) and `send_message` (`hook-denies-subagent-and-message.ndjson`). **Not verified**: `schedule`, `run_workflow`, `swarm`, `call_mcp_tool`/MCP tools, browser tools. They stay unverified until a call is shown denied or the tool is shown unavailable; the bridge's gate denies by default, but that is a design intent, not evidence.
- Risk to handle in the design: the workspace's own `.agents/` (hooks, plugins, skills, rules, agents) is loaded too. The gate must live in a **bridge-controlled disposable workspace** for **every** Gemini task, reads included (`delegate.ts` defaults to `in-place`; installing `.agents/` in the user's checkout, or running with the repository's own hooks, are both unacceptable). The bridge replaces `.agents/` there and denies writes to it.

## permission rules (`--settings`) — secondary
- Documented kinds (binary help text): `command(<prefix>)`, `read_file(<abs>)`, `write_file(<abs>)`, `mcp(<server>/<tool>)`, `read_url(<domain>)`, `execute_url(<domain>)`.
- `deny` matches **path-component prefixes** (`write_file(<abs>/sub)` blocked `sub/deep.txt` and new `sub/new/x.txt`; `write_file(<abs>/ot)` did **not** block `other.txt`), literal files, and bare `*`. `command(<prefix>)` deny blocks `ls` and `ls -la`; `command(*)` blocks all commands.
- `allow` does not restrict writes inside the workspace (they need no permission). Globs (`*.key`, `sub/**`, `<abs>/**/*.txt`) never matched. `deny` wins over `allow`.
- `search_web` ran despite `search_web(*)`-style denies; these rules do not cover it. Unknown keys (`hooks`, `disabledTools`, `enabledTools`) are rejected: `--settings: unknown setting "..."`.

## settings-merge — UNPROVEN, now moot
In the default mode `ls` ran both without `--settings` and with `allow:[]` (control pair). With a private HOME the owner's settings are never loaded, so whether `--settings` replaces them no longer matters.

## state-relocation — POSITIVE under the intended profile (private HOME + Keychains link)
`HOME=<private dir>` alone loses the login. `HOME=<private dir>` with `<private dir>/Library/Keychains` → symlink to the real `~/Library/Keychains` keeps the login (`agy models` lists models; a full run succeeds). Linking `Library/Application Support/Antigravity` instead does not. With it: the owner's `~/.gemini/antigravity-cli/conversations` count stayed 65 → 65 and the private dir got 1 conversation. `ANTIGRAVITY_CONFIG_REL_DIR` and `ANTIGRAVITY_EXECUTABLE_DATA_DIR` had no visible effect.
Under a `sandbox-exec` profile that allows writes only to the workspace, the private HOME, a private `TMPDIR`, `/dev/null|tty|fd` and `/private/var/folders/` (the real `~/Library/Keychains` is **not** writable): `agy models` and a full run both succeeded (`private-home-under-sandbox-profile.ndjson`), and `find ~/.gemini -newer <marker> -type f` returned **nothing** — no owner conversation, setting, log, cache or daemon file changed.

## extensions — PARTIAL
- **Owner instructions**: under the private HOME the model answered `Não.` when asked about the `[Certo]/[Provável]` instruction (`private-home-no-user-instructions.ndjson`). This is a model self-report about instructions only.
- **Executable extensions** (loader trace, independent of the model): the private `config.json` ends up with exactly one plugin, the built-in `swarm` (`Seeded plugin enablement for 1 plugin(s)`), and there is no `mcp_config.json`, so none of the owner's plugins, MCP servers or user hooks are configured there. The built-in `swarm` plugin is enabled by default; the bridge must pre-seed `plugins.swarm.enabled=false` (to verify) and keep relying on the gate. Built-in tools are still declared (60 in `init`; the model itself listed `read_file, run_command, manage_task, send_message, schedule, invoke_subagent, define_subagent, manage_subagents, write_file, edit_file, search_web, run_workflow, swarm, ask_question, list_resources, read_resource`), but every call passes the PreToolUse hook, which denies all of them except the allowed file operations.

## auth-signal — login method POSITIVE, entitlement UNVERIFIED
In the private HOME's `.gemini/antigravity-cli/log/*.log`: `ChainedAuth: authenticated via keyring (effective: keyring)` and `applyAuthResult: email=<redacted>, authMethod=consumer`. `authMethod=consumer` identifies the **login method** (personal Google account from the keyring); it does **not** prove a paid subscription entitlement. An **inference-free preflight** gives a fresh signal: `agy models` under the private HOME (with an emptied `log/` dir) wrote exactly one `authMethod=consumer` and one `authenticated via keyring (effective: keyring)` line before any model call. Entitlement stays covered only by the owner's acknowledgment (`billing.acknowledgeUnverifiableExtraUsage.gemini`), not by the gate. The binary also supports `GEMINI_API_KEY`, `AGY_ADC_AUTH` (Application Default Credentials) and enterprise gateways, so the bridge must require `authMethod=consumer` and `effective: keyring`, and must never persist the log line (it contains the email).

## plan-mode — INCONCLUSIVE, not needed
With `--mode plan`, asked to write `other.txt` and run `pwd`, the model wrote only its own `plan.md` under the private `brain/` dir and attempted neither (`plan-mode-writes-plan-artifact.ndjson`). Read-only tasks rely on the hook denying every write instead.

## served-model — PARTIAL
`init.model` repeats the requested id. The hook input carries `modelName` (the changelog says hooks get "the name of the model actually in use"); in every run it equalled the requested id. It is session-level evidence, not per-turn proof.

---

## Design consequences (to amend spec and plan before Task 1)
1. **Client layer = workspace PreToolUse hook**, not `--settings` rules, in a bridge-controlled disposable worktree for **every** Gemini task (reads included). The bridge writes `.agents/hooks.json` plus a gate script into the disposable worktree (replacing any project `.agents/`), with the allowlist of authorized targets; the gate fails closed. `.agents/` is excluded from the patch and denied for writes by both layers.
2. **Private HOME per chain** with `Library/Keychains` linked and `plugins.swarm.enabled=false` pre-seeded; preflight `agy models` with an emptied `log/` must yield fresh `authMethod=consumer` + `effective: keyring` before any model call. The OS profile allows writes to that private HOME only (not to the real `~/.gemini`).
3. Gemini **write tasks always run in a worktree** (already in the spec), because the hook needs a workspace the bridge controls.
4. `--settings` keeps `allowNonWorkspaceAccess:false` and `command(*)` deny as an extra guard; it is no longer the containment mechanism.
5. Non-macOS read-only: hook alone (one client layer), still subject to a real per-platform check before enabling.

## Português (resumo)

Segunda rodada da investigação (mesmo dia) muda o resultado. A trava do cliente que as regras de `--settings` não davam, um **hook PreToolUse do workspace** (`.agents/hooks.json`) dá: liberou só o arquivo autorizado e negou o vizinho, o comando, a busca web, o subagente e a mensagem, e **falha fechado** se o script quebra, devolve lixo ou estoura o tempo. Ainda não verificados: `schedule`, `run_workflow`, `swarm`, MCP e navegador. Toda tarefa Gemini, inclusive leitura, precisa rodar numa worktree do duo. Um **HOME privado** com `Library/Keychains` ligado ao real mantém o login, isola o estado (sob o perfil do sandbox, nenhum arquivo do seu `~/.gemini` mudou), não carrega os seus plugins e MCPs (só o plugin embutido `swarm`, que o duo deve desligar) e, num teste sem inferência (`agy models`), mostra `authMethod=consumer`: prova o tipo de login, não que a assinatura está paga. O modo `plan` sozinho foi inconclusivo, mas o hook o dispensa. O modelo servido aparece só como `modelName` no hook (nível de sessão). Antes da tarefa 1, o spec e o plano precisam trocar o mecanismo: hook + HOME privado no lugar das regras de `--settings`.
