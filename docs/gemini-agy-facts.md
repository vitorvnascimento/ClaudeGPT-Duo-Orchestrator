# Verified `agy` facts (Antigravity CLI 1.5.3, macOS) — 2026-11-22

Task 0 of `docs/superpowers/plans/2026-11-22-gemini-executor.md`. Every fact below was observed with the real `agy` and model `gemini-3.8-flash-low` in a throwaway git repo. Outputs are trimmed; no secrets recorded.

**Gate result: STOP.** `rule-syntax` cannot confine writes to exact targets, and `state-relocation`, `extensions-off` and `auth-signal` are unproven. Per the plan, implementation waits for the owner's decision.

## stdin-form — POSITIVE
`agy -p= --input-format stream-json --output-format stream-json --model <id> [...]` with one NDJSON line on stdin:
`{"event":"user","message":{"role":"user","content":"<prompt>"}}`.
`-p` needs a value (`-p` last → `flag needs an argument: -p`; `-p --model` → "took --model as its prompt"); `-p=` (empty) plus stream-json reads the prompt from stdin. Missing `event` → `stream input message is missing the "event" field`.

## stream-events — POSITIVE
Output events: `init` (`conversation_id`, `model`, `cwd`, `tools` [60 names], `permission_mode`), `step_update` (`step_index`, `state` ACTIVE/DONE/ERROR, `step_type` user_input/agent_response/tool, `text_delta`, `tool_name`, `tool_info.parameters`, `tool_info.error.message`, `usage`), `result` (`conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, `usage`, `denied_actions`, `error`, `finished_reason`).

## settings-merge — POSITIVE (replace)
With `--settings '{"permissions":{"allow":["write_file(ok.txt)"]}}'`, `ls` (allowed in the owner's global settings) was denied: `permission check failed for unsandboxed "ls"`, `denied_actions:[{"action":"command"}]`. Session settings **replace** the owner's `permissions.allow`.

## rule-syntax / deny-rules — NEGATIVE for file-level confinement
- In the default mode and in `--mode accept-edits`, **writes inside the workspace need no permission**: with `allow:["write_file(ok.txt)"]`, `other.txt` and `sub/deep.txt` were also written. `allow` rules do not restrict.
- `deny` works for a **literal** path (relative `other.txt` or absolute) and for bare `*`: `... Matches user-configured deny rule.`
- `deny` wins over `allow`: `deny:["write_file(*)"], allow:["write_file(ok.txt)"]` blocked `ok.txt` too.
- Globs do not match: `*.key`, `sub/*`, `**/*.key`, `sub/**`, `<abs>/sub/*`, `<abs>/sub/**`, `<abs>/**/*.txt` all let the files through.
- Consequence: the session-rules layer can block (a) everything, (b) named existing files, (c) outside the workspace (`allowNonWorkspaceAccess:false`). It **cannot** allow only the authorized target while blocking a new sibling file. The spec's "each layer alone blocks an unauthorized sibling" cannot be met by this layer.

## state-relocation — UNPROVEN
`HOME=<private dir>` relocates everything (`~/.gemini/config`, `~/.gemini/antigravity-cli/{conversations,brain,log,cache,...}`) but loses the login: `Error: Please sign in to view available models.` The login lives in the macOS keychain (`KeyringTokenStorage` strings in the binary) and is apparently tied to config under `~/.gemini`. Env names exist (`ANTIGRAVITY_CONFIG_REL_DIR`, `ANTIGRAVITY_EXECUTABLE_DATA_DIR`) but were not tested.

## extensions-off — UNPROVEN
`init.tools` lists 60 tools, including `browser_*`, `open_browser_url`, `read_url_content`, `search_web`, `call_mcp_tool`, `send_message`, `schedule`, `invoke_subagent`, `define_subagent`, `generate_image`, `run_workflow`. No session flag to disable them was found; which of them are permission-gated in headless mode was not tested. `--disable-slash-commands` only affects slash/skill expansion.

## served-model — NEGATIVE
`init.model` repeats the requested id; no event names the model that served the turn.

## auth-signal — UNPROVEN
No non-secret command or output distinguishing the Google-account login from other credentials was found yet (`AGY_ACCOUNT`, `AGY_ADC_AUTH`, `AGY_BUSINESS_PAYGO_TIER` env names exist in the binary).

---

## Português (resumo)

Fatos verificados no `agy` 1.5.3. Funcionam: prompt por stdin (`-p=` + stream-json com `{"event":"user",...}`), eventos de saída, e `--settings` que substitui (não mescla) a lista de permissões do Vitor. Não funcionam ou não estão provados: as regras de sessão não conseguem limitar a escrita ao arquivo autorizado (dentro da pasta tudo é liberado; `deny` só aceita caminho literal ou `*`, sem glob); mover o estado do `agy` para uma pasta privada perde o login (fica no Keychain); não há como desligar as 60 ferramentas (navegador, web, MCP, mensagens, agendamento, subagentes); o modelo que respondeu não aparece; não há sinal de login sem segredo. Pelo plano, a implementação para aqui até o Vitor decidir.
