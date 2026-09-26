# Matriz de compatibilidade observada

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
| `codex app-server` | Usado **só para descobrir modelos** (`model/list`, `modelProvider/capabilities/read`, métodos da superfície estável); a execução continua por `codex exec` |

## Descoberta de modelos (`duo models`)

A ponte usa as fontes abaixo, que **não consomem inferência** e ficam em cache em `.duo/models.json` por 24 h (1 h quando alguma fonte está degradada). A identificação da conta (e-mail, organização) e as notificações do servidor são descartadas.

| Fonte | Como | Observado em 26/09/2026 |
| --- | --- | --- |
| Claude | `claude -p --input-format stream-json` + `control_request` `initialize` (o mesmo mecanismo do `supportedModels()` do Agent SDK); a resposta traz `models` | 10 modelos: `claude-opus-5-5` (padrão/recomendado), `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5-20251001`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`. Resposta em ~1,5 s |
| Codex (principal) | `codex app-server` (JSON-RPC por stdio): `initialize` → `initialized` → `model/list` (paginado por `nextCursor`) → `modelProvider/capabilities/read`. **Superfície estável** do protocolo usado pela extensão do VS Code e pelo app | 7 visíveis (2 ocultos ignorados): `gpt-6-astra` (`isDefault`), `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol/terra/luna`, `gpt-5.5` (`upgradeInfo` → `gpt-5.6-sol`, aposentadoria em 14/10/2026). `imageGeneration: true`. Resposta em ~0,5 s |
| Codex (fallback) | `codex debug models` + `codex features list` | Mesmos 7 modelos. **Comando de depuração, sem contrato**: usado só se o app-server falhar ou mudar de formato, e marcado como "fallback frágil" |
| Último catálogo bom | `.duo/models.json` anterior, até 30 dias | Usado se todas as fontes de uma conta falharem; marcado como desatualizado, sem bloquear modelos fora da lista |
| Config | `routing.candidates` | Último recurso |

**Dentro do sandbox do Codex** (quando o cérebro Codex roda `duo models`/`duo recommend`), o app-server não inicia: ele precisa gravar `~/.codex/installation_id` e `~/.codex/tmp/arg0`, que ali são somente leitura (observado com `codex sandbox -P :workspace --log-denials`). A ponte pula direto para o `debug models`, marca o catálogo como obtido no sandbox e o refaz pela fonte estável assim que roda fora dele (o `duo delegate` sempre roda fora).

Cada resposta é validada (campos obrigatórios e tipos); formato inesperado cai para a fonte seguinte em vez de gerar um catálogo errado. O `duo doctor` gera o schema do app-server localmente (`generate-json-schema`, ~0,1 s, sem rede) e avisa se `model/list`, `modelProvider/capabilities/read` ou os campos usados saírem da superfície estável. A ponte adiciona `--enable image_generation` só em tarefas `kind: "asset"` com `needs: ["image_generation"]`.

Se o pedido nomear um `model` que não está no catálogo, a ponte bloqueia **antes** de invocar e lista os disponíveis. O Claude Code não gera imagens raster; tarefas de arte vão só para modelos com `image_generation`.

## Validação

| Teste | Tipo | Resultado |
| --- | --- | --- |
| 125 testes (`npm test`) | Offline, CLIs simuladas com saídas no formato documentado **e observado** (incluindo o app-server JSON-RPC, com falha, formato inesperado, travamento, mudança de schema e sandbox) | 125/125 |
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
