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
| Floors | High or sensitive risk requires an effective `deep` model, including explicit/configured/resumed; unknown default, presumed level, or explicit effort below high blocks at this floor. Capability and level are required together. `light` requires low risk, limited files, no directory in scope, and acceptance commands. |
| Downgrade | Only with enough evidence, success equal to or greater than `routing.adaptive.downgradeMinSuccess`, and respect for floors. |
| Escalation | Verification failure escalates `light → standard → deep`; `maxAttempts` counts the first attempt; `deep` uses `xhigh` when supported. Explicit `model` does not switch; explicit `effort` remains and, without it, only increases with support. Infrastructure failure does not escalate. |
| Isolation | Each new `worktree` attempt uses a new worktree and preserves the previous one. `in-place` retries only without changes left by the executor. |
| Resumption and identity | `request.json` preserves the original request; automatic selection remains scalable. `chainRoot`/`attempt` maintain the budget even without a base. Reached effort does not decrease in fallback or resumption. Original `taskKey`/hash identify the chain and reuse its final success. Old tasks without origin use the root request to distinguish explicit fields. |
| Forcing behavior | `model`, `effort`, `complexity` (`light`, `standard`, or `deep`), `adaptive: false`, and `duo delegate --no-adaptive`; explicit `model`/`effort` remain during escalation. |
| Extra usage | Requires `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` and the model in `routing.include`. Quota fallback requires a model at an equal or higher level and all gates. |

`adaptive: false` restores pre-adaptive execution. Initial selection keeps the requested executor; phase 3 may switch it when quota is exhausted, without lowering the level.

## Validation

The phase 1 test count below is historical; the current tree has 424 offline tests across phases 1–3.

| Test | Type | Result |
| --- | --- | --- |
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
| Loopback proxy | Opt-in billing.allowLoopbackProxy (false). Only client settings/config, literal host 127.0.0.1/localhost/::1, HTTP/HTTPS; Codex requires requires_openai_auth=true without credential keys. Billing environment remains filtered. |

The account is the active subscription for each CLI; this phase does not manage multiple identities or validate proxy implementation. Without a known reset, it does not invent a time. Fallback and quota/proxy cases were exercised with simulated CLIs; they do not demonstrate Headroom operation or exhausted quota in real accounts. Proxy risks and discarded data are in [SECURITY.md](../SECURITY.md).

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
| Pisos | Risco alto ou sensível exige modelo efetivo `deep`, inclusive explícito/configurado/retomado; padrão desconhecido, nível presumido ou effort explícito abaixo de high bloqueiam nesse piso. Capacidade e nível são exigidos juntos. `light` exige risco baixo, arquivos limitados, nenhum diretório no escopo e comandos de aceite. |
| Downgrade | Só com evidência suficiente, sucesso igual ou superior a `routing.adaptive.downgradeMinSuccess` e respeito aos pisos. |
| Escalada | Falha de verificação escala `light → standard → deep`; `maxAttempts` conta a primeira tentativa; `deep` usa `xhigh` quando suportado. `model` explícito não troca; `effort` explícito permanece e, sem ele, só aumenta com suporte. Falha de infraestrutura não escala. |
| Isolamento | Cada nova tentativa `worktree` usa worktree novo e preserva o anterior. `in-place` só tenta novamente sem alterações deixadas pelo executor. |
| Retomada e identidade | `request.json` conserva o pedido original; seleção automática continua escalável. `chainRoot`/`attempt` mantêm o orçamento mesmo sem base. Esforço alcançado não diminui no fallback ou na retomada. `taskKey`/hash original identificam a cadeia e reutilizam seu sucesso final. Tasks antigas sem origin usam o pedido da raiz para distinguir campos explícitos. |
| Forçar comportamento | `model`, `effort`, `complexity` (`light`, `standard` ou `deep`), `adaptive: false` e `duo delegate --no-adaptive`; `model`/`effort` explícitos permanecem na escalada. |
| Uso extra | Exige `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` e o modelo em `routing.include`. Fallback de cota exige modelo de nível igual/superior e todos os gates. |

`adaptive: false` restaura a execução pré-adaptativa. A seleção inicial mantém o executor solicitado; a fase 3 pode trocá-lo ao esgotar a cota, sem reduzir o nível.

## Validação

A contagem de testes da fase 1 abaixo é histórica; a árvore atual tem 424 testes offline das fases 1–3.

| Teste | Tipo | Resultado |
| --- | --- | --- |
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
| Proxy loopback | Opt-in billing.allowLoopbackProxy (false). Só settings/config do cliente, host literal 127.0.0.1/localhost/::1, HTTP/HTTPS; Codex exige requires_openai_auth=true sem chaves de credencial. Ambiente de cobrança continua filtrado. |

A conta é a assinatura ativa de cada CLI; esta fase não gerencia várias identidades nem valida a implementação do proxy. Sem reset conhecido, não inventa horário. O fallback e os casos de cota/proxy foram exercitados com CLIs simuladas; não demonstram funcionamento do Headroom nem cota esgotada em contas reais. Os riscos do proxy e os dados descartados estão em [SECURITY.md](../SECURITY.md).
