---
name: duo-delegate
description: Coordenar Codex (cérebro) e Claude Code para executar tarefas com a melhor qualidade e eficiência. Descobre os modelos disponíveis nas contas conectadas e escolhe, por evidência e sem preferência de marca, o melhor modelo para cada subtarefa (ex.: Opus 5.5 para código, GPT-6-Astra para arte), seja você, outro modelo do mesmo fornecedor ou o Claude ou por uma ferramenta determinística, e delega pela ponte local duo com verificação independente. Use quando o usuário pedir para usar as duas IAs, delegar ou consultar o Claude, ou quando uma subtarefa delimitada se beneficiaria do outro agente.
---

# duo-delegate — cérebro: Codex · outro agente: Claude Code

Você é o **cérebro**: entende o pedido, decide quem executa cada parte e integra o resultado. A ponte `duo` é código determinístico: mede, valida, aplica limites, aciona o Claude Code e verifica o resultado. O executor não pode delegar de novo.

**Princípio:** escolha o **modelo** que executa melhor **esta** subtarefa, entre os disponíveis nas contas conectadas, pela evidência. Não existe "time". Se o histórico mostra que o Claude faz melhor, delegue. Se mostra que você faz melhor, faça você. Qualidade primeiro; eficiência desempata.

## Pré-requisito do projeto

O projeto precisa ser um repositório Git com `.duo/config.json`. Se não tiver, rode `{{DUO_CLI}} init --apply` (cria a config e as skills do projeto) e peça ao usuário para confirmar `billing.acknowledgeUnverifiableExtraUsage` no `.duo/config.json`: ele precisa conferir nas contas se o uso extra ou os créditos estão desligados. **Nunca marque essa confirmação por conta própria.** Confira com `{{DUO_CLI}} doctor`.

## 0. Conheça os modelos disponíveis

```bash
{{DUO_CLI}} models            # catálogo das duas contas (cache de 6 h; --refresh atualiza); não consome inferência
```

Mostra, por conta: IDs, descrições do fornecedor, recomendado e legado, e ferramentas (ex.: geração de imagem no Codex). Use os IDs exatamente como aparecem.

## 1. Entenda antes de agir

Escreva para si, em poucas linhas:
- **Resultado esperado** e como verificar objetivamente (comando de teste, critério observável).
- **Decomposição:** subtarefas, dependências entre elas, arquivos de cada uma.
- **Para cada subtarefa:** `kind` (implement/test/review/investigate/**asset** para arte e mídia), **capacidade exigida** (`--needs image_generation` para imagens), **risco** (`high` para auth, dados, migração, segurança e dinheiro; `low` para mudanças locais e reversíveis), **acoplamento** (quanto contexto desta conversa seria preciso repassar) e **tamanho**.

Pergunte ao usuário só o que é indispensável e não dá para descobrir no repositório.

## 2. Escolha o executor de cada subtarefa (sem clubismo)

1. **Ferramenta determinística basta?** (git, busca, compilador, testes, linter) Então use-a. Não gaste IA com isso.
2. **Consulte a evidência:**
   ```bash
   {{DUO_CLI}} recommend [--request .duo/requests/<nome>.json] [--kind <kind>] [--needs image_generation] [--paths <arquivos,separados>] --risk <low|medium|high> --brain codex --brain-model <seu-modelo>
   ```
3. **Siga a recomendação,** a menos que haja um motivo concreto registrado no `rationale`:
   - `DELEGAR a <cliente> com model=X` → use `"executor": "<cliente>"`; omita `model`/`effort` para seleção automática ou informe `"model": "X"` para fixar a sugestão. Pode ser o **mesmo cliente que você** com outro modelo (ex.: você é GPT-6-Sol e a arte pede GPT-6-Astra): isso é permitido e esperado.
   - `FAZER VOCÊ MESMO` → o melhor modelo é você: execute sem delegar.
   - `DECIDIR POR JULGAMENTO` → a evidência ainda é insuficiente. Decida pelos critérios de `references/decision-guide.md`. Em tarefas de **baixo risco**, prefira a exploração sugerida (gera evidência); em **alto risco**, implemente com quem você confia mais e peça **revisão cruzada** ao outro.
4. Tarefa com partes diferentes (ex.: código + ilustração): rode o `recommend` **para cada parte** e use o modelo indicado em cada uma, mesmo que sejam fornecedores diferentes.
5. Se o usuário nomear modelos ("Opus 5.5 para o código, GPT-6-Astra para a arte"), siga a escolha dele (`reason: user_requested`), desde que o modelo exista no catálogo.
6. Nunca escolha por marca, hábito ou por ser "você". Se escolher contra a recomendação, justifique no `rationale` com fatos (ex.: "exige o contexto de 3 decisões tomadas nesta conversa").

`recommend` retorna `tier`, `effort` e `selection`. Use `--request` para fornecer objetivo, escopo e aceite reais; sem aceite no modo abreviado, o piso é `standard`. Informe o `executor` recomendado e omita `model` para a seleção automática acontecer dentro dele; use `model`, `effort` ou `complexity: light|standard|deep` para forçar. Risco alto ou sensível exige `deep`; `light` só vale para baixo risco, poucos arquivos, sem diretório no escopo e com comandos de aceite.

## 3. Monte o pedido com o contexto mínimo suficiente

Crie `.duo/requests/<nome>.json` seguindo `references/request-format.md` (`"brain": "codex"`, `"executor": "claude"`):
- `objective` preciso e verificável; `scope.allowedPaths` só com o que precisa mudar (ou ser lido, em revisões).
- `context.interfaces` (assinaturas e contratos) e `context.decisions` (o que já foi decidido e não deve ser rediscutido). **Não** cole o histórico da conversa nem arquivos inteiros que o executor pode ler.
- `acceptance.commands` com o comando objetivo (os prefixos precisam estar em `acceptance.allowedCommands`).
- `model` com o ID do catálogo quando quiser forçar um modelo; sem ele, a ponte seleciona dentro do `executor`. `brainModel` é o seu próprio modelo. `effort` explícito é preservado em escaladas; `complexity` indica o nível inicial, sujeito aos pisos; use `needs`/`kind: "asset"` para arte (o executor salva a imagem no caminho autorizado e a ponte confere que é uma imagem válida).
- `risk`, `reason` e um `rationale` curto; `isolation: "worktree"` quando for arriscado mexer no working tree.
- Várias subtarefas independentes: delegue **uma de cada vez** (um executor ativo por projeto) e reutilize o `runId` devolvido pela primeira.

## 4. Execute

```bash
{{DUO_CLI}} delegate --request .duo/requests/<nome>.json [--no-adaptive]
```

`--no-adaptive` (ou `"adaptive": false` no pedido) restaura o comportamento pré-adaptativo. Com seleção adaptativa, downgrade só ocorre com evidência suficiente e sucesso igual ou superior a `routing.adaptive.downgradeMinSuccess`; falha de verificação escala `light → standard → deep`, `maxAttempts` conta a primeira tentativa e `deep` usa `xhigh` quando suportado. `model` explícito não troca; `effort` explícito permanece e, sem ele, só aumenta com suporte. Falhas de infraestrutura não escalam. Cada tentativa `worktree` recebe um worktree novo e preserva o anterior; `in-place` só tenta novamente sem alterações.

**Sandbox:** este comando inicia o Claude Code, que precisa de rede e do login do usuário. Dentro do sandbox do Codex ele falha. Solicite aprovação para executar **este comando** fora do sandbox; nunca desative o sandbox globalmente nem use flags de bypass. `duo recommend`, `status`, `report` e `accept` funcionam dentro do sandbox.
A execução pode levar minutos; aguarde o JSON final. Não edite os arquivos do escopo enquanto o executor roda.

## 5. Verifique, integre e registre (isso alimenta a próxima escolha)

- `succeeded`: a ponte já verificou escopo, diff e testes. Revise o `diff` com olhar crítico e integre. Em worktree, use `{{DUO_CLI}} apply --task-id <id>`.
- `failed`: leia `outcome`, `acceptance` e `claimsMismatch`. Não repita no automático: corrija você mesmo ou faça **uma** nova delegação com contexto melhor (o limite padrão é 2 invocações por run).
- `blocked`: explique a causa (login, cota, política, escopo) e não contorne. Resolvida a causa: `{{DUO_CLI}} delegate --resume <taskId> [--timeout-sec N]`.
- `outOfScope`/`deniedTouched` não vazios: pare e mostre ao usuário; nada foi revertido.
- **Sempre registre a decisão:** `{{DUO_CLI}} accept --task-id <id> --note "..."` ou `--reject --note "motivo"`. Rejeições e aceites entram na evidência do `recommend`.

## Outros comandos

`{{DUO_CLI}} status` · `{{DUO_CLI}} report` (métricas com a origem de cada número) · `{{DUO_CLI}} cancel --run-id <id>` · `{{DUO_CLI}} handoff --to claude --next "..."` (troca de cérebro por documento, sem transferir sessão).

## Regras

- Um run tem um único cérebro; não troque no meio de uma edição.
- Não altere `.duo/config.json` para aumentar limites, liberar comandos, mudar preferências de roteamento ou confirmar ciência de cobrança sem pedido explícito do usuário.
- Uso extra só é elegível com `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` e o modelo em `routing.include`; não há fallback por conta ou cota nesta fase.
- Reporte métricas e cotas só como a ponte informar (`native`, `manual` ou `não disponível`); nunca invente saldo.
