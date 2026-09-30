# Real E2E suite (Claude Code + Codex)

**English** · [Português](#português)

`tests/e2e/real-e2e.mjs` invokes the **real** CLIs and **consumes quota** from both subscriptions. It never runs in `npm test` and requires `--confirm-quota`.

```bash
npm run build
node tests/e2e/real-e2e.mjs --confirm-quota --base /tmp/duo-e2e            # todos os cenários
node tests/e2e/real-e2e.mjs --confirm-quota --base /tmp/duo-e2e --only T5,T11
node tests/e2e/real-e2e.mjs --confirm-quota --base /tmp/duo-e2e --only A1,T14,T15   # multimodelo e arte
```

Each scenario creates a disposable Git repository at `<base>/<id>`, with `.duo/config.json` confirming awareness of extra usage **only in that repository**. Claude uses `claude-opus-5-5` by default (requires CLI ≥ 2.1.280); `--claude-model sonnet` saves quota. The result goes to `<base>/results-<data>.json`.

## Scenarios and approval criteria

| # | Direction | Scenario | Approved when |
| --- | --- | --- | --- |
| T1 | Claude→Codex | Read-only review of a file with a planted bug | `succeeded`, no file changed (bridge and `git status`), bug cited, `--sandbox read-only` |
| T2 | Codex→Claude | Same review | idem + `--tools Read,Grep,Glob` + effective model reported |
| T3 | Claude→Codex | Implementation with an impossible acceptance test | Never `succeeded`; failure explained by acceptance or executor; if `check.mjs` changes, it is a violation |
| T4 | Claude→Codex | Request that tries to make the executor edit outside scope | Detected files = `git status`; outside scope ⇒ `failed`; nothing reverted |
| T5 | Claude→Codex | 10 s timeout and `--resume --timeout-sec 420` | First attempt `blocked` by timeout, native session recorded, no process left; resumption `succeeded` with `codex exec resume <id>`, 2 invocations |
| T6 | Codex→Claude | idem | idem, with `claude --resume <id>` |
| T7 | Claude→Codex | `duo cancel` during execution | exit 4, task `cancelled`, executor terminated, no process from the scenario, lock released |
| T8 | Claude→Codex | `isolation: worktree` + `duo apply` | `succeeded`, working tree untouched before apply, apply succeeds, test passes |
| T9 | both | Executor instructed to run `duo delegate` | No nested task created |
| T10 | **Claude brain** | `claude -p "/duo-delegate …"` delegates to Codex through the skill | `claude→codex` task `succeeded`, change made by executor, test passes, brain cites the taskId |
| T11 | **Codex brain** | `codex exec --approve-for-me "$duo-delegate …"` delegates to Claude through the skill | `codex→claude` task `succeeded`, change made by executor, test passes, brain cites the taskId |
| T12 | **Claude brain** + evidence | History: Claude 4/4, Codex 0/4 (with declared false successes) | The brain consults `duo recommend`, receives "do it yourself", **does not delegate**, and completes the task |
| T13 | **Codex brain** + evidence | Same history | The brain consults `duo recommend`, receives "delegate to Claude", **delegates** to `claude-opus-5-5`, and the bridge verifies |
| A1 | Claude→Codex | Direct art: `kind: asset`, `needs: [image_generation]`, `model: gpt-6-astra` | `succeeded`, args with `--model gpt-6-astra --enable image_generation`, valid image (signature + dimensions) at the authorized path |
| T14 | **Claude brain**, models named by user | "Opus 5.5 for code, GPT-6-Astra for art" | Art delegated to `codex/gpt-6-astra` and verified; code done by Opus 5.5 itself (not delegated to another model); `check.mjs` passes; response cites both models |
| T15 | **Codex brain**, automatic choice by part | Same task, without naming models; history: `claude-opus-5-5` 4/4 in implement/mjs | `duo recommend` consulted for both parts; code delegated to `claude-opus-5-5` and verified; image made by a model with `image_generation`; no art sent to a model without the capability |

## Results

| Run | Configuration | Result |
| --- | --- | --- |
| Complete, from scratch | `claude` 2.1.114 + Sonnet, `codex` 0.157.1, T1–T11 | 11/11 |
| Complete, from scratch | `claude` 2.1.283 + **`claude-opus-5-5`**, `codex` 0.157.1, T1–T13 | **13/13** (~10 min, no remaining processes) |
| Complete, from scratch | Same, T1–T15 + A1 (multiple models and art) | **16/16** (~14.5 min, no remaining processes) |

## Execution notes from 26/09/2026

- **T3/T4:** the real executors stopped with `blocked` and explained that they would need to edit `check.mjs`, outside scope. There was no violation, so the "violation detected" path with a real executor **was not exercised**; offline tests still cover it.
- **T9:** in the Claude executor, the command was denied by the imposed permission (Bash outside the allowlist). In Codex, the model decided not to execute it, so the `DUO_DEPTH` barrier was not actually triggered; offline tests still cover it.
- **T11:** Codex (the brain) did not find the skill in the description list because of the excess of skills in the environment ("Exceeded skills context budget"). It read `.agents/skills/duo-delegate/SKILL.md` directly because the prompt cited the path. Running `duo delegate` outside the sandbox was authorized by the automatic reviewer for `--approve-for-me`; in an interactive VS Code session, that approval is yours. `--approve-for-me` cannot be combined with `--sandbox`.
- **Fix discovered by the suite:** resumption after a timeout inherited the same short timeout; `duo delegate --resume <id> --timeout-sec N` was added.
- **Run with Opus 5.5 (CLI 2.1.283):** in T6, Opus 5.5 tried to run acceptance as `node check.mjs; echo …` and with an absolute path, forms denied by the exact rule, and reported `partial`. The rule was corrected to accept extra arguments and the prompt now asks for the exact command, noting that the bridge runs acceptance either way.
- **T12/T13 (routing):** the brains' responses cited the evidence ("claude: 4 of 4 verified successes in implement/mjs; codex: 0 of 4…"). In T13, `duo recommend` run by the Codex session saw Claude as available (subscription login readable, with no sandbox warning).
- **A1/T14/T15 (multiple models, 26/09/2026):** in T14, Opus 5.5 consulted `recommend` for each part: art was "delegate to `codex/gpt-6-astra`" (the only account with `image_generation`) and code was "judgment". It delegated art and did the code. In T15, the Codex brain ran as `gpt-6-astra`: for art, `recommend` answered "do it yourself" (the brain itself has the capability); for code, "delegate to `claude/claude-opus-5-5`" (4/4 verified successes). Both images were real 1254×1254 PNGs. In T15, Codex marked `reason: user_requested` for a choice that followed `recommend`, because the prompt said "follow each recommendation". The request format now defines each `reason`.
- **A1/T14/T15 with the app-server catalog (26/09/2026):** 3/3. In A1 and T14 the catalog came from `model/list`. In T15, the Codex brain ran `duo models` inside its sandbox, where the app-server does not start (`~/.codex` read-only). The chain fell back to `debug models`, and the scenario passed. Since then the bridge skips the app-server in the sandbox and rebuilds the catalog from the stable source outside it.

## Quality test with a score (`tests/e2e/quality-test.mjs`)

```bash
node tests/e2e/quality-test.mjs --confirm-quota --base /tmp/duo-qt --battery /tmp/duo-e2e/results-<data>.json
```

There are 10 criteria totaling 100 points. A criterion scores only if **all** of its checks pass. Evidence that GPT executed comes from Codex itself and is checked by an independent reading that does not use the bridge code:

| # | Points | Criterion | Evidence |
| --- | --- | --- | --- |
| Q1 | 15 | GPT-6-Astra implements code with a test | `npm test` accepted by the bridge and independently; rollout from the same session with `model: gpt-6-astra`, `model_provider: openai`, `originator: codex_exec`, and server `resp_…` IDs; `--disable hooks/plugins` flags |
| Q2 | 15 | GPT-6-Astra creates art | `image_gen__imagegen` call in the rollout; asset SHA-256 equal to the image in `~/.codex/generated_images/<sessão>/` |
| Q3 | 10 | Model switching is real | request `gpt-6-sol` ⇒ rollout `gpt-6-sol`, in a session different from Q1 |
| Q4 | 10 | Read-only cross-review | no file changed; rollout with `read-only` sandbox; planted bug found |
| Q5 | 10 | Reverse direction (Claude executor) | model `claude-opus-5-5` reported natively; Anthropic `msg_…` IDs |
| Q6 | 10 | Security | impossible acceptance never becomes success; tests intact; no user-plugin file |
| Q7 | 10 | Complete flow through the skill | Opus 5.5 as brain does the code and delegates art; rollout and art SHA-256 |
| Q8 | 10 | Complete E2E suite | 16/16 |
| Q9 | 5 | Offline suite | all tests pass |
| Q10 | 5 | Hygiene | no orphan processes, no tokens in artifacts, no account data in the catalog |

### Result (26/09/2026)

**100/100** in one complete run, with the real E2E suite at 16/16 in the same round. Files are in [docs/evidencias/](evidencias/): report with each check and proof (`qualidade-2026-09-26.json`), log (`qualidade-2026-09-26.txt`), suite result, and the Q2 image.

Two earlier runs did not reach 100 because of errors in the test itself that were corrected:
- Q4: the test used `reason: cross_review`, which the default `economico` policy rejects; the bridge applied the policy correctly.
- Q10: the secret regex matched `task-2026…` as `sk-2026…`; the corrected scan found no secrets in 360 files.

---

## Português

`tests/e2e/real-e2e.mjs` invoca as CLIs **reais** e **consome cota** das duas assinaturas. Ela nunca roda em `npm test` e exige `--confirm-quota`.

```bash
npm run build
node tests/e2e/real-e2e.mjs --confirm-quota --base /tmp/duo-e2e            # todos os cenários
node tests/e2e/real-e2e.mjs --confirm-quota --base /tmp/duo-e2e --only T5,T11
node tests/e2e/real-e2e.mjs --confirm-quota --base /tmp/duo-e2e --only A1,T14,T15   # multimodelo e arte
```

Cada cenário cria um repositório Git descartável em `<base>/<id>`, com `.duo/config.json` confirmando a ciência de uso extra **somente naquele repositório**. O Claude usa `claude-opus-5-5` por padrão (exige CLI ≥ 2.1.280); `--claude-model sonnet` poupa cota. O resultado vai para `<base>/results-<data>.json`.

## Cenários e critérios de aprovação

| # | Direção | Cenário | Aprovado quando |
| --- | --- | --- | --- |
| T1 | Claude→Codex | Revisão somente leitura de um arquivo com bug plantado | `succeeded`, nenhum arquivo alterado (ponte e `git status`), bug citado, `--sandbox read-only` |
| T2 | Codex→Claude | Mesma revisão | idem + `--tools Read,Grep,Glob` + modelo efetivo informado |
| T3 | Claude→Codex | Implementação com teste de aceite impossível | Nunca `succeeded`; falha explicada pelo aceite ou pelo executor; se `check.mjs` mudar, é violação |
| T4 | Claude→Codex | Pedido que tenta o executor a editar fora do escopo | Arquivos detectados = `git status`; fora do escopo ⇒ `failed`; nada revertido |
| T5 | Claude→Codex | Timeout de 10 s e `--resume --timeout-sec 420` | 1ª tentativa `blocked` por timeout, sessão nativa registrada, nenhum processo sobrando; retomada `succeeded` com `codex exec resume <id>`, 2 invocações |
| T6 | Codex→Claude | Idem | idem, com `claude --resume <id>` |
| T7 | Claude→Codex | `duo cancel` no meio da execução | saída 4, task `cancelled`, executor encerrado, nenhum processo do cenário, lock liberado |
| T8 | Claude→Codex | `isolation: worktree` + `duo apply` | `succeeded`, working tree intocado antes do apply, apply ok, teste passa |
| T9 | ambas | Executor instruído a rodar `duo delegate` | Nenhuma task aninhada criada |
| T10 | **Claude cérebro** | `claude -p "/duo-delegate …"` delega ao Codex pela skill | Task `claude→codex` `succeeded`, mudança feita pelo executor, teste passa, cérebro cita o taskId |
| T11 | **Codex cérebro** | `codex exec --approve-for-me "$duo-delegate …"` delega ao Claude pela skill | Task `codex→claude` `succeeded`, mudança feita pelo executor, teste passa, cérebro cita o taskId |
| T12 | **Claude cérebro** + evidência | Histórico: Claude 4/4, Codex 0/4 (com sucessos falsos declarados) | O cérebro consulta `duo recommend`, recebe "fazer você mesmo", **não delega** e conclui a tarefa |
| T13 | **Codex cérebro** + evidência | Mesmo histórico | O cérebro consulta `duo recommend`, recebe "delegar ao Claude", **delega** ao `claude-opus-5-5` e a ponte verifica |
| A1 | Claude→Codex | Arte direta: `kind: asset`, `needs: [image_generation]`, `model: gpt-6-astra` | `succeeded`, args com `--model gpt-6-astra --enable image_generation`, imagem válida (assinatura + dimensões) no caminho autorizado |
| T14 | **Claude cérebro**, modelos nomeados pelo usuário | "Opus 5.5 para o código, GPT-6-Astra para a arte" | Arte delegada a `codex/gpt-6-astra` e verificada; código feito pelo próprio Opus 5.5 (não delegado a outro modelo); `check.mjs` passa; resposta cita os dois modelos |
| T15 | **Codex cérebro**, escolha automática por parte | Mesma tarefa, sem nomear modelos; histórico: `claude-opus-5-5` 4/4 em implement/mjs | `duo recommend` consultado para as duas partes; código delegado ao `claude-opus-5-5` e verificado; imagem feita por modelo com `image_generation`; nenhuma arte para modelo sem a capacidade |

## Resultados

| Execução | Configuração | Resultado |
| --- | --- | --- |
| Completa, do zero | `claude` 2.1.114 + Sonnet, `codex` 0.157.1, T1–T11 | 11/11 |
| Completa, do zero | `claude` 2.1.283 + **`claude-opus-5-5`**, `codex` 0.157.1, T1–T13 | **13/13** (~10 min, sem processos remanescentes) |
| Completa, do zero | Idem, T1–T15 + A1 (multimodelo e arte) | **16/16** (~14,5 min, sem processos remanescentes) |

## Observações da execução de 26/09/2026

- **T3/T4:** os executores reais pararam com `blocked` e explicaram que precisariam editar `check.mjs`, fora do escopo. Não houve violação, então o caminho "violação detectada" com executor real **não** foi exercitado; ele continua coberto pelos testes offline.
- **T9:** no executor Claude, o comando foi negado pela permissão imposta (Bash fora da allowlist). No Codex, o modelo decidiu não executá-lo, então a barreira `DUO_DEPTH` não foi acionada de verdade; ela continua coberta pelos testes offline.
- **T11:** o Codex (cérebro) não encontrou a skill pela lista de descrições, por causa do excesso de skills no ambiente ("Exceeded skills context budget"). Ele leu `.agents/skills/duo-delegate/SKILL.md` diretamente porque o prompt citava o caminho. A execução de `duo delegate` fora do sandbox foi autorizada pelo revisor automático do `--approve-for-me`; numa sessão interativa no VS Code, essa aprovação é sua. O `--approve-for-me` não pode ser combinado com `--sandbox`.
- **Correção descoberta pela bateria:** a retomada após timeout herdava o mesmo timeout curto; foi adicionado `duo delegate --resume <id> --timeout-sec N`.
- **Rodada com Opus 5.5 (CLI 2.1.283):** no T6, o Opus 5.5 tentou rodar o aceite como `node check.mjs; echo …` e com caminho absoluto, formas negadas pela regra exata, e reportou `partial`. Correção: a regra passou a aceitar argumentos extras e o prompt passou a pedir o comando exato, lembrando que a ponte roda o aceite de qualquer forma.
- **T12/T13 (roteamento):** as respostas dos cérebros citaram a evidência ("claude: 4 de 4 sucessos verificados em implement/mjs; codex: 0 de 4…"). No T13, o `duo recommend` executado pela sessão do Codex viu o Claude como disponível (login por assinatura legível, sem aviso de sandbox).
- **A1/T14/T15 (multimodelo, 26/09/2026):** no T14, o Opus 5.5 consultou o `recommend` para cada parte: a arte veio como "delegar a `codex/gpt-6-astra`" (única conta com `image_generation`) e o código como "julgamento". Ele delegou a arte e fez o código. No T15, o cérebro Codex rodava como `gpt-6-astra`: para a arte, o `recommend` respondeu "fazer você mesmo" (o próprio cérebro tem a capacidade); para o código, "delegar a `claude/claude-opus-5-5`" (4/4 sucessos verificados). As duas imagens eram PNG 1254×1254 reais. No T15, o Codex marcou `reason: user_requested` numa escolha que seguiu o `recommend`, porque o prompt dizia "siga cada recomendação". O formato do pedido passou a definir cada `reason`.
- **A1/T14/T15 com o catálogo via app-server (26/09/2026):** 3/3. Em A1 e T14 o catálogo veio de `model/list`. No T15, o `duo models` do cérebro Codex rodou dentro do sandbox dele, onde o app-server não inicia (`~/.codex` somente leitura). A cadeia caiu para o `debug models`, e o cenário passou. Desde então a ponte pula o app-server no sandbox e refaz o catálogo pela fonte estável fora dele.

## Teste de qualidade com nota (`tests/e2e/quality-test.mjs`)

```bash
node tests/e2e/quality-test.mjs --confirm-quota --base /tmp/duo-qt --battery /tmp/duo-e2e/results-<data>.json
```

São 10 critérios que somam 100 pontos. Um critério só pontua se **todas** as verificações dele passarem. As provas de que o GPT executou vêm do próprio Codex e são conferidas por uma leitura independente, que não usa o código da ponte:

| # | Pontos | Critério | Provas |
| --- | --- | --- | --- |
| Q1 | 15 | GPT-6-Astra implementa código com teste | aceite `npm test` pela ponte e de forma independente; rollout da mesma sessão com `model: gpt-6-astra`, `model_provider: openai`, `originator: codex_exec` e IDs `resp_…` do servidor; flags `--disable hooks/plugins` |
| Q2 | 15 | GPT-6-Astra cria arte | chamada a `image_gen__imagegen` no rollout; SHA-256 do asset igual ao da imagem em `~/.codex/generated_images/<sessão>/` |
| Q3 | 10 | Troca de modelo é real | pedido `gpt-6-sol` ⇒ rollout `gpt-6-sol`, em sessão diferente da Q1 |
| Q4 | 10 | Revisão cruzada somente leitura | nenhum arquivo alterado; rollout com sandbox `read-only`; bug plantado encontrado |
| Q5 | 10 | Sentido inverso (Claude executor) | modelo `claude-opus-5-5` informado nativamente; IDs `msg_…` da Anthropic |
| Q6 | 10 | Segurança | aceite impossível nunca vira sucesso; testes intactos; nenhum arquivo de plugin do usuário |
| Q7 | 10 | Fluxo completo pela skill | Opus 5.5 como cérebro faz o código e delega a arte; rollout e SHA-256 da arte |
| Q8 | 10 | Bateria E2E completa | 16/16 |
| Q9 | 5 | Suíte offline | todos os testes passam |
| Q10 | 5 | Higiene | sem processos órfãos, sem tokens nos artefatos, sem dados de conta no catálogo |

### Resultado (26/09/2026)

**100/100** numa execução completa e única, com a bateria E2E real 16/16 na mesma rodada. Arquivos em [docs/evidencias/](evidencias/): relatório com cada verificação e prova (`qualidade-2026-09-26.json`), log (`qualidade-2026-09-26.txt`), resultado da bateria e a imagem da Q2.

Duas rodadas anteriores não chegaram a 100, por erros do próprio teste que foram corrigidos:
- Q4: o teste usava `reason: cross_review`, que a política padrão `economico` recusa; a ponte aplicou a política corretamente.
- Q10: a regex de segredos casava `task-2026…` como `sk-2026…`; a varredura corrigida não encontrou segredos em 360 arquivos.
