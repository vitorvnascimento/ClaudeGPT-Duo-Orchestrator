# Optional evaluation: does delegation really help?

**English** · [Português](#português)

Savings can only be claimed against a **single-agent workflow** on comparable tasks. This procedure **never runs automatically** because it consumes quota from both subscriptions.

## Preparation

1. Choose 5 to 10 real, small tasks, each with an objective success criterion (a test command that passes or fails).
2. For each task, create an identical snapshot: `git worktree add ../eval-<tarefa>-A <commit>` and `../eval-<tarefa>-B <commit>`.
3. Pin versions: record `claude --version`, `codex --version`, and the requested models (`duo doctor --json > eval/doctor.json`).
4. Define the authorized budget (maximum number of tasks × invocations) and record it.

## Execution

- **Arm A (single agent):** the brain solves the task alone, without `duo-delegate`.
- **Arm B (duo):** the same brain, with `duo-delegate` available and the chosen policy.
- Alternate the order across tasks to reduce learning bias.

## What to record per task

| Metric | Source |
| --- | --- |
| Success (acceptance test passed) | local command |
| Total time to success | local measurement |
| Brain messages/turns | manual count or native `num_turns`, when available |
| Native usage per provider (do not add across providers) | `duo report --json` and `/status` or `/cost` from each client |
| Rework (corrections, resumptions) | `duo report` (`retries`) |
| Percentage of quota consumed (if the client shows it) | manual reading, with timestamp |

## Analysis

- Compare the **success rate** first, then time, and only then consumption.
- Consider delegation advantageous only if arm B completes **more tasks correctly** with the same resources, or the same tasks with less consumption of the chosen scarce resource (`quotaPreference`).
- Do not convert tokens into a "subscription percentage" or add Claude and Codex together.
- Publish the raw numbers with the conclusion. With few tasks, say that the sample is small.

---

## Português

Economia só pode ser afirmada contra um **fluxo de agente único** em tarefas comparáveis. Este procedimento **nunca roda automaticamente**, porque consome cota das duas assinaturas.

## Preparação

1. Escolha de 5 a 10 tarefas reais e pequenas, cada uma com critério de sucesso objetivo (um comando de teste que passa ou falha).
2. Para cada tarefa, crie um snapshot idêntico: `git worktree add ../eval-<tarefa>-A <commit>` e `../eval-<tarefa>-B <commit>`.
3. Fixe versões: registre `claude --version`, `codex --version` e os modelos pedidos (`duo doctor --json > eval/doctor.json`).
4. Defina o orçamento autorizado (número máximo de tarefas × invocações) e anote-o.

## Execução

- **Braço A (agente único):** o cérebro resolve a tarefa sozinho, sem `duo-delegate`.
- **Braço B (duo):** o mesmo cérebro, com `duo-delegate` disponível e a política escolhida.
- Alterne a ordem entre tarefas para reduzir viés de aprendizado.

## O que registrar por tarefa

| Métrica | Origem |
| --- | --- |
| Sucesso (teste de aceite passou) | comando local |
| Tempo total até sucesso | medida local |
| Mensagens/turnos do cérebro | contagem manual ou `num_turns` nativo, quando houver |
| Uso nativo por fornecedor (não somar entre fornecedores) | `duo report --json` e `/status` ou `/cost` de cada cliente |
| Retrabalho (correções, retomadas) | `duo report` (`retries`) |
| Percentual de cota consumido (se o cliente mostrar) | leitura manual, com horário |

## Análise

- Compare a **taxa de sucesso** primeiro, depois o tempo, e só então o consumo.
- Considere a delegação vantajosa apenas se o braço B concluir **mais tarefas corretamente** com os mesmos recursos, ou as mesmas tarefas com menos consumo do recurso escasso escolhido (`quotaPreference`).
- Não converta tokens em "percentual da assinatura" nem some Claude com Codex.
- Publique os números brutos junto com a conclusão. Com poucas tarefas, diga que a amostra é pequena.
