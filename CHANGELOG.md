# Changelog — ClaudeGPT - Duo Orchestrator by Fusic

## 0.3.0 — em desenvolvimento

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

Primeira versão pública, com o nome oficial **ClaudeGPT - Duo Orchestrator by Fusic**. Foco em robustez da execução de processos e na redação de segredos, a partir de uma bateria de revisão cruzada entre Claude e Codex.

### Adicionado

- **Aviso de nova versão:** o `duo` consulta a última release pública (no máximo uma vez por dia, em segundo plano, sem credenciais) e avisa no terminal quando há versão mais nova. `duo update` consulta na hora e `duo update --apply` instala. Desligar: `DUO_NO_UPDATE_CHECK=1`.

### Corrigido

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

Primeira versão: ponte local Codex ↔ Claude Code pelas CLIs oficiais, com verificação independente, catálogo de modelos, roteamento por evidência e perfil `subscription-only`.
