# Parallel execution

Dispatch independent subtasks with `isolation: "worktree"`, distinct `taskKey` values and the same existing `runId`. Run `duo delegate --request a.json &` and `duo delegate --request b.json &`, then `wait`. Up to four executors may run concurrently (configurable 1..4); the shared run also has an eight-invocation default budget, including retries. Any in-place task is exclusive. A forced worktree remains a worktree throughout its chain. Worktrees include the brain's uncommitted state, excluding denied paths and `.duo/`, within `maxSnapshotBytes`. Apply successful patches one at a time with `duo apply` in the brain's chosen order. Rejected apply means a new task on the current base; do not force it. Use `duo status` to inspect occupied slots.

## Português

# Guia de decisão ({{BRAIN}} como cérebro, {{EXECUTOR}} como outro agente)

Objetivo: **concluir mais tarefas corretamente com os recursos disponíveis**. Qualidade primeiro, eficiência como desempate e nenhuma preferência de marca.

## Ordem de decisão para cada subtarefa

1. **Ferramenta determinística resolve?** Busca, git, compilador, testes, linter, parser. Use-a.
2. **Evidência:** `duo recommend [--request <pedido.json>] [--kind …] [--paths …] --risk … --brain {{BRAIN}}`.
   - `DELEGAR` ou `FAZER VOCÊ MESMO` com confiança alta ou média → siga.
   - `JULGAMENTO` → use os critérios abaixo.
   - A resposta traz `tier`, `effort` e `selection` para auditoria. Informe o `executor`; omita `model`/`effort` para manter a seleção automática. `tier` e `selection` não são campos do pedido.
   - Use `--request` para enviar objetivo, escopo e aceite reais; sem aceite no modo abreviado, o piso é `standard`.
3. **Registre** a decisão da entrega (`duo accept` / `--reject`). É isso que torna a próxima recomendação melhor.

## Critérios quando a evidência é insuficiente

| Situação | Tendência | Por quê |
| --- | --- | --- |
| Depende de muitas decisões desta conversa ou de contexto difícil de escrever | Faça você | Repassar contexto custa mais e perde nuances |
| Subtarefa isolada, com arquivos claros e critério objetivo | Delegue | Transferência barata e verificação automática |
| Mudança de alto risco (auth, dados, migração, segurança, dinheiro) | Implemente com quem tiver melhor evidência (ou você) **e** peça revisão cruzada ao outro | Duas leituras independentes pegam mais erros |
| Revisão de código que você mesmo escreveu | Delegue a revisão | Olhar independente, sem o seu viés |
| Você tentou e falhou de forma relevante | Delegue (`reason: blocked_or_failure`) | Outra abordagem, outro modelo |
| Cota do seu cliente perto do limite | Delegue o que for delegável | Preserva a capacidade total do par |
| Baixo risco e nenhum histórico | Explore: delegue ao candidato com menos amostras | Gera evidência para decisões futuras |
| Refatoração acoplada em muitos arquivos | Faça você, ou divida em partes independentes | Um único escritor coerente |

## Escolha de modelo

- `duo models` lista o que as contas conectadas oferecem; o `recommend` considera **todos** esses modelos.
- A capacidade exigida é filtro obrigatório (ex.: arte → só modelos com `image_generation`).
- Use o executor indicado pelo `recommend`. Omitir `model` ativa a seleção adaptativa dentro desse executor; informe `model` apenas quando precisar forçá-lo. `effort` explícito também é preservado em escaladas.
- `complexity` (`light`, `standard`, `deep`) força o nível. Risco alto ou sensível exige `deep`; `light` exige risco baixo, arquivos limitados, sem diretório e comandos de aceite.
- Para restringir ou excluir modelos (ex.: legados), use `routing.include`/`routing.exclude` no `.duo/config.json`.
- Não suponha que um modelo "sempre" é melhor em algo: isso é estereótipo, não medição. Preferências pessoais só entram como `routing.priors`, com bônus limitado e identificado.

## Escalada e limites

- Só faça downgrade com evidência suficiente e sucesso igual ou superior a `routing.adaptive.downgradeMinSuccess`, respeitando os pisos.
- Falha de verificação escala `light → standard → deep`; `maxAttempts` conta a primeira tentativa. `deep` pode usar `xhigh`; `model` explícito não troca, `effort` explícito permanece e, sem ele, só aumenta com suporte. Falha de infraestrutura não escala.
- Em `worktree`, cada tentativa usa worktree novo e mantém o anterior. Em `in-place`, só repita se não houve alteração.
- `adaptive: false` ou `duo delegate --no-adaptive` restaura o comportamento pré-adaptativo. Uso extra exige `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` e `routing.include`; fallback por conta/cota fica para a fase 3.

## Contexto mínimo suficiente

- **Inclua:** objetivo verificável, arquivos autorizados, interfaces/contratos, decisões já tomadas, restrições, critérios de aceite e comandos.
- **Não inclua:** histórico da conversa, arquivos que o executor pode ler, segredos.
- Prefira pedidos pequenos e sequenciais a um pedido grande e vago.

## Nunca delegue

Segredos e credenciais, push/publicação/deploy, exclusões destrutivas, compras, ou qualquer coisa sem escopo definido.

## Orçamento

Por padrão, até 8 invocações delegadas por run (incluindo retentativas) e 4 executores simultâneos por projeto; `maxConcurrentExecutors` aceita 1..4. Estimativas de custo do cliente não são saldo de assinatura.

## Execução paralela

Para subtarefas independentes, use `isolation: "worktree"`, `taskKey` distinto e o mesmo `runId` existente. Dispare `duo delegate --request a.json &` e `duo delegate --request b.json &`, depois `wait`. Qualquer tarefa in-place é exclusiva. Se houver conversão para worktree, a cadeia mantém esse isolamento. A worktree inclui o trabalho não commitado do cérebro, sem caminhos negados nem `.duo/`, dentro de `maxSnapshotBytes`. Integre patches aprovados um a um com `duo apply`, na ordem escolhida pelo cérebro. Apply rejeitado exige tarefa nova na base atual; não force a integração. Consulte os slots com `duo status`.
