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
- **Observed coverage** (calls actually attempted and denied): `write_file`, `run_command`, `search_web` (`hook-gate-allows-only-target.ndjson`), `send_message` (`hook-denies-subagent-and-message.ndjson`), and `invoke_subagent` with a **matching hook decision**: the gate log recorded `{"tool":"invoke_subagent","decision":"deny"}` and the stream shows the `subagent` step in `ERROR` with no child (`exact-profile-hook-decisions.jsonl`, `exact-profile-hook-and-os.ndjson`). In the earlier `hook-denies-subagent-and-message.ndjson` the subagent `ERROR` carries no reason, so that file alone does not show which layer stopped it. **Not verified**: `schedule`, `run_workflow`, `swarm`, `call_mcp_tool`/MCP tools, browser tools. They stay unverified until a call is shown denied or the tool is shown unavailable; the bridge's gate denies by default, but that is a design intent, not evidence.
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
- **Probe profile** (broader: whole workspace, private HOME, private `TMPDIR`, `/dev/null|tty|fd`, `/private/var/folders/`; the real `~/Library/Keychains` not writable): `agy models` and a full run succeeded (`private-home-under-sandbox-profile.ndjson`), and `find ~/.gemini -newer <marker> -type f` returned nothing.
- **Exact spec §5 profile** (writes only to the literal target `$WS/ok.txt`, the private HOME, the private `TMPDIR`, `/dev/null`, `/dev/tty`, `/dev/fd/*`; no workspace subpath, no `/private/var/folders/`): `agy models` listed models; a full run wrote `ok.txt`; with the OS layer alone (no hook) the sibling failed with `operation not permitted` (`exact-profile-os-only.ndjson`); with hook + OS the sibling was denied by the hook first (`exact-profile-hook-and-os.ndjson`). Recipe: `tests/fixtures/agy/probe/README.md`.
- A gate whose log path is outside the OS-writable set crashes and therefore denies every call, including the authorized write (`hook-unwritable-log-fails-closed.ndjson`): the gate's own state must live in the private HOME.

## extensions — PARTIAL
- **Owner instructions**: under the private HOME the model answered `Não.` when asked about the `[Certo]/[Provável]` instruction (`private-home-no-user-instructions.ndjson`). This is a model self-report about instructions only.
- **Executable extensions** (loader trace, independent of the model): the private `config.json` ends up with exactly one plugin, the built-in `swarm` (`Seeded plugin enablement for 1 plugin(s)`), and there is no `mcp_config.json`, so none of the owner's plugins, MCP servers or user hooks are configured there. The built-in `swarm` plugin is enabled by default; the bridge must pre-seed `plugins.swarm.enabled=false` (to verify) and keep relying on the gate. Built-in tools are still declared (60 in `init`; the model itself listed `read_file, run_command, manage_task, send_message, schedule, invoke_subagent, define_subagent, manage_subagents, write_file, edit_file, search_web, run_workflow, swarm, ask_question, list_resources, read_resource`), and the wildcard matcher only shows what the hook denies **if invoked**. Hook coverage is established only for the calls listed under hook-gate; for `schedule`, `run_workflow`, `swarm`, MCP and browser tools it is **unverified**, so executable-extension containment stays unverified until each is shown unavailable or denied by the hook. This blocks the hook-only non-macOS path until then.

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

## Third round (2026-11-22, evening) — remaining tools

- **schedule** — the agy `schedule` tool sets timers and recurring jobs *inside the agent session* (changelog: shown in `/tasks`, "timers the agent sets", "recurring cron schedules created with the agent's schedule tool"); account-level "scheduled automations" are a separate sidecar feature. In the private HOME the worst case is a timer in a disposable conversation. Probe: the call was attempted and denied by the duo hook.
- **MCP** — with an inert MCP server configured in the private HOME (`tests/fixtures/agy/fake-mcp.mjs`), the model calls `call_mcp_tool`. agy itself denies it in headless mode (`permission check failed for mcp "duoprobe/echo"`). With that permission allowed (`mcp(duoprobe/echo)`), only the duo hook remains, and it denied the call; the server logged **0** `tools/call`.
- **Browser** — the 23 `browser_*` tools are declared in `init.tools`, but neither they nor `browser_subagent` are exposed to the model in headless mode (asked explicitly, the model reports them unavailable and no browser step occurs). Any browser step would pass the same name-agnostic hook (default deny).
- Hook coverage observed (attempted and denied): `write_file` (sibling/outside/denied descendant), `run_command`, `search_web`, `send_message`, `invoke_subagent`, `run_workflow`, `swarm`, `call_mcp_tool`, `schedule`.

### Português
`schedule` cria timers dentro da sessão do agente (não automações da conta) e foi negado pelo hook. MCP: com um servidor inerte e a permissão do agy liberada, só o hook ficou no caminho e negou; o servidor recebeu 0 chamadas. Navegador: as ferramentas existem no init, mas não são expostas ao modelo no modo headless; nenhum passo de navegador ocorreu.

## Version note (2026-11-22)

`agy` updated itself from 1.5.3 to **1.5.14** at 13:28 the same day (its own updater). The morning spike ran on 1.5.3; every real battery run (`docs/evidencias/gemini-battery-2026-11-22.json` and later) ran on **1.5.14**, and the schedule semantics come from the 1.5.14 changelog. The candidate verified pair is therefore `1.5.14` on `darwin`. Because the shared binary auto-updates, the duo will refuse Gemini after any update until the battery passes again on the new version.

Browser: in headless 1.5.14 the browser tools are declared but never exposed to the model, and `browserEnabled` is not a session setting, so the browser probe cannot be exercised at runtime (inconclusive by design).

### Português
O `agy` se atualizou sozinho de 1.5.3 para 1.5.14 às 13:28; toda a bateria real rodou na 1.5.14, que é o par candidato a verificado (1.5.14, darwin). Como o binário compartilhado se atualiza sozinho, o duo recusa o Gemini depois de cada atualização até a bateria passar de novo. Navegador: no headless da 1.5.14 as ferramentas não são expostas ao modelo e não há configuração de sessão para ligá-las, então a sonda não tem como ser exercitada.

## Release (2026-11-22, evening)

Battery on `agy` 1.5.14 with `gemini-3.8-flash-low` after the catalog went back to Google models only: 13/14 pass (`docs/evidencias/gemini-battery-2026-11-22-v5.json`). P-browser stayed inconclusive (23 browser tools in `init`, no browser step even when asked explicitly). The owner accepted it as a documented limitation; `GEMINI_VERIFIED` is now `[{ version: "1.5.14", platform: "darwin" }]`.

### Português
Bateria no `agy` 1.5.14 com `gemini-3.8-flash-low`, depois do catálogo voltar a só modelos Google: 13/14 (`docs/evidencias/gemini-battery-2026-11-22-v5.json`). O P-browser ficou inconclusivo (23 ferramentas de navegador no `init`, nenhum passo de navegador mesmo pedido explicitamente). O dono aceitou como limitação documentada; `GEMINI_VERIFIED` passa a `[{ version: "1.5.14", platform: "darwin" }]`.
