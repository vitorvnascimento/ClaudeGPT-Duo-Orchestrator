# Avaliação opcional: a delegação realmente ajuda?

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
