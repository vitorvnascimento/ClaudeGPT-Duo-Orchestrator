# Changelog — ClaudeGPT - Duo Orchestrator by Fusic

**English** · [Português](#português)

## 0.3.0 — in development / em desenvolvimento

### English

Phases 1–3: catalog, adaptive selection and quota continuity (offline validation).

- Catalog keyed by installed Claude/Codex versions, 6 h TTL (1 h when degraded) and explicit invalidation for the future router.
- Anonymous check of published npm versions, 6 h cache and warnings in `models`/`doctor`, without installation or credentials; environment/config opt-out.
- User-configured models added without duplicating IDs/aliases, with their own origin and unknown efforts.
- Pure functions for family/regex tiers, version comparison, extra usage and supported effort selection.
- Optional `effort` in requests and task audits; flags gated by help, rejection before execution and old argv preserved without effort when adaptive mode is disabled.
- New defaults/validation for `routing.adaptive`, `routing.extraModels` and `discovery`; older configs and tasks remain compatible.
- `duo recommend` now returns `tier`, `effort` and `selection`; `--request` carries the actual objective, scope and acceptance criteria, and omitting `model` selects within the requested `executor`. Without acceptance criteria in shorthand mode, the minimum tier is `standard`.
- Minimum tiers and adaptive escalation: high or sensitive risk requires `deep`; `light` requires low risk, limited scope without directories and acceptance commands; verification failure escalates `light → standard → deep` and `maxAttempts` counts the first attempt.
- Retries preserve previous worktrees and only repeat `in-place` without changes; infrastructure failures do not escalate for quality; quota has its own fallback. `deep` may use `xhigh`; explicit `model` does not change, explicit `effort` remains and, without it, escalation only increases effort when supported.
- `model`, `effort`, `complexity: light|standard|deep`, `adaptive: false` and `duo delegate --no-adaptive` allow forcing behavior. `adaptive: false` preserves pre-adaptive execution.
- Models with extra usage require provider acknowledgment and explicit inclusion in `routing.include`; quota fallback uses only equivalent or higher models, subject to all gates.
- Offline tests with injected fetch and simulated CLIs. Package and `CLIENT_INFO` versions remain 0.2.0.
- Sanitized per-provider state in `.duo/quota-state.json`, expiring at reset/6 h without reset; Claude events, quota errors and manual records update the observation.
- Optional `account/rateLimits/read` in the Codex discovery session, without credit-consuming methods. Account/plan/credit fields are discarded; specific limits only affect models with unambiguous mapping.
- `duo quota refresh`, `quota show` with `state` preserving previous fields and quota health in `recommend`. Warning conserves the account for deep (−0.15 only in light/standard).
- I4 fallback at the same or higher tier with `selection.fallbacks`, new attempts/worktrees, all gates and protection of in-place changes. The original task remains resumable; adaptive disabled performs no fallback.
- `billing.allowLoopbackProxy` (false by default): explicit exception for a subscription-based HTTP/HTTPS loopback proxy, without API keys and with `requires_openai_auth` in Codex. Doctor reports authorization/a hint; SECURITY documents the risk.
- Offline tests of parsing/privacy/expiration, allowed account methods, selection, fallback between simulated CLIs and loopback URL validation. No version was changed.
- Adversarial fixes: effective model and explicit effort respect the risk/scope minimum tier; capability and tier are required together, with consistent tiers in recommend. Unknown defaults or presumed tiers cannot execute under a deep minimum.
- Original request preserved in request.json; invocation.json records resolved execution. Resumptions preserve automatic origin, chain root/counter and the minimum effort reached; fallbacks seek destinations supporting that effort. taskKey reuses the final result by its original logical identity.

### Português

- Terceira rodada adversarial: Chain persistida em `.duo/runs/<runId>/chains/<chainId>.json`, com pedido original, origem, tentativas, piso/esforço monotônicos e reserva de execução. Seleção, confirmação nativa, orçamento, retomada, capacidade e idempotência consultam esse registro. Ancestrais substituídas são recusadas; retomar o sucesso final reutiliza o resultado.
- Chain e run usam leitura-modificação-escrita sob lock curto de arquivo. Escaladas/fallbacks preservam tasks concorrentes, contadores e cancelamento; tasks antigas recebem Chain unitária ao ler, sem reescrita da auditoria. Retomada adaptativa registra nova tentativa e preserva sessão, base, snapshot e trabalho parcial; a escolha da próxima tentativa já está persistida se houver interrupção antes de executá-la.
- Autenticação valida fontes e diretório do plano efetivo. Claude `settingSources=user` considera usuário + managed; projeto/local ignorados geram aviso e não mascaram endpoints. Codex só ignora configuração do usuário quando `--ignore-user-config` está no plano. Flags ausentes no help não autorizam exclusão de fontes.

- **Modelo sem capacidade** ("at capacity", "overloaded", 529/503): tratado como falha passageira do modelo, não da conta. O modelo fica indisponível por 10 min em `.duo/capacity-state.json` e a tarefa continua em outro modelo de nível igual ou superior, primeiro do mesmo fornecedor e depois do outro, com as mesmas regras do fallback de cota. Com `adaptive=false`: blocked, como na 0.2.0.

- Segunda rodada adversarial: `confirmFloor` centraliza confirmação de modelo/esforço/elegibilidade; deep exige catálogo fresco e esforço explícito high ou superior. Reservas automáticas stale, desconhecidas ou inelegíveis bloqueiam.
- Sensibilidade de escopo inspecionada sem corte de 2.000 caminhos; enumeração incompleta exige deep. Modelo nativo abaixo do piso ou não confirmável falha sem integrar/escalar, com interrupção antecipada no init Claude.
- Proxy loopback validado após sobreposição das fontes carregadas pelo executor; tabelas, perfis e sintaxes TOML de roteamento não verificáveis falham fechado, sem expor valores de credencial.

Fases 1–3: catálogo, seleção adaptativa e continuidade sob cota (validação offline).

- Catálogo chaveado pelas versões instaladas de Claude/Codex, TTL de 6 h (1 h degradado) e invalidação explícita para o roteador futuro.
- Consulta anônima das versões publicadas no npm, cache de 6 h e avisos em `models`/`doctor`, sem instalação ou credenciais; opt-out por ambiente/config.
- Modelos configurados pelo usuário adicionados sem duplicar IDs/aliases, com origem própria e esforços desconhecidos.
- Funções puras de nível por família/regex, comparação de versões, uso extra e escolha de esforço suportado.
- `effort` opcional no pedido e na auditoria da task; flags condicionadas ao help, recusa antes da execução e argv antigo preservado sem effort quando o modo adaptativo está desligado.
- Novos defaults/validações de `routing.adaptive`, `routing.extraModels` e `discovery`; configs e tasks antigas continuam compatíveis.
- `duo recommend` agora retorna `tier`, `effort` e `selection`; `--request` leva objetivo, escopo e aceite reais, e ao omitir `model` a seleção ocorre dentro do `executor` solicitado. Sem aceite no modo abreviado, o piso é `standard`.
- Pisos e escalada adaptativa: risco alto ou sensível exige `deep`; `light` exige baixo risco, escopo limitado sem diretório e comandos de aceite; falha de verificação escala `light → standard → deep` e `maxAttempts` conta a primeira tentativa.
- Retentativas preservam worktrees anteriores e só repetem `in-place` sem alterações; falhas de infraestrutura não escalam por qualidade; cota tem fallback próprio. `deep` pode usar `xhigh`; `model` explícito não troca, `effort` explícito permanece e, sem ele, a escalada só aumenta esforço quando houver suporte.
- `model`, `effort`, `complexity: light|standard|deep`, `adaptive: false` e `duo delegate --no-adaptive` permitem forçar o comportamento. `adaptive: false` mantém a execução pré-adaptativa.
- Modelos com uso extra exigem ciência do provider e inclusão explícita em `routing.include`; fallback de cota usa somente modelos equivalentes ou superiores, sujeitos a todos os gates.
- Testes offline com fetch injetado e CLIs simuladas. Versões do pacote e `CLIENT_INFO` continuam 0.2.0.

- Estado sanitizado por fornecedor em `.duo/quota-state.json`, com expiração no reset/6 h sem reset; eventos Claude, erros de cota e registros manuais atualizam a observação.
- `account/rateLimits/read` opcional na sessão de descoberta do Codex, sem métodos de consumo de créditos. Campos de conta/plano/créditos são descartados; limites específicos só afetam modelos com mapeamento inequívoco.
- `duo quota refresh`, `quota show` com `state` preservando campos anteriores e saúde de cota em `recommend`. Warning poupa a conta para deep (−0,15 só em light/standard).
- Fallback I4 de nível igual/superior registrado em `Chain.attempts`, novas tentativas/worktrees, todos os gates e proteção de alterações in-place. Só a última tentativa bloqueada pode ser retomada; adaptive desligado não faz fallback.
- `billing.allowLoopbackProxy` (false por padrão): exceção explícita para proxy HTTP/HTTPS loopback usando assinatura, sem chaves de API e com `requires_openai_auth` no Codex. Doctor informa autorização/dica; SECURITY documenta o risco.
- Testes offline de parsing/privacidade/expiração, métodos account permitidos, seleção, fallback entre CLIs simuladas e validação de URLs loopback. Nenhuma versão foi alterada.
- Correções adversariais: modelo efetivo e effort explícito respeitam o piso de risco/escopo; capacidade e nível são exigidos juntos, com tiers coerentes em recommend. Padrão desconhecido ou nível presumido não pode executar sob piso deep.
- Pedido original preservado em request.json; invocation.json registra a execução resolvida. Chain conserva origem, contador e esforço mínimo alcançado; fallbacks procuram destinos que sustentem esse esforço. taskKey reutiliza a última tentativa da Chain pelo hash do pedido original.

## 0.2.0 — 2026-09-29

### English

First public version, under the official name **ClaudeGPT - Duo Orchestrator by Fusic**. Focus on robust process execution and secret redaction, following a series of cross-reviews between Claude and Codex.

#### Added

- **New version notification:** `duo` checks the latest public release (at most once a day, in the background, without credentials) and notifies the terminal when a newer version exists. `duo update` checks immediately and `duo update --apply` installs it. Disable: `DUO_NO_UPDATE_CHECK=1`.

#### Fixed

- **Orphan processes and stuck bridge:** an executor descendant ignoring SIGTERM held the bridge until it exited on its own and could become orphaned. Timeout, cancellation and bridge exit now reach the entire group, even after the main process exits, and a PGID already reused by another process is never signaled. The bridge only returns the result when the group is empty (with a cap of ~2 s after SIGKILL, so a process stuck in the kernel cannot hang it). A process leaving the group (e.g. a daemon with `setsid`) and inheriting stdout/stderr also no longer holds the bridge: once the group is empty, it releases the pipes after ~2 s without marking a timeout. When returning without the executor's "close", no executor timer or handle keeps the bridge from exiting, and a normal execution no longer waits those ~2 s to exit.
- **Diagnostics (`runQuick`):** the timeout is now effective even when the queried program ignores SIGTERM.
- **Failing callbacks:** an exception while saving task state (e.g. full disk) no longer crashes the bridge; the executor is terminated and the error reaches the caller.
- **Task stuck in `running`:** if saving progress fails during execution, the task becomes `blocked` (resumable) instead of remaining `running` forever.
- **Termination classification:** excessive output is no longer also reported as a timeout (which incorrectly made the task resumable). The first cause wins, including when a callback fails after another cause already stopped the executor.
- **Retained output tail:** the final stdout/stderr segment kept for diagnostics no longer loses bytes within the limit.
- **CRLF lines at the size limit:** acceptance no longer depends on how bytes arrive fragmented.
- **Config:** `timeoutSec` and `acceptanceTimeoutSec` must be integers between 1 and 86400; byte limits, integers between 1 and 1 GiB. Previously, invalid values became a ~1 ms timer.
- **Secret redaction:** now covers PEM private-key blocks, Google keys (`AIza…`), Stripe (`sk_/rk_live|test`) and npm tokens. PEM is processed in linear time (previously ~14 s for 1.25 MB) and fails closed: a truncated block or mismatched labels are redacted to the end. Blocks split across event-stream lines or strings within the same JSON (e.g. a line array) are also redacted, and the 2000-character limit per log line is applied only after redaction. A delimiter in a JSON key (e.g. MCP call arguments) also opens the block for subsequent values. If a line over the limit (8 MiB) must be discarded without inspection, including the stream's final line, event logging stops (fails closed).
- **Reasoning actually omitted:** Codex `reasoning` and Claude `thinking` are identified in the original event, before redaction; previously, a PEM block opened in an earlier event could hide the event type and allow reasoning to be recorded.

### Português

Primeira versão pública, com o nome oficial **ClaudeGPT - Duo Orchestrator by Fusic**. Foco em robustez da execução de processos e na redação de segredos, a partir de uma bateria de revisão cruzada entre Claude e Codex.

#### Adicionado

- **Aviso de nova versão:** o `duo` consulta a última release pública (no máximo uma vez por dia, em segundo plano, sem credenciais) e avisa no terminal quando há versão mais nova. `duo update` consulta na hora e `duo update --apply` instala. Desligar: `DUO_NO_UPDATE_CHECK=1`.

#### Corrigido

- **Processos órfãos e ponte presa:** um descendente do executor que ignorava SIGTERM segurava a ponte até morrer sozinho e podia ficar órfão. Timeout, cancelamento e a saída da ponte agora alcançam o grupo inteiro, mesmo depois que o processo principal saiu, e um PGID já reutilizado por outro processo nunca é sinalizado. A ponte só devolve o resultado quando o grupo está vazio (com teto de ~2 s após o SIGKILL, para um processo preso no kernel não travá-la). Um processo que sai do grupo (ex.: daemon com `setsid`) e herda stdout/stderr também não prende mais a ponte: com o grupo vazio, ela solta os pipes depois de ~2 s, sem marcar timeout. Quando devolve sem o "close" do executor, nenhum timer ou handle dele segura mais a saída da ponte, e uma execução normal não espera mais esses ~2 s para sair.
- **Diagnósticos (`runQuick`):** o timeout agora é efetivo mesmo quando o programa consultado ignora SIGTERM.
- **Callbacks que falham:** uma exceção ao gravar o estado da task (ex.: disco cheio) deixa de derrubar a ponte; o executor é encerrado e o erro chega ao chamador.
- **Task presa em `running`:** se gravar o andamento falha durante a execução, a task passa a `blocked` (retomável) em vez de ficar `running` para sempre.
- **Classificação do encerramento:** excesso de saída não é mais relatado também como timeout (o que tornava a task retomável por engano). A primeira causa vence, inclusive quando um callback falha depois de outra causa já ter parado o executor.
- **Final da saída retido:** o trecho final de stdout/stderr guardado para diagnóstico não perde mais bytes que estavam dentro do limite.
- **Linhas CRLF no limite de tamanho:** a aceitação não depende mais de como os bytes chegam fragmentados.
- **Config:** `timeoutSec` e `acceptanceTimeoutSec` precisam ser inteiros entre 1 e 86400; os limites de bytes, inteiros entre 1 e 1 GiB. Antes, valores inválidos viravam um timer de ~1 ms.
- **Redação de segredos:** passa a cobrir blocos de chave privada PEM, chaves Google (`AIza…`), Stripe (`sk_/rk_live|test`) e tokens npm. O PEM é tratado em tempo linear (antes, ~14 s para 1,25 MB) e falha fechado: bloco truncado ou com rótulos divergentes é redigido até o fim. Blocos que chegam partidos entre linhas do stream de eventos ou entre strings de um mesmo JSON (ex.: array de linhas) também são redigidos, e o limite de 2000 caracteres por linha de log só é aplicado depois da redação. Um delimitador numa chave JSON (ex.: argumentos de uma chamada MCP) também abre o bloco para os valores seguintes. Se uma linha acima do limite (8 MiB) precisar ser descartada sem inspeção, inclusive a última linha do stream, o log de eventos é interrompido (falha fechado).
- **Raciocínio omitido de verdade:** o `reasoning` do Codex e o `thinking` do Claude são identificados no evento original, antes da redação; antes, um bloco PEM aberto num evento anterior podia esconder o tipo do evento e deixar o raciocínio ser gravado.

## 0.1.0 — 2026-09-26

### English

First version: local Codex ↔ Claude Code bridge through official CLIs, with independent verification, model catalog, evidence-based routing and a `subscription-only` profile.

### Português

Primeira versão: ponte local Codex ↔ Claude Code pelas CLIs oficiais, com verificação independente, catálogo de modelos, roteamento por evidência e perfil `subscription-only`.
