# Changelog — ClaudeGPT - Duo Orchestrator by Fusic

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
