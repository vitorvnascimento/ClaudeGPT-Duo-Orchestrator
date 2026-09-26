# Exemplos

Os comandos abaixo usam `$DUO`: com o duo instalado, `DUO=duo`; num clone sem `npm link`, `DUO="node /caminho/duo-orchestrator/dist/src/cli/main.js"`. As saídas mostradas vêm dos testes com CLIs simuladas; em uso real, os números virão das CLIs oficiais.

## 1. Tarefa resolvida sem delegação

Pedido do usuário ao Claude Code (cérebro): *"renomeie a variável `usr` para `user` em src/profile.ts"*.

O cérebro segue `reference/decision-guide.md`: é uma mudança pequena, em um arquivo, que ele já entende. **Não delega.** Faz a edição e roda `npm test` diretamente, a ferramenta determinística que basta aqui. Nenhuma chamada à ponte, nenhum consumo da outra assinatura.

## 2. Claude coordena Codex (implementação delimitada)

```bash
mkdir -p .duo/requests
cp examples/claude-coordena-codex.implementacao.json .duo/requests/slugify.json
$DUO delegate --request .duo/requests/slugify.json
```

Saída (resumida):

```json
{
  "taskId": "task-20260926134653-cc6bdb",
  "runId": "run-20260926134653-e6722d",
  "state": "succeeded",
  "outcome": "concluído e verificado",
  "executor": "codex",
  "filesChanged": ["src/lib/slug.ts", "tests/slug.test.ts"],
  "outOfScope": [],
  "claimsMismatch": [],
  "acceptance": [{ "name": "tests", "ran": true, "passed": true, "exitCode": 0 }],
  "diff": ".duo/runs/…/changes.diff",
  "model": { "requested": null, "reported": null, "reportedSource": "unavailable" },
  "metrics": { "wallMs": 48210, "nativeSource": "native",
               "nativeUsage": { "input_tokens": 24763, "cached_input_tokens": 24448, "output_tokens": 122, "reasoning_output_tokens": 64 } },
  "next": ["revisar o diff: …", "registrar decisão: duo accept --task-id … --note \"...\""]
}
```

O cérebro revisa o diff, integra e registra: `$DUO accept --task-id task-… --note "integrado ao formulário"`.

Se o executor tivesse declarado `completed` mas `npm test` falhasse, o estado seria `failed`, com `outcome: "critério de aceite falhou apesar do relatório \"completed\": tests (exit 1)"`.

## 3. Codex coordena Claude (revisão cruzada útil)

A troca de autenticação é de alto risco, e o usuário pediu uma segunda leitura. Na sessão do Codex:

```bash
cp examples/codex-coordena-claude.revisao-cruzada.json .duo/requests/review-auth.json
$DUO delegate --request .duo/requests/review-auth.json
```

- O Codex pedirá aprovação para rodar o comando fora do sandbox, porque ele inicia o Claude Code, que precisa de rede e login. Aprove **esse comando**.
- O executor Claude roda com `--tools Read,Grep,Glob` e `--permission-mode dontAsk`: não consegue editar nem usar o shell. Se algum arquivo mudar, a task vira `failed`.
- `reason: "user_requested"` passa na política `economico`. Com `second_opinion` seria preciso `policy: "equilibrado"`, e com `cross_review`, `policy: "qualidade"`.

## 4. Bloqueios esperados

| Situação | Estado | `outcome` (trecho) |
| --- | --- | --- |
| Terceira invocação no mesmo run | `blocked` | `limite de 2 invocações delegadas por run atingido` |
| `ANTHROPIC_API_KEY` definida em `~/.claude/settings.json` (bloco `env`) | `blocked` | `bloco env define ANTHROPIC_API_KEY` |
| Codex logado com API key | `blocked` | `método de autenticação do codex = api_key` |
| Cota do executor esgotada | `blocked` | `limite/cota do claude atingido … Sem nova tentativa automática` |
| `allowedPaths: ["../outro-projeto"]` | `blocked` | `escopo inválido: caminho fora do projeto` |

## 5. Retomar, cancelar, trocar de cérebro

```bash
$DUO status                                   # detecta interrupções
$DUO delegate --resume task-…                 # após timeout/login/reset de cota
$DUO cancel --run-id run-…                    # encerra ponte + executor
$DUO handoff --to codex --next "integrar slugify no formulário"
```

## Projeto de demonstração

[`duo-demo/`](duo-demo/): página inicial feita numa sessão real, com o layout do Claude (Opus 5.5) e a ilustração do GPT-6-Astra (Codex). Inclui instruções para refazer do zero.
