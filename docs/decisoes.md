# Technical decisions

**English** · [Português](#português)

| # | Decision | Reason |
| --- | --- | --- |
| 1 | TypeScript + Node 22, **no runtime dependencies**; dev: `typescript@5.9.3`, `@types/node@22.20.4`, with lockfile | Minimal surface; runs where Claude Code runs; tests use built-in `node:test` |
| 2 | Custom validator for a subset of JSON Schema | The same `schemas/` files are sent to the CLIs (`--json-schema`/`--output-schema`), providing a single source of truth without adding `ajv` |
| 3 | Brain = native session; the bridge does not make an AI call to plan | The briefing asks not to repeat planning. The policy consists of simple, editable rules |
| 4 | `claude -p --output-format stream-json --verbose --json-schema` | `system/init` provides the effective model and `result` provides usage, estimated cost, and `structured_output`; the stream enables incremental parsing and incomplete-stream diagnostics |
| 5 | `--permission-mode dontAsk` + explicit `--tools` + `Edit(//abs/**)` rules | Everything not pre-approved is denied by the client; read tasks have no Edit/Write/Bash |
| 6 | `--setting-sources user`, `--strict-mcp-config`, `--disable-slash-commands` by default | `-p` skips the trust dialog; avoids project hooks and MCP and prevents the executor from loading the `duo-delegate` skill |
| 7 | Never `--bare` | It does not use subscription login (local documentation and `--help`) |
| 8 | `codex exec --json --sandbox … --output-schema … -` with network disabled for writes | OS sandbox imposed by Codex; without network, the executor cannot call another AI |
| 9 | Do not use `codex mcp-server`, App Server, or the extension binary | Removed, experimental, and non-contractual, respectively |
| 10 | Executor environment without API/gateway variables and without internal brain-session variables | In `-p`, `ANTHROPIC_API_KEY` always overrides the subscription; brain messaging tokens do not belong to the executor |
| 11 | Official status checked with the **same environment** as the executor | What is checked is exactly what will be used |
| 12 | Explicit confirmation about extra usage/credits | There is no verifiable official control; we do not scrape private endpoints |
| 13 | Execution without a shell, prompt through stdin, process group (POSIX), or `taskkill /T` (Windows) | No interpolation; no orphan process; SIGINT first in Claude (ends the turn cleanly) |
| 14 | Verification by hash + Git, with a snapshot of scoped files | Exact diff of the executor delta, preserving the user's previous changes; no destructive commands |
| 15 | A violation is reported, **not reverted** | Never discard work; the user decides |
| 16 | State in JSON/JSONL with atomic writes to `.duo/` | Simple, local, inspectable; no database or SaaS |
| 17 | State machine `planned → approved → running → succeeded / failed / blocked / cancelled`, with `blocked → approved` on resumption | Explicit resumption, reusing the native session and keeping the original base to avoid repeating changes |
| 18 | Default limit of 2 invocations per run and 1 executor per project | Conservative briefing configuration; exceeding it requires changing the config |
| 19 | Metrics with explicit source (`native`, `local-estimate`, `local-measure`, `manual`, `unavailable`) and separate native schemas | Avoids adding providers together and double-counting cache (in Claude, `input_tokens` excludes cache; in Codex, `cached_input_tokens` is a subset) |
| 20 | Optional worktree, integrated by `duo apply` only if HEAD and scoped-file hashes have not changed | Rejects a diff against an outdated base |
| 21 | On Windows, reject `.cmd` shims | Running them would require a shell; configure the `.exe` or `[node, script]` |
| 22 | Skills installed in project scope (`.claude/skills/`, `.agents/skills/`) with the bridge's absolute path | Nothing global; `init` shows preview/diff and makes a backup |
| 23 | Codex resumption as `exec resume --json --config sandbox_mode="…" … <id> -` | The real `resume --help` (0.157.1) does not accept `--sandbox`/`--cd`; without this, resumption would run without the requested sandbox |
| 24 | Record Claude's `rate_limit_event` as a native post-execution observation and alert if `isUsingOverage=true` | The only official limit/extra-usage signal available locally; it does not replace prior confirmation (it is observed afterward) |
| 25 | Pass non-fatal executor warnings back to the brain (Codex `error` item, Claude error `notification`) | The real smoke test showed a relevant warning ("Exceeded skills context budget") that affected consumption and skill discovery |
| 26 | Preserve all numeric fields from native `usage` | Real Codex emitted `cache_write_input_tokens`, which is not in the consulted documentation |
| 27 | Claude executor with `claude-opus-5-5` by default, warning about requested/effective model divergence, and version errors treated as `model_unavailable` with an update instruction | User preference; no silent fallback to another model |
| 28 | `--permission-prompts none` when announced | Nobody approves anything during delegation; avoids repeating denied actions (saving turns) |
| 29 | `Bash(<aceite>)` and `Bash(<aceite> *)` rules, with an instruction to use the exact command | Real Opus 5.5 tried `node check.mjs; echo …` and an absolute path, which were denied, and reported `partial` |
| 30 | Evidence-based routing (`duo recommend`) instead of provider ranking | The briefing prohibits treating stereotypes as facts; verified history from this project + availability + limited declared preferences. Without evidence, the recommendation admits it is judgment |
| 31 | "Do it yourself" when the best candidate is the brain client's own client | Avoids delegating for its own sake and avoids favoritism in either direction |
| 32 | Inside the Codex sandbox, an unreadable login from another client = "not verifiable", not "unavailable" | The Keychain may not be accessible in the sandbox; the bridge checks again when delegating |
| 33 | Per-account model catalog: Claude `initialize` (supportedModels) and `codex debug models` + `codex features list` | The only local, inference-free means that reflect the account; Codex's is labeled non-contractual. Claude's `account` field is discarded |
| 34 | Router over the entire catalog, with capability as a required filter and provider signals (recommended +0.05, legacy −0.1) | "Best model available for the task" without inventing a ranking; measured evidence still dominates |
| 35 | Delegation to the same client allowed with explicit `model` (and different from `brainModel`) | User requirement: use the best model per subtask, regardless of who the brain is |
| 36 | `kind: "asset"` + `needs: ["image_generation"]` → `codex exec --enable image_generation`, with image-signature verification | Image generation is a Codex tool, not a model output; the bridge does not trust "completed" |
| 37 | Tasks without `model` count toward the client's default model (duo config, Codex `model` in `config.toml`, or provider recommendation) | Preserves the history of executions made with the default model |
| 38 | Primary Codex catalog source: `codex app-server` → `model/list` + `modelProvider/capabilities/read` (replaces decision 33's `debug models`, which becomes fallback) | These are methods on the **stable** surface of the JSON-RPC protocol used by the VS Code extension and app; the CLI-generated schema (`generate-json-schema`, without `--experimental`) includes them. Data is typed (`isDefault`, `hidden`, `upgradeInfo` with retirement date, `imageGeneration`) rather than inferred from text |
| 39 | Per-account source chain with format validation: stable source → fallback (`debug models`) → last good catalog (up to 30 days, marked stale) → `routing.candidates` | A format change or unavailable CLI degrades model selection without breaking it. With a stale catalog, the bridge does not block an unknown model (the CLI confirms at execution) and records the limitation. Cache of 24 h, or 1 h when degraded, to return quickly to the stable source |
| 40 | `duo doctor` checks the stable-source contract by generating the schema locally (without network or inference, ~0.1 s) | Detects that a method or field used has left the stable surface **before** discovery fails |
| 42 | Inside the Codex sandbox, discovery skips app-server and uses the fallback; the catalog is marked (`discoveredInSandbox`) and rebuilt from the stable source as soon as the bridge runs outside the sandbox | Real test: under Seatbelt (`codex sandbox -P :workspace`), app-server needs to write `~/.codex/installation_id` and `~/.codex/tmp/arg0`. `sqlite_home` solves only the state database, and there is no option for the rest. `debug models` works there. `duo delegate` always runs outside the sandbox, so delegation uses the stable source |
| 43 | Codex executor with `--disable hooks --disable plugins` by default (`executors.codex.disableUserExtensions`) | In the first real demo, hooks from a plugin installed in Codex (Ruflo) wrote `.claude-flow/` and `.claude/proven-config*` to the project during delegation, and the bridge blocked it as a scope violation. With the official flags, the repeat passed cleanly and input tokens fell from 291 thousand to 220 thousand. The user's `config.toml` is not changed |
| 44 | Post-execution evidence from Codex read from the session's own rollout (`$CODEX_HOME/sessions/**/rollout-*-<thread>.jsonl`): effective model, provider, server response IDs (`resp_…`), called tools, and SHA-256 of images in `generated_images/<thread>/` | `codex exec --json` does not report the model. The rollout is the client's own record, validated by the session ID. Only metadata is extracted, never content. The format is not contractual: without a rollout, the model is "unavailable" and nothing is invented |
| 41 | Unknown CLI options are errors (except `--json`, `--help`, `--version`, accepted in any command); the request's `brainModel` is recorded in the task | `duo doctor --cwd x` was accepted and silently ignored. `brainModel` was lost and is useful for auditing the same-provider rule |

## Consulted references (25/09/2026)

The `developers.openai.com/codex/*` URLs redirected (308) to `learn.chatgpt.com/docs/*`.

- https://code.claude.com/docs/en/headless: `-p`, `stream-json`, `--json-schema`, `--bare` without OAuth, `dontAsk`, SIGTERM/SIGINT, stdin limited to 10 MB, `-p` without a trust dialog.
- https://code.claude.com/docs/en/authentication: credential precedence; `ANTHROPIC_API_KEY` always used in `-p`.
- https://code.claude.com/docs/en/legal-and-compliance: OAuth use by subscribers; prohibition on offering claude.ai login or brokering credentials in products.
- https://code.claude.com/docs/en/skills: `.claude/skills/<nome>/SKILL.md`, frontmatter, support files.
- https://learn.chatgpt.com/docs/non-interactive-mode: `codex exec`, flags, JSONL events, `resume`, `CODEX_API_KEY`, Git requirement.
- https://learn.chatgpt.com/docs/auth: `codex login`, `codex login status`, `forced_login_method`, credential storage.
- https://learn.chatgpt.com/docs/build-skills: `.agents/skills`, `SKILL.md`, `references/`, invocation with `$`.
- https://learn.chatgpt.com/docs/app-server: marked experimental; `account/rateLimits/read` does not appear on the current page.
- App-server protocol schema generated locally with `codex app-server generate-json-schema` (0.157.1, 26/09/2026): `initialize`, `model/list`, and `modelProvider/capabilities/read` are on the stable surface (104 stable methods, 63 only with `--experimental`). The "experimental" label is on the CLI subcommand, not those methods.

Not consulted in this session (to review before related changes): Claude Code's model-config, costs, vs-code, and agent-sdk/overview, and the Codex agents-sdk guide.

---

## Português

| # | Decisão | Motivo |
| --- | --- | --- |
| 1 | TypeScript + Node 22, **sem dependências de runtime**; dev: `typescript@5.9.3`, `@types/node@22.20.4`, com lockfile | Superfície mínima; roda onde o Claude Code roda; testes com `node:test` embutido |
| 2 | Validador próprio de um subconjunto de JSON Schema | Os mesmos arquivos de `schemas/` são enviados às CLIs (`--json-schema`/`--output-schema`), o que dá uma única fonte de verdade sem adicionar `ajv` |
| 3 | Cérebro = sessão nativa; a ponte não faz chamada de IA para planejar | O briefing pede para não repetir o planejamento. A política é feita de regras simples e editáveis |
| 4 | `claude -p --output-format stream-json --verbose --json-schema` | O `system/init` traz o modelo efetivo e o `result` traz uso, custo estimado e `structured_output`; o stream permite parsing incremental e diagnóstico de stream incompleto |
| 5 | `--permission-mode dontAsk` + `--tools` explícito + regras `Edit(//abs/**)` | Tudo que não foi pré-aprovado é negado pelo cliente; tarefas de leitura não têm Edit/Write/Bash |
| 6 | `--setting-sources user`, `--strict-mcp-config`, `--disable-slash-commands` por padrão | `-p` ignora o diálogo de confiança; evita hooks e MCP do projeto e impede o executor de carregar a skill `duo-delegate` |
| 7 | Nunca `--bare` | Não usa login de assinatura (documentação e `--help` local) |
| 8 | `codex exec --json --sandbox … --output-schema … -` com rede desligada em escrita | Sandbox do SO imposto pelo Codex; sem rede, o executor não consegue chamar outra IA |
| 9 | Não usar `codex mcp-server`, App Server nem o binário da extensão | Removido, experimental e não contratual, respectivamente |
| 10 | Ambiente do executor sem variáveis de API/gateway e sem variáveis internas da sessão do cérebro | Em `-p`, `ANTHROPIC_API_KEY` sempre vence a assinatura; tokens de mensageria do cérebro não pertencem ao executor |
| 11 | Status oficial executado com o **mesmo ambiente** do executor | O que é verificado é exatamente o que será usado |
| 12 | Confirmação explícita sobre uso extra/créditos | Não há controle oficial verificável; não raspamos endpoints privados |
| 13 | Execução sem shell, prompt pela stdin, grupo de processos (POSIX) ou `taskkill /T` (Windows) | Nada de interpolação; nenhum processo órfão; SIGINT primeiro no Claude (encerra o turno de forma limpa) |
| 14 | Verificação por hash + Git, com snapshot dos arquivos do escopo | Diff exato do delta do executor, preservando alterações prévias do usuário; sem comandos destrutivos |
| 15 | Violação é reportada, **não revertida** | Nunca descartar trabalho; o usuário decide |
| 16 | Estado em JSON/JSONL com escrita atômica em `.duo/` | Simples, local, inspecionável; sem banco nem SaaS |
| 17 | Máquina de estados `planned → approved → running → succeeded / failed / blocked / cancelled`, com `blocked → approved` na retomada | Retomada explícita, reutilizando a sessão nativa e mantendo a base original para não repetir mudanças |
| 18 | Limite padrão de 2 invocações por run e 1 executor por projeto | Configuração conservadora do briefing; exceder exige mudar a config |
| 19 | Métricas com origem explícita (`native`, `local-estimate`, `local-measure`, `manual`, `unavailable`) e esquemas nativos separados | Evita somar fornecedores e contar cache em dobro (no Claude, `input_tokens` exclui cache; no Codex, `cached_input_tokens` é subconjunto) |
| 20 | Worktree opcional, integrado por `duo apply` somente se HEAD e hashes do escopo não mudaram | Rejeita diff sobre base desatualizada |
| 21 | No Windows, recusar shims `.cmd` | Executá-los exigiria shell; configure o `.exe` ou `[node, script]` |
| 22 | Skills instaladas no escopo do projeto (`.claude/skills/`, `.agents/skills/`) com o caminho absoluto da ponte | Nada global; `init` mostra preview/diff e faz backup |
| 23 | Retomada do Codex como `exec resume --json --config sandbox_mode="…" … <id> -` | O `resume --help` real (0.157.1) não aceita `--sandbox`/`--cd`; sem isso a retomada rodaria sem o sandbox pedido |
| 24 | Registrar o `rate_limit_event` do Claude como observação nativa pós-execução e alertar se `isUsingOverage=true` | Único sinal oficial de limite/uso extra disponível localmente; não substitui a confirmação prévia (é observado depois) |
| 25 | Repassar ao cérebro os avisos não fatais do executor (item `error` do Codex, `notification` de erro do Claude) | O smoke test real mostrou um aviso relevante ("Exceeded skills context budget") que afetava consumo e descoberta de skills |
| 26 | Preservar todos os campos numéricos do `usage` nativo | O Codex real emitiu `cache_write_input_tokens`, que não está na documentação consultada |
| 27 | Executor Claude com `claude-opus-5-5` por padrão, alerta de divergência entre modelo pedido e efetivo, e erro de versão tratado como `model_unavailable` com instrução de atualização | Preferência do usuário; sem fallback silencioso para outro modelo |
| 28 | `--permission-prompts none` quando anunciado | Em delegação ninguém aprova nada; evita repetição de ações negadas (economia de turnos) |
| 29 | Regras `Bash(<aceite>)` e `Bash(<aceite> *)`, com instrução para usar o comando exato | O Opus 5.5 real tentou `node check.mjs; echo …` e caminho absoluto, que foram negados, e reportou `partial` |
| 30 | Roteamento por evidência (`duo recommend`) em vez de ranking de fornecedores | O briefing proíbe estereótipos como fatos; histórico verificado deste projeto + disponibilidade + preferências declaradas e limitadas. Sem evidência, a recomendação admite que é julgamento |
| 31 | "Fazer você mesmo" quando o melhor candidato é o próprio cliente do cérebro | Evita delegar por delegar e evita clubismo nos dois sentidos |
| 32 | Dentro do sandbox do Codex, login ilegível de outro cliente = "não verificável", não "indisponível" | O Keychain pode não ser acessível no sandbox; a ponte verifica de novo ao delegar |
| 33 | Catálogo de modelos por conta: `initialize` do Claude (supportedModels) e `codex debug models` + `codex features list` | Únicos meios locais, sem inferência, que refletem a conta; o do Codex é rotulado como não contratual. O campo `account` do Claude é descartado |
| 34 | Roteador sobre o catálogo inteiro, com a capacidade como filtro obrigatório e sinais do fornecedor (recomendado +0,05, legado −0,1) | "Melhor modelo disponível para a tarefa" sem inventar ranking; a evidência medida continua dominando |
| 35 | Delegação ao mesmo cliente permitida com `model` explícito (e diferente de `brainModel`) | Requisito do usuário: usar o melhor modelo por subtarefa, independente de quem é o cérebro |
| 36 | `kind: "asset"` + `needs: ["image_generation"]` → `codex exec --enable image_generation`, com verificação da assinatura da imagem | A geração de imagem é uma ferramenta do Codex, não uma saída de modelo; a ponte não confia no "completed" |
| 37 | Tarefas sem `model` contam para o modelo padrão do cliente (config do duo, `model` do `config.toml` do Codex ou recomendado do fornecedor) | Preserva o histórico de execuções feitas com o modelo padrão |
| 38 | Fonte principal do catálogo do Codex: `codex app-server` → `model/list` + `modelProvider/capabilities/read` (substitui o `debug models` da decisão 33, que vira fallback) | São métodos da superfície **estável** do protocolo JSON-RPC que a extensão do VS Code e o app usam; o schema gerado pela CLI (`generate-json-schema`, sem `--experimental`) os inclui. Os dados são tipados (`isDefault`, `hidden`, `upgradeInfo` com data de aposentadoria, `imageGeneration`) em vez de inferidos de texto |
| 39 | Cadeia de fontes por conta com validação de formato: fonte estável → fallback (`debug models`) → último catálogo bom (até 30 dias, marcado como desatualizado) → `routing.candidates` | Uma mudança de formato ou uma CLI fora do ar degrada a escolha de modelo, mas não a quebra. Com catálogo desatualizado, a ponte não bloqueia modelo desconhecido (a CLI confirma na execução) e registra a limitação. Cache de 24 h, ou 1 h quando degradado, para voltar logo à fonte estável |
| 40 | `duo doctor` verifica o contrato da fonte estável gerando o schema localmente (sem rede nem inferência, ~0,1 s) | Detecta que um método ou campo usado saiu da superfície estável **antes** de a descoberta falhar |
| 42 | Dentro do sandbox do Codex, a descoberta pula o app-server e usa o fallback; o catálogo fica marcado (`discoveredInSandbox`) e é refeito pela fonte estável assim que a ponte roda fora do sandbox | Teste real: sob o seatbelt (`codex sandbox -P :workspace`), o app-server precisa gravar `~/.codex/installation_id` e `~/.codex/tmp/arg0`. `sqlite_home` resolve só o banco de estado, e não há opção para o resto. O `debug models` funciona ali. O `duo delegate` sempre roda fora do sandbox, então a delegação usa a fonte estável |
| 43 | Executor Codex com `--disable hooks --disable plugins` por padrão (`executors.codex.disableUserExtensions`) | Na primeira demo real, os hooks de um plugin instalado no Codex (Ruflo) gravaram `.claude-flow/` e `.claude/proven-config*` no projeto durante a delegação, e a ponte barrou como violação de escopo. Com as flags oficiais, a repetição passou limpa e os tokens de entrada caíram de 291 mil para 220 mil. O `config.toml` do usuário não é alterado |
| 44 | Provas pós-execução do Codex lidas do rollout da própria sessão (`$CODEX_HOME/sessions/**/rollout-*-<thread>.jsonl`): modelo efetivo, provedor, IDs de resposta do servidor (`resp_…`), ferramentas chamadas e SHA-256 das imagens de `generated_images/<thread>/` | O `codex exec --json` não informa o modelo. O rollout é o registro do próprio cliente, validado pelo ID da sessão. Só metadados são extraídos, nunca o conteúdo. O formato não é contratual: sem rollout, o modelo fica "não disponível" e nada é inventado |
| 41 | Opções desconhecidas na CLI são erro (exceto `--json`, `--help`, `--version`, aceitas em qualquer comando); o `brainModel` do pedido é gravado na task | `duo doctor --cwd x` era aceito e ignorado em silêncio. O `brainModel` se perdia e é útil para auditar a regra de mesmo fornecedor |

## Referências consultadas (25/09/2026)

As URLs `developers.openai.com/codex/*` redirecionaram (308) para `learn.chatgpt.com/docs/*`.

- https://code.claude.com/docs/en/headless: `-p`, `stream-json`, `--json-schema`, `--bare` sem OAuth, `dontAsk`, SIGTERM/SIGINT, stdin limitado a 10 MB, `-p` sem diálogo de confiança.
- https://code.claude.com/docs/en/authentication: precedência de credenciais; `ANTHROPIC_API_KEY` sempre usada em `-p`.
- https://code.claude.com/docs/en/legal-and-compliance: uso de OAuth por assinantes; proibição de oferecer login claude.ai ou intermediar credenciais em produtos.
- https://code.claude.com/docs/en/skills: `.claude/skills/<nome>/SKILL.md`, frontmatter, arquivos de apoio.
- https://learn.chatgpt.com/docs/non-interactive-mode: `codex exec`, flags, eventos JSONL, `resume`, `CODEX_API_KEY`, requisito de Git.
- https://learn.chatgpt.com/docs/auth: `codex login`, `codex login status`, `forced_login_method`, armazenamento de credenciais.
- https://learn.chatgpt.com/docs/build-skills: `.agents/skills`, `SKILL.md`, `references/`, invocação com `$`.
- https://learn.chatgpt.com/docs/app-server: marcado como experimental; `account/rateLimits/read` não aparece na página atual.
- Schema do protocolo do app-server gerado localmente com `codex app-server generate-json-schema` (0.157.1, 26/09/2026): `initialize`, `model/list` e `modelProvider/capabilities/read` estão na superfície estável (104 métodos estáveis, 63 só com `--experimental`). O rótulo "experimental" fica no subcomando da CLI, não nesses métodos.

Não consultadas nesta sessão (a revisar antes de mudanças relacionadas): model-config, costs, vs-code e agent-sdk/overview do Claude Code, e o guia agents-sdk do Codex.
