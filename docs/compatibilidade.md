# Observed compatibility matrix

**English** · [Português](#português)

Validated in September 2026 on a Mac with Apple Silicon, Node 22.22, and Git 2.54, with the official CLIs logged in through subscriptions (Claude Pro/Max and ChatGPT). Windows and Linux were not tested.

## Tested versions

| Item | Version | Note |
| --- | --- | --- |
| Claude Code (CLI) | 2.1.114 → **2.1.283** | Opus 5.5 (`claude-opus-5-5`) requires **2.1.280 or newer**; run `claude update` |
| Codex (CLI) | **0.157.1** | Installed with `npm install -g @openai/codex` |
| Node.js | 22.22.2 | Minimum required: 22.12 |
| VS Code extensions | Claude Code and Codex | The bridge uses the **CLIs** on PATH, not the binaries bundled in the extensions (which are not an integration contract) |

Environment findings that affect the bridge (and how it handles them):

- **User hooks and plugins run in the executor.** In Claude, `--setting-sources user` keeps user hooks and plugins (not project ones). In Codex, the bridge uses `--disable hooks --disable plugins` by default because hooks from a plugin (Ruflo) wrote files to the project during a real delegation.
- **Other coordinators** (Ruflo, OmniRoute, and so on) may be installed. `duo doctor` warns; do not use two autonomous coordinators in the same session. A custom `model_provider` in Codex blocks delegation (subscription-only profile).
- **`sandbox_workspace_write.network_access=true` in `~/.codex/config.toml`** does not affect the executor: the bridge forces `false`.
- **Broken user hooks** (missing script) appear on the executor's stderr but do not prevent execution.

## Claude Code 2.1.114 (English)

| Feature | Status |
| --- | --- |
| `-p`, `--output-format stream-json`, `--verbose`, `--json-schema` | Present and **accepted in a real run**; `structured_output` arrives in the stream's `result` event |
| `--tools`, `--allowedTools` (`Edit(//abs)`), `--disallowedTools`, `--permission-mode dontAsk` | Present and accepted; the real `system/init` showed `permissionMode: dontAsk` and only the requested tools (+ `StructuredOutput`) |
| `--setting-sources user`, `--strict-mcp-config`, `--disable-slash-commands`, `--append-system-prompt` | Accepted; `mcp_servers: []` in the real init |
| `--permission-prompts` | Absent in 2.1.114; **present in 2.1.283** and used as `none` (execution without human approval; Claude does not repeat denied actions) |
| `claude-opus-5-5` | **2.1.114 refuses** with `claude_code_version_too_old` ("version 2.1.280 or newer is required"), in an `is_error` envelope with exit 0. **2.1.283 accepts** (`modelUsage: claude-opus-5-5`). The bridge classifies the error as `model_unavailable` and suggests `claude update` |
| `--bare` | Present; **never used** |
| `rate_limit_event` event | **Observed in the real stream** (not described on the consulted headless page): `five_hour` window, `resetsAt`, `overageStatus`, `isUsingOverage`. The bridge records it as a native post-execution observation |
| Effective model | With `model: "opus"` in the user's settings, 2.1.114 resolved to **`claude-opus-4-7`** (not Opus 5.5). For another executor model, update the CLI (`claude update`) or pass `model` in the request |

## Codex 0.157.1 (English)

| Feature | Status |
| --- | --- |
| `codex exec --json`, `--sandbox`, `--cd`, `--output-schema`, `--output-last-message`, `--config`, `--model`, `--ignore-user-config` | Present in `exec --help` and **accepted in a real run** |
| Prompt through stdin with `-` | Accepted |
| Real JSONL events | `thread.started`, `turn.started`, `item.started/completed` (`command_execution`, `file_change`, `agent_message`, `error`), `turn.completed`. **No unknown event** for the parser |
| Real `usage` | `input_tokens`, `cached_input_tokens`, **`cache_write_input_tokens`** (outside the consulted docs), `output_tokens`, `reasoning_output_tokens`. The bridge preserves all numeric fields |
| Effective model | Not reported in JSONL. The bridge reads the rollout from the session itself (`$CODEX_HOME/sessions/**/rollout-*-<thread>.jsonl`) and records the model with `reportedVia: codex-rollout` |
| `codex exec resume` | The real `resume --help` **does not accept `--sandbox` or `--cd`**. The bridge uses `exec resume --json --config sandbox_mode="…" … <id> -`, with the directory supplied by the process cwd. **Real resumption validated** (E2E T5) |
| Real executor warning | `Exceeded skills context budget … additional skills were not included`: happens in environments with many installed skills. This increases consumption and, with Codex as the brain, **the `duo-delegate` skill may not be discovered implicitly**: invoke `$duo-delegate` explicitly |
| `codex mcp-server` | Not used (removed) |
| `codex app-server` | For the observed 0.157.1 contract, used **only to discover models** (`model/list`, `modelProvider/capabilities/read`, stable-surface methods); current quota reads are covered in phase 3 below, and execution continues through `codex exec` |

## Model discovery (`duo models`)

The bridge uses the sources below, which **do not consume inference** and are cached in `.duo/models.json` for 6 h, keyed by CLI versions (1 h when a source is degraded). Account identification (email, organization) and server notifications are discarded.

| Source | How | Observed on 26/09/2026 |
| --- | --- | --- |
| Claude | `claude -p --input-format stream-json` + `control_request` `initialize` (the same mechanism as the Agent SDK's `supportedModels()`); the response includes `models` | 10 models: `claude-opus-5-5` (default/recommended), `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5-20251001`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`. Response in ~1.5 s |
| Codex (primary) | `codex app-server` (JSON-RPC over stdio): `initialize` → `initialized` → `model/list` (paginated by `nextCursor`) → `modelProvider/capabilities/read`. **Stable surface** of the protocol used by the VS Code extension and app | 7 visible (2 hidden ignored): `gpt-6-astra` (`isDefault`), `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol/terra/luna`, `gpt-5.5` (`upgradeInfo` → `gpt-5.6-sol`, retirement on 14/10/2026). `imageGeneration: true`. Response in ~0.5 s |
| Codex (fallback) | `codex debug models` + `codex features list` | Same 7 models. **Debug command, without a contract**: used only if app-server fails or changes format, and marked as "fragile fallback" |
| Last good catalog | Previous `.duo/models.json`, up to 30 days | Used if all sources for an account fail; marked as stale, without blocking models outside the list |
| Config | `routing.candidates` | Last resort |

**Inside the Codex sandbox** (when the Codex brain runs `duo models`/`duo recommend`), the app-server does not start: it needs to write `~/.codex/installation_id` and `~/.codex/tmp/arg0`, which are read-only there (observed with `codex sandbox -P :workspace --log-denials`). The bridge jumps directly to `debug models`, marks the catalog as obtained in the sandbox, and rebuilds it from the stable source as soon as it runs outside it (`duo delegate` always runs outside).

Each response is validated (required fields and types); unexpected format falls through to the next source instead of producing a wrong catalog. `duo doctor` generates the app-server schema locally (`generate-json-schema`, ~0.1 s, without network) and warns if `model/list`, `modelProvider/capabilities/read`, or the fields used leave the stable surface. The bridge adds `--enable image_generation` only to tasks with `kind: "asset"` and `needs: ["image_generation"]`.

If the request names a `model` that is neither in the discovered catalog nor in user settings, the bridge blocks **before invoking** and lists the available models. Claude Code does not generate raster images; art tasks go only to models with `image_generation`.

## v0.3.0 baseline — phase 1

Diagnosis reported on 29/09/2026: Sonnet 5.5 appeared only after Claude Code 2.1.283 → 2.1.285; GPT-6.1-Sol after Codex 0.157.1 → 0.159.2. `model/list` is filtered by the server according to `client_version`. The cache now records both versions and is invalidated on the next query after any change, including installation/removal of a CLI. The 26/09 snapshot above remains as history.

Catalog reported on 29/09: Claude Opus 5.5 (recommended), Fable 5.1 `[1m]`, Sonnet 5.5, Haiku 4.5, and Opus 5.5 `[1m]` ("Draws from usage credits"); Codex GPT-6.1-Sol (recommended), GPT-6-Astra/Sol/Luna, GPT-5.6-Sol/Terra/Luna (legacy), GPT-5.5 (legacy → GPT-5.6-Sol). Discovery remains dynamic, without fixing this catalog in code.

| Feature | Phase 1 contract |
| --- | --- |
| Claude `--effort <level>` | low, medium, high, xhigh, or max; sent only when announced in `--help` |
| Codex `--config model_reasoning_effort="<level>"` | sent only when `exec --help` announces `--config`; also works on resumption |
| No effort | argv preserved relative to 0.2.0; no effort injected by tier |
| Model configured outside the list | origin `user-config`, unknown efforts (`[]`); does not mean access confirmed |
| Levels | configured regex takes precedence over families; unknown is presumed standard |
| Extra usage | marks `[1m]`, usage credits, per Mtok, or dollar pricing; automatic filtering is for phase 2 |
| Published CLI version | anonymous npm query, fixed headers, redirect error, 5 s timeout; 6 h cache; failure means no data |

The version query is disabled with `DUO_NO_UPDATE_CHECK=1`, `DUO_DEPTH`, `CI`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED=1`, or `discovery.checkCliUpdates=false`. Model discovery remains local. No npm is executed by this diagnosis. Package versions and `CLIENT_INFO` remain 0.2.0 until the release.

## v0.3.0 baseline — phase 2

| Feature | Contract |
| --- | --- |
| `duo recommend` | Returns `tier`, `effort`, and `selection` with the executor/model decision. `--request <pedido.json>` supplies objective, scope, and real acceptance; `--kind` without acceptance keeps a `standard` floor. Without `model` in the request, chooses within the specified `executor`. |
| Floors | With adaptive enabled, `confirmFloor` confirms the effective model, eligibility and effort during selection/recommend, execution and native observation. Deep requires a fresh catalog and advertised explicit effort ≥ high; stale/missing/unknown data blocks execution. Automatic choices (including fallbacks) confirm extra usage/include/exclude/capability. The entire authorized tree is inspected for sensitivity; incomplete inspection requires deep. |
| Downgrade | Only with enough evidence, success equal to or greater than `routing.adaptive.downgradeMinSuccess`, and respect for floors. |
| Escalation | Verification failure escalates `light → standard → deep`; `maxAttempts` counts the first invoked attempt; `deep` uses `xhigh` when supported. Explicit `model` does not switch; explicit `effort` remains and, without it, only increases with support. Infrastructure failure does not escalate. |
| Isolation | Escalation/fallback uses a new worktree and preserves the previous one. Explicit resumption preserves worktree/session/base/snapshot and partial work. `in-place` only escalates/falls back without changes left by the executor. |
| Native model | An observed model below the floor, or unconfirmable under deep, produces failed without acceptance, integration or automatic escalation. Claude is interrupted on reporting an incompatible init. Files already changed remain for review. |
| Resumption and identity | `request.json` preserves the original request. `maxAttempts` counts attempts with `invocations > 0`, plus the next invocation; `minTier`/`minEffort` do not decrease. Original `taskKey`/hash reuse the final Chain success. A superseded ancestor is refused with the current status and ID. Old tasks receive a single-attempt Chain without rewriting the task. |
| Forcing behavior | `model`, `effort`, `complexity` (`light`, `standard`, or `deep`), `adaptive: false`, and `duo delegate --no-adaptive`; explicit `model`/`effort` remain during escalation. |
| Extra usage | Requires `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` and the model in `routing.include`. Quota fallback requires a model at an equal or higher level and all gates. |

`adaptive: false` restores pre-adaptive execution. Initial selection keeps the requested executor; phase 3 may switch it when quota is exhausted, without lowering the level.

## Validation

The phase 1 test count below is historical; the current tree has 424 offline tests across phases 1–3.

| Test | Type | Result |
| --- | --- | --- |
| Third-round structural fix (`npm run typecheck` + `env -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED npm test`) | Offline, including regressions, concurrent processes, floor/effort sequences, interruption between attempts and termination of monitored processes | Clean typecheck; **481/481**, without failures, cancellations or skipped tests |
| 298 phase 1 tests (`npm test`) | Offline, simulated CLIs with outputs in the documented **and observed** format (including app-server JSON-RPC, with failure, unexpected format, hang, schema change, and sandbox) | 298/298 |
| Real `duo doctor` | Without inference | Claude 2.1.114 and Codex 0.157.1: authenticated by subscription, all required features present; blocked only by confirmation of extra usage, as expected |
| **Real Codex→Claude smoke test** | 1 invocation of `claude -p` (authorized) in a disposable repository | **succeeded** in 17 s; only `src/math.mjs` changed; `check.mjs` run by the bridge (exit 0); model `claude-opus-4-7`; native usage `input 9 / output 976 / cache_creation 19.081 / cache_read 72.960`; client estimate US$ 0.18 (not a subscription charge); `thinking` not recorded |
| **Real Claude→Codex smoke test** | 1 invocation of `codex exec` (authorized) in a disposable repository | **succeeded** in 29 s; only `src/math.mjs` changed; `check.mjs` run by the bridge (exit 0); native usage `input 142.390 (cached 105.728) / output 445`; `reasoning` not recorded |
| **Real E2E suite** (`tests/e2e/real-e2e.mjs`) | 16 scenarios with real CLIs: both brains through the skill, evidence-based routing, real art, and tasks with different models by part | **16/16** with `claude` 2.1.283 + `claude-opus-5-5` and `codex` 0.157.1 (complete run on 26/09/2026, ~14.5 min); before that, 13/13 and 11/11. Details in [e2e-real.md](e2e-real.md) |
| Real `codex exec resume` | Part of T5 | **Validated**: `succeeded` resumption with the syntax `exec resume --json --config sandbox_mode=… <id> -` |
| Real `claude --resume` | Part of T6 | **Validated** |
| Real cancellation (`duo cancel`) | T7 | **Validated**: exit 4, no remaining process |
| Real `duo models --refresh` | Without inference | 10 Claude models (initialize) + 7 Codex (app-server `model/list`) + `image_generation` in 1.4 s, both accounts in parallel; no account data in cache. `duo doctor`: contract ok |
| Real catalog inside the Codex sandbox | `codex sandbox -P :workspace -- duo models --refresh` and then `duo models` outside | Inside: `debug models` (7 models + `image_generation`), without trying app-server. Outside: rebuilt immediately through app-server `model/list` |
| **Real art** (A1) | `codex exec --model gpt-6-astra --enable image_generation` through the bridge | Valid 1254×1254 PNG in `assets/`, verified by the bridge (signature and dimensions) |
| Windows | — | **Not tested** |

The real smoke test validated acceptance of the flags, event format, and end-to-end verification for a simple task. It does not validate behavior under load, exhausted quotas, or real error cases, which remain covered only by simulated CLIs.

## Quota and local proxy (phase 3)

| Surface | Contract and limit |
| --- | --- |
| Codex app-server v2 `account/rateLimits/read` | Optional, no params, in the catalog session. Uses only windows/percentages/reset, reachedType, slug, and ordinaryUsageAllowed; unexpected/missing data does not fail the catalog. Never calls consumption methods. |
| Claude `rate_limit_event` | Observation when execution ends, without an available percentage; quota error marks exhausted. |
| Persistence | `.duo/quota-state.json`: status, usage, ISO reset, observation, source, and affected models per provider; without identity, plan, credits, or tokens. A past reset or 6 h without reset becomes unknown. |
| `quota show/set/refresh` | Show keeps previous fields and adds state. Set also updates state; refresh forces Codex discovery, without its own network. |
| Warning | −0.15 only for light/standard; deep without penalty. Does not lower level because of quota. |
| Exhausted | Entire account unavailable, except a specific slug mapped to a single model. Multiple specific limits combine models; any ambiguity blocks the entire account. |
| Fallback I4 | Same or higher level, other models from the same provider first only when the limit is specific. Then another provider; complete gates, maxAttempts, and run invocation limit. New worktree; in-place only without changes. |
| Explicit model | Preserved in quality escalation; may change in quota fallback. Explicit effort remains subject to destination support. |
| Loopback proxy | Opt-in billing.allowLoopbackProxy (false). Claude uses only sources from the effective `--setting-sources`, plus managed; `user` does not include user settings.local or project/local sources. Codex `--ignore-user-config` excludes `$CODEX_HOME/config.toml`; system and local policies remain inspected. The final gate uses flags and cwd from the plan, including worktree; settings in the brain directory do not veto selection in advance. Only literal host 127.0.0.1/localhost/::1, HTTP/HTTPS; Codex requires requires_openai_auth=true without credential keys. Unsafe overlays or unverifiable routing syntax block execution; billing environment remains filtered. |

The account is the active subscription for each CLI; this phase does not manage multiple identities or validate proxy implementation. Without a known reset, it does not invent a time. Fallback and quota/proxy cases were exercised with simulated CLIs; they do not demonstrate Headroom operation or exhausted quota in real accounts. Proxy risks and discarded data are in [SECURITY.md](../SECURITY.md).


In Codex, local inspection includes `/etc/codex/config.toml`, `managed_config.toml` and `requirements.toml` (equivalents under `%ProgramData%/OpenAI/Codex` on Windows). System sits below user/project; managed/requirements are checked separately. Without proof that project configuration is trusted/loaded, its overlay cannot authorize an unsafe route from lower layers. This may conservatively block a valid overlay. macOS MDM preferences and cloud EnterpriseManaged bundles are not inspected by this checker; local-source coverage does not validate these managed environments.

## Persisted Chain — third adversarial round

Revisions: `.duo/runs/<runId>/chains/<chainId>.d/<rev>.json`; legacy input: `<chainId>.json`; `chainId` is the first task's ID.

| Fields | Contract |
| --- | --- |
| `version: 1`, `chainId`, `runId`, `taskKey`, `requestHash`, `originalRequestPath` | Identity and hash of the brain's original request, before resolving executor/model/effort. |
| `floorTier`, `minTier`, `minEffort`, `origin` | Initial floor, highest required tier, highest reached effort and explicit/automatic origin of model/effort. Store prevents decreases. |
| `attempts[]` | `taskId`, `attempt`, `executor`, `model`, `effort`, `tier`, `reason` (`initial`, `escalation`, `quota`, `capacity`, `resume`), `state`, `invocations`; `capacityUntil` on the attempt without capacity. |
| `status`, `latestTaskId`, `updatedAt` | Current result and attempt for the entire chain. |
| `owner: {pid, nonce, since} \| null` | Reservation persisted between gates/attempts; prevents two resumptions. A dead PID allows recovery; already saved success is reconciled without another execution. |

`Store.updateChain` and `Store.updateRun` use optimistic CAS on the local filesystem, without record locks. Each directory (`chains/<chainId>.d`, `run.d`) contains 12-digit revisions with a matching `rev` field. A writer writes/fsyncs a unique temporary file, exclusively creates an empty `<rev>.cas`, then links the temporary file to `<rev>.json`. `EEXIST` reloads the value and repeats the pure synchronous callback, up to 50 attempts with a short backoff. Dead execution owners are replaced only by a CAS that still sees the same owner; `.duo/lock.json` remains the separate single-executor lock.

CAS markers are permanent. Only valid snapshots older than `rev - 20` are pruned (the latest 21 revisions by number are retained); failed pruning is ignored. Readers ignore temporary, malformed and missing snapshots, including files removed during a read, and fall back to the legacy JSON when no valid revision exists. The first successful write migrates the legacy value without deleting it. Tasks from 0.2.0 remain readable without rewriting their audit; old invocation counts are recovered from task audit, conservatively counted as used if missing everywhere.

A marker without a snapshot is aborted: before advancing, a writer exclusively seals that snapshot destination with an empty file, retaining the last valid value. This empty destination is permanent too, so a paused writer cannot publish after another writer skipped its revision, even after pruning. A crash after the temporary write cannot block further updates; orphan temporary files are ignored.

NTFS supports hard links. On `EPERM`/`ENOTSUP`, publication uses `openSync(..., "wx")`, write and fsync. Because wx exposes partial contents, this fallback also records an immutable commit/abort decision: an atomic rename of a non-empty temporary directory to `<rev>.wx.d`, alongside `<rev>.wx`. Readers require `commit`; competing writers may choose `abort` before advancing. These small decision records remain permanent. Fallback error branches and paused/aborted publications are tested with mocked filesystem errors on macOS; this is not validation on Windows.

`chainPolicy` supplies floor/effort for selection and both confirmations, automatic origin/eligibility, budget, resumption/reuse decisions and cooldowns. Fallback history, origin and `escalatedFrom` are no longer copied into new tasks. Ancestor-based reconstruction and the inter-iteration variables `quotaChoice`, `previous` and `escalateToMax` were removed: the next attempt's choice is persisted before execution and survives interruption in that interval. `selection.chainId` links the attempt; `attempt`, `attemptOf` and `chainRoot` are only derived data for legacy reads. `adaptive=false` keeps a single attempt and pre-adaptive resumption.

Offline regressions in `tests/chain-regressions.test.ts` reproduce findings about native confirmation, ancestors and loss of concurrent tasks, as well as effective cwd/flags; `tests/chain.test.ts` covers updates by concurrent processes, floor/effort sequences, simultaneous resumption, migration, recovery between attempts and cooldown without a global cache. Proxy/source cases are in `tests/auth-loopback.test.ts`. In archived copies of `4c2f483`, the five Chain reproductions failed (two native confirmations, ancestor, success reuse and concurrent task loss), as did the two Claude reproductions (remote user/loopback project and the reverse with `settingSources=user`). The comparison neither modified HEAD nor called providers.

Limits: CAS assumes cooperative writers on a local filesystem; it is not a barrier against manual changes to `.duo`. Permanent markers/abort destinations grow with the number of updates; directory scans are linear in that history. Power-loss durability and network filesystems are not validated. Task, Chain and run JSON files have individual transactions, not a database transaction across three files. Validation of this change is offline on macOS; it does not prove real proxy traffic, billing, provider behavior or Windows/Linux behavior.

The fourth-round regressions `rodada 4 achado 1: dois recuperadores e novo escritor não apagam reserva nem snapshot vivo`, the two `interrupção após reservar` cases with `maxAttempts=2`, auth/caps gates, recovered catalog and the 0.2.0 task all failed against `11d8cae` before the fixes (seven cases). The lock interleaving lost writer C's attempt. The comparison used an isolated archive and simulated CLIs, without network or changes to HEAD. `tests/store-cas.test.ts` also exercises four real concurrent writers, stale snapshots beyond pruning, crashes, disappearing revisions and mocked Windows fallback errors.

## Resumption — fourth adversarial round

Offline validation of the fourth round: `tests/store-cas.test.ts` covers the two recoverers plus a new writer, four concurrent processes (40 updates per record), a writer delayed past 20 revisions, SIGKILL after the marker and after the fsynced temporary file, fallback EPERM/ENOTSUP including partial publication, pruning and read races. In a temporary copy of HEAD `11d8cae`, the deterministic recovery race lost `task-recuperador-c` and reduced deep/high to standard/medium; all six resumption reproductions also failed (auth/capability gates, recovered catalog, 0.2.0 task, reserved quota/escalation with `maxAttempts=2`). The same tests pass with these changes. `npm run typecheck` and `env -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED npm test` passed (503/503 tests, no skips). Test children are killed/reaped on error and timeout; no real providers are called.

The latest planned/blocked attempt with `invocations === 0` reuses its task ID, session, base, snapshot and partial work. Authentication, catalog and capability gates consume no attempt budget. `maxAttempts=2` permits the second reserved attempt to run after an interruption before its executor starts. An attempt that already invoked the executor reserves a new attempt when resumed; cancelling never reopens the chain.

An automatic request whose attempt has no model selects again from the current catalog, preserving `minTier` and `minEffort`. A real persisted choice or explicit request remains fixed. This also covers 0.2.0 tasks without selection/effort/Chain and without an explicit requested model. `adaptive=false` retains its previous behavior.

---

## Português

Validado em setembro de 2026 num Mac com Apple Silicon, Node 22.22 e Git 2.54, com as CLIs oficiais logadas por assinatura (Claude Pro/Max e ChatGPT). Windows e Linux não foram testados.

## Versões testadas

| Item | Versão | Observação |
| --- | --- | --- |
| Claude Code (CLI) | 2.1.114 → **2.1.283** | O Opus 5.5 (`claude-opus-5-5`) exige a **2.1.280 ou mais nova**; rode `claude update` |
| Codex (CLI) | **0.157.1** | Instalado com `npm install -g @openai/codex` |
| Node.js | 22.22.2 | Mínimo exigido: 22.12 |
| Extensões do VS Code | Claude Code e Codex | A ponte usa as **CLIs** no PATH, não os binários embutidos nas extensões (que não são contrato de integração) |

Achados de ambiente que afetam a ponte (e como ela lida com eles):

- **Hooks e plugins do usuário rodam no executor.** No Claude, `--setting-sources user` mantém hooks e plugins do usuário (não os do projeto). No Codex, a ponte usa `--disable hooks --disable plugins` por padrão, porque hooks de um plugin (Ruflo) gravaram arquivos no projeto durante uma delegação real.
- **Outros coordenadores** (Ruflo, OmniRoute etc.) podem estar instalados. O `duo doctor` avisa; não use dois coordenadores autônomos na mesma sessão. Um `model_provider` customizado no Codex bloqueia a delegação (perfil subscription-only).
- **`sandbox_workspace_write.network_access=true` no `~/.codex/config.toml`** não afeta o executor: a ponte força `false`.
- **Hooks quebrados do usuário** (script inexistente) aparecem no stderr do executor, mas não impedem a execução.

## Claude Code 2.1.114

| Recurso | Situação |
| --- | --- |
| `-p`, `--output-format stream-json`, `--verbose`, `--json-schema` | Presentes e **aceitos em execução real**; `structured_output` chega no evento `result` do stream |
| `--tools`, `--allowedTools` (`Edit(//abs)`), `--disallowedTools`, `--permission-mode dontAsk` | Presentes e aceitos; o `system/init` real mostrou `permissionMode: dontAsk` e só as ferramentas pedidas (+ `StructuredOutput`) |
| `--setting-sources user`, `--strict-mcp-config`, `--disable-slash-commands`, `--append-system-prompt` | Aceitos; `mcp_servers: []` no init real |
| `--permission-prompts` | Ausente na 2.1.114; **presente na 2.1.283** e usado como `none` (execução sem aprovação humana; o Claude não repete ações negadas) |
| `claude-opus-5-5` | **2.1.114 recusa** com `claude_code_version_too_old` ("version 2.1.280 or newer is required"), em envelope `is_error` com exit 0. **2.1.283 aceita** (`modelUsage: claude-opus-5-5`). A ponte classifica o erro como `model_unavailable` e sugere `claude update` |
| `--bare` | Presente; **nunca usado** |
| Evento `rate_limit_event` | **Observado no stream real** (não descrito na página headless consultada): janela `five_hour`, `resetsAt`, `overageStatus`, `isUsingOverage`. A ponte registra como observação nativa pós-execução |
| Modelo efetivo | Com `model: "opus"` nas settings do usuário, a 2.1.114 resolveu para **`claude-opus-4-7`** (não Opus 5.5). Para outro modelo no executor, atualize a CLI (`claude update`) ou passe `model` no pedido |

## Codex 0.157.1

| Recurso | Situação |
| --- | --- |
| `codex exec --json`, `--sandbox`, `--cd`, `--output-schema`, `--output-last-message`, `--config`, `--model`, `--ignore-user-config` | Presentes no `exec --help` e **aceitos em execução real** |
| Prompt pela stdin com `-` | Aceito |
| Eventos JSONL reais | `thread.started`, `turn.started`, `item.started/completed` (`command_execution`, `file_change`, `agent_message`, `error`), `turn.completed`. **Nenhum evento desconhecido** para o parser |
| `usage` real | `input_tokens`, `cached_input_tokens`, **`cache_write_input_tokens`** (fora da doc consultada), `output_tokens`, `reasoning_output_tokens`. A ponte preserva todos os campos numéricos |
| Modelo efetivo | Não informado no JSONL. A ponte lê o rollout da própria sessão (`$CODEX_HOME/sessions/**/rollout-*-<thread>.jsonl`) e registra o modelo com `reportedVia: codex-rollout` |
| `codex exec resume` | O `resume --help` real **não aceita `--sandbox` nem `--cd`**. A ponte usa `exec resume --json --config sandbox_mode="…" … <id> -`, com o diretório dado pelo cwd do processo. **Retomada real validada** (E2E T5) |
| Aviso real do executor | `Exceeded skills context budget … additional skills were not included`: acontece em ambientes com muitas skills instaladas. Isso eleva o consumo e, com o Codex como cérebro, **a skill `duo-delegate` pode não ser descoberta implicitamente**: invoque `$duo-delegate` explicitamente |
| `codex mcp-server` | Não usado (removido) |
| `codex app-server` | No contrato observado da 0.157.1, usado **só para descobrir modelos** (`model/list`, `modelProvider/capabilities/read`, métodos da superfície estável); a leitura atual de cota é descrita na fase 3 abaixo, e a execução continua por `codex exec` |

## Descoberta de modelos (`duo models`)

A ponte usa as fontes abaixo, que **não consomem inferência** e ficam em cache em `.duo/models.json` por 6 h, chaveado pelas versões das CLIs (1 h quando alguma fonte está degradada). A identificação da conta (e-mail, organização) e as notificações do servidor são descartadas.

| Fonte | Como | Observado em 26/09/2026 |
| --- | --- | --- |
| Claude | `claude -p --input-format stream-json` + `control_request` `initialize` (o mesmo mecanismo do `supportedModels()` do Agent SDK); a resposta traz `models` | 10 modelos: `claude-opus-5-5` (padrão/recomendado), `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5-20251001`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`. Resposta em ~1,5 s |
| Codex (principal) | `codex app-server` (JSON-RPC por stdio): `initialize` → `initialized` → `model/list` (paginado por `nextCursor`) → `modelProvider/capabilities/read`. **Superfície estável** do protocolo usado pela extensão do VS Code e pelo app | 7 visíveis (2 ocultos ignorados): `gpt-6-astra` (`isDefault`), `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol/terra/luna`, `gpt-5.5` (`upgradeInfo` → `gpt-5.6-sol`, aposentadoria em 14/10/2026). `imageGeneration: true`. Resposta em ~0,5 s |
| Codex (fallback) | `codex debug models` + `codex features list` | Mesmos 7 modelos. **Comando de depuração, sem contrato**: usado só se o app-server falhar ou mudar de formato, e marcado como "fallback frágil" |
| Último catálogo bom | `.duo/models.json` anterior, até 30 dias | Usado se todas as fontes de uma conta falharem; marcado como desatualizado, sem bloquear modelos fora da lista |
| Config | `routing.candidates` | Último recurso |

**Dentro do sandbox do Codex** (quando o cérebro Codex roda `duo models`/`duo recommend`), o app-server não inicia: ele precisa gravar `~/.codex/installation_id` e `~/.codex/tmp/arg0`, que ali são somente leitura (observado com `codex sandbox -P :workspace --log-denials`). A ponte pula direto para o `debug models`, marca o catálogo como obtido no sandbox e o refaz pela fonte estável assim que roda fora dele (o `duo delegate` sempre roda fora).

Cada resposta é validada (campos obrigatórios e tipos); formato inesperado cai para a fonte seguinte em vez de gerar um catálogo errado. O `duo doctor` gera o schema do app-server localmente (`generate-json-schema`, ~0,1 s, sem rede) e avisa se `model/list`, `modelProvider/capabilities/read` ou os campos usados saírem da superfície estável. A ponte adiciona `--enable image_generation` só em tarefas `kind: "asset"` com `needs: ["image_generation"]`.

Se o pedido nomear um `model` que não está no catálogo descoberto nem nas configurações do usuário, a ponte bloqueia **antes** de invocar e lista os disponíveis. O Claude Code não gera imagens raster; tarefas de arte vão só para modelos com `image_generation`.

## Base da v0.3.0 — fase 1

Diagnóstico informado em 29/09/2026: Sonnet 5.5 só apareceu após Claude Code 2.1.283 → 2.1.285; GPT-6.1-Sol após Codex 0.157.1 → 0.159.2. O `model/list` é filtrado pelo servidor conforme `client_version`. O cache agora registra as duas versões e é invalidado na próxima consulta após qualquer mudança, inclusive a instalação/remoção de uma CLI. O snapshot de 26/09 acima permanece como histórico.

Catálogo informado em 29/09: Claude Opus 5.5 (recomendado), Fable 5.1 `[1m]`, Sonnet 5.5, Haiku 4.5 e Opus 5.5 `[1m]` ("Draws from usage credits"); Codex GPT-6.1-Sol (recomendado), GPT-6-Astra/Sol/Luna, GPT-5.6-Sol/Terra/Luna (legados), GPT-5.5 (legado → GPT-5.6-Sol). A descoberta continua dinâmica, sem fixar esse catálogo no código.

| Recurso | Contrato da fase 1 |
| --- | --- |
| Claude `--effort <level>` | low, medium, high, xhigh ou max; enviado só quando anunciado no `--help` |
| Codex `--config model_reasoning_effort="<level>"` | enviado só quando `exec --help` anuncia `--config`; funciona também na retomada |
| Sem effort | argv preservado em relação à 0.2.0; não injeta esforço por tier |
| Modelo configurado fora da lista | origem `user-config`, esforços desconhecidos (`[]`); não significa acesso confirmado |
| Níveis | regex configurada tem precedência sobre famílias; desconhecido é standard presumido |
| Uso extra | marca `[1m]`, usage credits, per Mtok ou preço em dólares; filtro automático fica para a fase 2 |
| Versão publicada da CLI | consulta anônima ao npm, headers fixos, redirect error, timeout 5 s; cache 6 h; falha é ausência de dado |

A consulta de versões é desligada com `DUO_NO_UPDATE_CHECK=1`, `DUO_DEPTH`, `CI`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED=1` ou `discovery.checkCliUpdates=false`. A descoberta dos modelos continua local. Nenhum npm é executado por esse diagnóstico. Versões de pacote e `CLIENT_INFO` permanecem 0.2.0 até a release.

## Base da v0.3.0 — fase 2

| Recurso | Contrato |
| --- | --- |
| `duo recommend` | Retorna `tier`, `effort` e `selection` junto da decisão de executor/modelo. `--request <pedido.json>` fornece objetivo, escopo e aceite reais; `--kind` sem aceite mantém piso `standard`. Sem `model` no pedido, escolhe dentro do `executor` informado. |
| Pisos | Com adaptive ligado, `confirmFloor` confirma modelo efetivo, elegibilidade e esforço em seleção/recommend, execução e observação nativa. Deep exige catálogo fresco e esforço explícito ≥ high anunciado; stale/ausente/desconhecido bloqueia. Escolhas automáticas (inclusive reservas) confirmam uso extra/include/exclude/capacidade. Toda a árvore autorizada é inspecionada para sensibilidade; inspeção incompleta exige deep. |
| Downgrade | Só com evidência suficiente, sucesso igual ou superior a `routing.adaptive.downgradeMinSuccess` e respeito aos pisos. |
| Escalada | Falha de verificação escala `light → standard → deep`; `maxAttempts` conta a primeira tentativa invocada; `deep` usa `xhigh` quando suportado. `model` explícito não troca; `effort` explícito permanece e, sem ele, só aumenta com suporte. Falha de infraestrutura não escala. |
| Isolamento | Escalada/fallback usa worktree novo e preserva o anterior. Retomada explícita conserva worktree/sessão/base/snapshot e trabalho parcial. `in-place` só escala/faz fallback sem alterações deixadas pelo executor. |
| Modelo nativo | Modelo observado abaixo do piso, ou não confirmável em deep, produz failed sem aceite, integração ou escalada automática. Claude é interrompido ao informar init incompatível. Arquivos já alterados permanecem para revisão. |
| Retomada e identidade | `request.json` conserva o pedido original. `maxAttempts` conta tentativas com `invocations > 0`, mais a próxima invocação; `minTier`/`minEffort` não diminuem. `taskKey`/hash original reutilizam o sucesso final da Chain. Ancestral substituída é recusada com status e ID atual. Tasks antigas recebem Chain unitária sem reescrever a task. |
| Forçar comportamento | `model`, `effort`, `complexity` (`light`, `standard` ou `deep`), `adaptive: false` e `duo delegate --no-adaptive`; `model`/`effort` explícitos permanecem na escalada. |
| Uso extra | Exige `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` e o modelo em `routing.include`. Fallback de cota exige modelo de nível igual/superior e todos os gates. |

`adaptive: false` restaura a execução pré-adaptativa. A seleção inicial mantém o executor solicitado; a fase 3 pode trocá-lo ao esgotar a cota, sem reduzir o nível.

## Validação

A contagem de testes da fase 1 abaixo é histórica; a árvore atual tem 424 testes offline das fases 1–3.

| Teste | Tipo | Resultado |
| --- | --- | --- |
| Correção estrutural da terceira rodada (`npm run typecheck` + `env -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED npm test`) | Offline, incluindo regressões, processos concorrentes, sequências de pisos/esforços, interrupção entre tentativas e encerramento dos processos monitorados | Typecheck limpo; **481/481**, sem falhas, cancelamentos ou testes pulados |
| 298 testes da fase 1 (`npm test`) | Offline, CLIs simuladas com saídas no formato documentado **e observado** (incluindo o app-server JSON-RPC, com falha, formato inesperado, travamento, mudança de schema e sandbox) | 298/298 |
| `duo doctor` real | Sem inferência | Claude 2.1.114 e Codex 0.157.1: autenticados por assinatura, todos os recursos obrigatórios presentes; bloqueados só pela confirmação de uso extra, como esperado |
| **Smoke test real Codex→Claude** | 1 invocação de `claude -p` (autorizada) num repositório descartável | **succeeded** em 17 s; só `src/math.mjs` alterado; `check.mjs` executado pela ponte (exit 0); modelo `claude-opus-4-7`; uso nativo `input 9 / output 976 / cache_creation 19.081 / cache_read 72.960`; estimativa do cliente US$ 0,18 (não é cobrança da assinatura); `thinking` não gravado |
| **Smoke test real Claude→Codex** | 1 invocação de `codex exec` (autorizada) num repositório descartável | **succeeded** em 29 s; só `src/math.mjs` alterado; `check.mjs` executado pela ponte (exit 0); uso nativo `input 142.390 (cached 105.728) / output 445`; `reasoning` não gravado |
| **Bateria E2E real** (`tests/e2e/real-e2e.mjs`) | 16 cenários com as CLIs reais: os dois cérebros via skill, roteamento por evidência, arte real e tarefas com modelos diferentes por parte | **16/16** com `claude` 2.1.283 + `claude-opus-5-5` e `codex` 0.157.1 (execução completa de 26/09/2026, ~14,5 min); antes, 13/13 e 11/11. Detalhes em [e2e-real.md](e2e-real.md) |
| `codex exec resume` real | Parte de T5 | **Validado**: retomada `succeeded` com a sintaxe `exec resume --json --config sandbox_mode=… <id> -` |
| `claude --resume` real | Parte de T6 | **Validado** |
| Cancelamento real (`duo cancel`) | T7 | **Validado**: saída 4, nenhum processo remanescente |
| `duo models --refresh` real | Sem inferência | 10 modelos Claude (initialize) + 7 Codex (app-server `model/list`) + `image_generation` em 1,4 s, as duas contas em paralelo; nenhum dado de conta no cache. `duo doctor`: contrato ok |
| Catálogo real dentro do sandbox do Codex | `codex sandbox -P :workspace -- duo models --refresh` e depois `duo models` fora | Dentro: `debug models` (7 modelos + `image_generation`), sem tentar o app-server. Fora: refeito na hora via app-server `model/list` |
| **Arte real** (A1) | `codex exec --model gpt-6-astra --enable image_generation` pela ponte | PNG 1254×1254 válido em `assets/`, verificado pela ponte (assinatura e dimensões) |
| Windows | — | **Não testado** |

O smoke test real validou a aceitação das flags, o formato dos eventos e a verificação ponta a ponta para uma tarefa simples. Ele não valida comportamento sob carga, cotas esgotadas nem casos de erro reais, que continuam cobertos só pelas CLIs simuladas.

## Cota e proxy local (fase 3)

| Superfície | Contrato e limite |
| --- | --- |
| Codex app-server v2 `account/rateLimits/read` | Opcional, sem params, na sessão do catálogo. Usa só janelas/porcentagens/reset, reachedType, slug e ordinaryUsageAllowed; dados inesperados/ausentes não falham o catálogo. Nunca chama métodos de consumo. |
| Claude `rate_limit_event` | Observação ao terminar a execução, sem porcentagem disponível; erro de cota marca exhausted. |
| Persistência | `.duo/quota-state.json`: status, uso, reset ISO, observação, fonte e modelos afetados por fornecedor; sem identidade, plano, créditos ou tokens. Reset passado ou 6 h sem reset passa a unknown. |
| `quota show/set/refresh` | Show mantém os campos anteriores e acrescenta state. Set atualiza também o estado; refresh força a descoberta Codex, sem rede própria. |
| Warning | −0,15 só para light/standard; deep sem penalidade. Não reduz nível por cota. |
| Exhausted | Conta inteira indisponível, exceto slug específico mapeado a um único modelo. Múltiplos limites específicos unem modelos; qualquer ambiguidade bloqueia a conta inteira. |
| Fallback I4 | Mesmo nível ou superior, outros modelos do fornecedor primeiro só quando o limite é específico. Depois outro fornecedor; gates completos, maxAttempts e limite de invocações do run. Worktree novo; in-place só sem alterações. |
| Modelo explícito | Preservado na escalada de qualidade; pode mudar no fallback de cota. Esforço explícito continua sujeito ao suporte do destino. |
| Proxy loopback | Opt-in billing.allowLoopbackProxy (false). Claude usa apenas as fontes do `--setting-sources` efetivo, mais managed; `user` não inclui settings.local do usuário nem projeto/local. Codex `--ignore-user-config` exclui `$CODEX_HOME/config.toml`; system e políticas locais continuam inspecionados. O gate final usa flags e cwd do plano, inclusive worktree; settings do diretório do cérebro não vetam antecipadamente a seleção. Só host literal 127.0.0.1/localhost/::1, HTTP/HTTPS; Codex exige requires_openai_auth=true sem chaves de credencial. Sobreposição insegura ou sintaxe de roteamento não verificável bloqueia; ambiente de cobrança continua filtrado. |

A conta é a assinatura ativa de cada CLI; esta fase não gerencia várias identidades nem valida a implementação do proxy. Sem reset conhecido, não inventa horário. O fallback e os casos de cota/proxy foram exercitados com CLIs simuladas; não demonstram funcionamento do Headroom nem cota esgotada em contas reais. Os riscos do proxy e os dados descartados estão em [SECURITY.md](../SECURITY.md).

No Codex, a inspeção local inclui `/etc/codex/config.toml`, `managed_config.toml` e `requirements.toml` (equivalentes em `%ProgramData%/OpenAI/Codex` no Windows). System fica abaixo de user/projeto; managed/requirements são conferidos separadamente. Sem comprovar a confiança/carregamento da configuração de projeto, seu overlay não pode autorizar uma rota insegura das camadas inferiores. Isso pode bloquear conservadoramente uma sobreposição válida. Preferências MDM do macOS e bundles EnterpriseManaged em nuvem não são inspecionados por este checker; a cobertura de fontes locais não é uma validação desses ambientes gerenciados.

## Chain persistida — terceira rodada adversarial

Revisões: `.duo/runs/<runId>/chains/<chainId>.d/<rev>.json`; entrada legada: `<chainId>.json`; `chainId` é o ID da primeira task.

| Campos | Contrato |
| --- | --- |
| `version: 1`, `chainId`, `runId`, `taskKey`, `requestHash`, `originalRequestPath` | Identidade e hash do pedido original do cérebro, antes de resolver executor/modelo/esforço. |
| `floorTier`, `minTier`, `minEffort`, `origin` | Piso inicial, maior nível exigido, maior esforço alcançado e origem explícita/automática de model/effort. O Store impede reduções. |
| `attempts[]` | `taskId`, `attempt`, `executor`, `model`, `effort`, `tier`, `reason` (`initial`, `escalation`, `quota`, `capacity`, `resume`), `state`, `invocations`; `capacityUntil` na tentativa sem capacidade. |
| `status`, `latestTaskId`, `updatedAt` | Resultado e tentativa atuais da cadeia inteira. |
| `owner: {pid, nonce, since} \| null` | Reserva persistida entre gates/tentativas; impede duas retomadas. PID morto permite recuperação; sucesso já salvo é reconciliado sem nova execução. |

`Store.updateChain` e `Store.updateRun` usam CAS otimista no filesystem local, sem locks de registro. Cada diretório (`chains/<chainId>.d`, `run.d`) contém revisões de 12 dígitos com campo `rev` correspondente. O escritor grava/fsync um temporário único, cria exclusivamente `<rev>.cas` vazio e faz link do temporário para `<rev>.json`. `EEXIST` relê o valor e repete o callback síncrono puro, até 50 tentativas com backoff curto. Owner de execução morto só é substituído por CAS que ainda observa o mesmo owner; `.duo/lock.json` continua sendo o lock separado de executor único.

Marcas CAS são permanentes. Só snapshots válidos anteriores a `rev - 20` são podados (mantêm-se as últimas 21 revisões por número); falha na poda é ignorada. Leitores ignoram temporários, snapshots inválidos ou ausentes, inclusive arquivos removidos durante a leitura, e caem no JSON legado quando não há revisão válida. A primeira escrita bem-sucedida migra o valor legado sem apagá-lo. Tasks da 0.2.0 continuam legíveis sem reescrever a auditoria; contadores antigos vêm da auditoria da task, contando conservadoramente como usada quando ausentes em ambos.

Marca sem snapshot é abortada: antes de avançar, um escritor sela exclusivamente o destino do snapshot com arquivo vazio, preservando o último valor válido. Esse destino vazio também é permanente, impedindo publicação de escritor pausado após outro pular sua revisão, mesmo após poda. Crash depois da gravação do temporário não bloqueia novas atualizações; temporários órfãos são ignorados.

NTFS suporta hard links. Em `EPERM`/`ENOTSUP`, a publicação usa `openSync(..., "wx")`, escrita e fsync. Como wx expõe conteúdo parcial, esse fallback também registra decisão imutável de commit/abort: rename atômico de diretório temporário não vazio para `<rev>.wx.d`, acompanhado de `<rev>.wx`. Leitores exigem `commit`; escritores concorrentes podem decidir `abort` antes de avançar. Esses pequenos registros de decisão ficam permanentes. Ramos de erro do fallback e publicações pausadas/abortadas são testados com erros de filesystem simulados no macOS; isso não valida Windows.

`chainPolicy` fornece piso/esforço para seleção e ambas as confirmações, origem/elegibilidade automática, orçamento, decisão de retomada/reutilização e cooldowns. O histórico de fallback, a origem e `escalatedFrom` não são mais copiados nas novas tasks. Foram removidas as reconstruções por ancestral e as variáveis entre iterações `quotaChoice`, `previous` e `escalateToMax`: a escolha da próxima tentativa é persistida antes da execução e sobrevive à interrupção nesse intervalo. `selection.chainId` vincula a tentativa; `attempt`, `attemptOf` e `chainRoot` são apenas dados derivados para leitura antiga. `adaptive=false` mantém uma única tentativa e a retomada pré-adaptativa.

Regressões offline em `tests/chain-regressions.test.ts` reproduzem os achados de confirmação nativa, ancestral e perda de tasks concorrentes, além do cwd/flags efetivos; `tests/chain.test.ts` cobre atualizações por processos concorrentes, sequências de pisos/esforços, retomada simultânea, migração, recuperação entre tentativas e cooldown sem cache global. Os casos de proxy/fontes estão em `tests/auth-loopback.test.ts`. Em cópias arquivadas de `4c2f483`, falharam as cinco reproduções de Chain (duas confirmações nativas, ancestral, reutilização do sucesso e perda de task concorrente) e as duas de Claude (usuário remoto/projeto loopback e o inverso com `settingSources=user`). A comparação não modificou o HEAD nem chamou fornecedores.

Limites: CAS pressupõe escritores cooperativos em filesystem local; não é barreira contra alteração manual de `.duo`. Marcas/destinos abortados permanentes crescem com o número de atualizações; a varredura do diretório é linear nesse histórico. Durabilidade em falta de energia e filesystems de rede não foram validados. Os JSONs de task, Chain e run têm transações individuais, não uma transação de banco entre três arquivos. A validação desta mudança é offline no macOS; não comprova envio real ao proxy, cobrança, comportamento de provedores ou Windows/Linux.

As regressões da quarta rodada `rodada 4 achado 1: dois recuperadores e novo escritor não apagam reserva nem snapshot vivo`, os dois casos `interrupção após reservar` com `maxAttempts=2`, gates auth/caps, catálogo recuperado e task 0.2.0 falharam contra `11d8cae` antes das correções (sete casos). O interleaving do lock perdeu a tentativa do escritor C. A comparação usou cópia isolada e CLIs simuladas, sem rede nem mudança do HEAD. `tests/store-cas.test.ts` também exercita quatro escritores reais concorrentes, snapshots obsoletos além da poda, crashes, revisões desaparecendo e erros simulados do fallback Windows.

## Retomada — quarta rodada adversarial

Validação offline da quarta rodada: `tests/store-cas.test.ts` cobre dois recuperadores e novo escritor, quatro processos concorrentes (40 atualizações por registro), escritor atrasado além de 20 revisões, SIGKILL após a marca e após o temporário com fsync, fallback EPERM/ENOTSUP incluindo publicação parcial, poda e corridas de leitura. Em cópia temporária do HEAD `11d8cae`, a corrida determinística de recuperação perdeu `task-recuperador-c` e reduziu deep/high para standard/medium; as seis reproduções de retomada também falharam (gates auth/caps, catálogo recuperado, task 0.2.0, quota/escalada reservadas com `maxAttempts=2`). Os mesmos testes passam com estas mudanças. `npm run typecheck` e `env -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED npm test` passaram (503/503 testes, nenhum skip). Filhos dos testes são encerrados/recolhidos em erro e timeout; não há chamada a provedores reais.

A última tentativa planned/blocked com `invocations === 0` reutiliza task ID, sessão, base, snapshot e trabalho parcial. Gates de autenticação, catálogo e capacidades não consomem orçamento de tentativas. `maxAttempts=2` permite executar a segunda tentativa reservada após interrupção anterior ao início do executor. Tentativa que já invocou o executor reserva outra ao retomar; cancelamento nunca reabre a Chain.

Pedido automático cuja tentativa não tem modelo seleciona novamente pelo catálogo atual, preservando `minTier` e `minEffort`. Escolha efetivamente persistida ou pedido explícito permanece fixo. Isso também cobre tasks 0.2.0 sem selection/effort/Chain e sem modelo explícito no pedido. `adaptive=false` preserva o comportamento anterior.
