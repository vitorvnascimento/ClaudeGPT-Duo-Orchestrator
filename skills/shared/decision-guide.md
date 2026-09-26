# Guia de decisão ({{BRAIN}} como cérebro, {{EXECUTOR}} como outro agente)

Objetivo: **concluir mais tarefas corretamente com os recursos disponíveis**. Qualidade primeiro, eficiência como desempate e nenhuma preferência de marca.

## Ordem de decisão para cada subtarefa

1. **Ferramenta determinística resolve?** Busca, git, compilador, testes, linter, parser. Use-a.
2. **Evidência:** `duo recommend --kind … --paths … --risk … --brain {{BRAIN}}`.
   - `DELEGAR` ou `FAZER VOCÊ MESMO` com confiança alta ou média → siga.
   - `JULGAMENTO` → use os critérios abaixo.
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
- Use o `model` indicado pelo `recommend`. Se ele for do seu próprio cliente mas diferente do seu modelo, delegue ao seu cliente com esse `model`.
- Para restringir ou excluir modelos (ex.: legados), use `routing.include`/`routing.exclude` no `.duo/config.json`.
- Não suponha que um modelo "sempre" é melhor em algo: isso é estereótipo, não medição. Preferências pessoais só entram como `routing.priors`, com bônus limitado e identificado.

## Contexto mínimo suficiente

- **Inclua:** objetivo verificável, arquivos autorizados, interfaces/contratos, decisões já tomadas, restrições, critérios de aceite e comandos.
- **Não inclua:** histórico da conversa, arquivos que o executor pode ler, segredos.
- Prefira pedidos pequenos e sequenciais a um pedido grande e vago.

## Nunca delegue

Segredos e credenciais, push/publicação/deploy, exclusões destrutivas, compras, ou qualquer coisa sem escopo definido.

## Orçamento

Até 2 invocações delegadas por run (incluindo uma correção) e 1 executor ativo por projeto. Exceder exige decisão explícita do usuário. Estimativas de custo do cliente não são saldo de assinatura.
