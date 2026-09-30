# Formato do pedido de delegação (`schemas/delegation-request.schema.json`)

Cérebro desta sessão: **{{BRAIN}}**. Executor: **{{EXECUTOR}}**.

```json
{
  "version": 1,
  "brain": "{{BRAIN}}",
  "executor": "{{EXECUTOR}}",
  "kind": "implement",
  "objective": "Adicionar validação de e-mail em src/forms/signup.ts e testes correspondentes.",
  "reason": "clear_benefit",
  "rationale": "Subtarefa isolada em 2 arquivos; duo recommend indicou {{EXECUTOR}} (melhor evidência em implement/ts).",
  "risk": "low",
  "scope": { "allowedPaths": ["src/forms/signup.ts", "tests/forms/signup.test.ts"] },
  "constraints": ["Não adicionar dependências", "Manter a API pública de signup()"],
  "context": {
    "interfaces": "export function signup(input: { email: string; password: string }): Result",
    "decisions": ["Usar a regex já existente em src/lib/validators.ts"]
  },
  "acceptance": {
    "criteria": ["E-mails inválidos retornam erro EMAIL_INVALID", "Testes existentes continuam passando"],
    "commands": [{ "name": "tests", "argv": ["npm", "test"] }]
  },
  "isolation": "in-place"
}
```

## Campos

| Campo | Obrigatório | Observação |
| --- | --- | --- |
| `kind` | sim | `implement`, `test` e `asset` (arte/mídia) podem escrever no escopo; `review` e `investigate` são somente leitura (qualquer alteração é violação). |
| `reason` | sim | `user_requested` (o usuário nomeou este executor/modelo para esta parte), `clear_benefit` (o `duo recommend` ou um benefício concreto indicou este executor), `blocked_or_failure` (você tentou e falhou), `second_opinion`, `cross_review`. A política do projeto limita quais são aceitos. |
| `rationale` | sim | Justificativa breve e útil. Não inclua raciocínio interno. Se a escolha contrariar o `duo recommend`, diga por quê. |
| `risk` | não | `low`, `medium` (padrão) ou `high`. Entra na evidência do roteador e orienta revisão cruzada. |
| `scope.allowedPaths` | sim | Arquivos ou diretórios relativos ao projeto. Sem `..`, sem caminhos absolutos, sem symlinks, sem `.env`/credenciais/`.git`/`.duo`. `"."` só em tarefas de leitura. |
| `acceptance.criteria` | sim | Critérios verificáveis. |
| `acceptance.commands` | não | Executados pela ponte, sem shell, somente se o prefixo estiver em `acceptance.allowedCommands` do `.duo/config.json`. |
| `runId` | não | Reutilize o `runId` devolvido pela primeira delegação para somar ao mesmo run (o limite de invocações é por run). |
| `taskKey` | não | Chave de idempotência: repetir um pedido idêntico já concluído devolve o resultado sem nova invocação. |
| `isolation` | não | `in-place` (padrão) ou `worktree` (worktree Git descartável; integre com `duo apply`). Worktree isola mudanças Git, não é sandbox de segurança. |
| `model` | não | ID do catálogo (`duo models`). Se omitido, a seleção adaptativa escolhe dentro do `executor` já informado. Explícito, força o modelo e é preservado em escaladas. |
| `effort` | não | `low`, `medium`, `high`, `xhigh` ou `max`; explícito, é preservado em escaladas. |
| `complexity` | não | `light`, `standard` ou `deep`; força o nível solicitado. Pisos de risco continuam valendo. |
| `adaptive` | não | `false` restaura o comportamento pré-adaptativo; o padrão é seleção adaptativa. |
| `brainModel` | não | Seu próprio modelo; evita delegar ao mesmo modelo que você já é. |
| `needs` | não | Capacidades exigidas, ex.: `["image_generation"]` (exige `kind: "asset"`). |
| `limits.timeoutSec` | não | Timeout desta delegação. |

## Seleção adaptativa

`duo recommend` devolve `tier`, `effort` e `selection`, além do executor/modelo. Use `duo recommend --request <pedido.json>` para fornecer objetivo, escopo e aceite reais; sem aceite no modo abreviado, o piso é `standard`. O cérebro deve informar o `executor` escolhido e pode omitir `model` para deixar a ponte selecionar dentro dele. Risco alto ou sensível exige `deep`; `light` só vale para baixo risco, poucos arquivos, sem diretório no escopo e com comandos de aceite.

Só há downgrade com evidência suficiente e sucesso igual ou superior a `routing.adaptive.downgradeMinSuccess`, sempre respeitando esses pisos. Falha de verificação escala `light → standard → deep`; `maxAttempts` conta a primeira tentativa e `deep` usa `xhigh` quando suportado. `model` explícito não troca; `effort` explícito permanece e, sem ele, só aumenta com suporte. Falhas de infraestrutura não escalam. Em `worktree`, cada tentativa recebe um worktree novo e o anterior fica preservado; em `in-place`, só se repete sem alterações deixadas pelo executor.

Uso extra exige `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` e inclusão do modelo em `routing.include`. Para desligar a seleção adaptativa no pedido, use `adaptive: false`; pela CLI, use `duo delegate --no-adaptive`.

## Exemplo de arte (modelo com geração de imagem)

```json
{
  "version": 1,
  "brain": "{{BRAIN}}",
  "executor": "codex",
  "model": "gpt-6-astra",
  "brainModel": "<seu modelo>",
  "kind": "asset",
  "needs": ["image_generation"],
  "objective": "Criar uma ilustração quadrada, estilo flat, do mascote para a tela inicial, salva em assets/mascote.png.",
  "reason": "clear_benefit",
  "rationale": "duo recommend: só o Codex tem image_generation nas contas conectadas; gpt-6-astra é o recomendado pelo fornecedor.",
  "scope": { "allowedPaths": ["assets/"] },
  "acceptance": { "criteria": ["assets/mascote.png existe e é uma imagem válida"] }
}
```

O executor pode ser o **mesmo cliente do cérebro** quando `model` indica outro modelo (ex.: cérebro GPT-6-Sol → arte com GPT-6-Astra).

## Exemplo de revisão cruzada (somente leitura)

```json
{
  "version": 1,
  "brain": "{{BRAIN}}",
  "executor": "{{EXECUTOR}}",
  "kind": "review",
  "objective": "Revisar a migração de sessão em src/auth/ procurando regressões de segurança e casos de borda.",
  "reason": "cross_review",
  "rationale": "Mudança de alto risco em autenticação; segunda leitura independente antes do commit.",
  "scope": { "allowedPaths": ["src/auth/"] },
  "acceptance": { "criteria": ["Listar achados com arquivo:linha e severidade", "Não modificar arquivos"] }
}
```
