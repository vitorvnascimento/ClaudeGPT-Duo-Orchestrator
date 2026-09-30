# ClaudeGPT - Duo Orchestrator by Fusic

**Claude Code e Codex trabalhando juntos no seu VS Code, cada parte da tarefa feita pelo modelo que faz melhor, usando as CLIs oficiais e as suas próprias assinaturas.**

Você conversa normalmente com o Claude Code (ou com o Codex). Quando a tarefa tem partes diferentes, por exemplo código e uma ilustração, a IA que você abriu (o **cérebro**) usa a skill `duo-delegate` para mandar cada parte ao melhor modelo disponível nas suas contas: o Opus 5.5 no código e o GPT-6-Astra na arte, por exemplo. A ponte `duo` executa a outra CLI e **confere o resultado de forma independente** (arquivos alterados, testes, imagem válida) antes de devolver ao cérebro.

```text
Você: "/duo-delegate crie a página inicial e uma ilustração de um robô em assets/robo.png"

Claude (Opus 5.5, cérebro)  ── faz o HTML/CSS
          │
          └─ duo delegate ──▶ Codex (GPT-6-Astra) ── gera assets/robo.png
                               │
                               └─ ponte confere: só assets/ mudou, PNG válido 1254×1254,
                                  modelo efetivo gpt-6-astra (registro do próprio Codex)
```

> **Estado (v0.2.0, setembro de 2026):** 239 testes offline, bateria E2E real 16/16 e teste de qualidade real **100/100** com provas independentes de qual modelo executou cada parte ([docs/e2e-real.md](docs/e2e-real.md), [docs/evidencias/](docs/evidencias/)). Testado no macOS; Windows e Linux ainda não foram testados.

<details>
<summary><strong>English summary</strong></summary>

**ClaudeGPT - Duo Orchestrator by Fusic** (`duo-orchestrator`) is a local bridge that lets **Claude Code** and **OpenAI Codex** work together through their official CLIs and your own subscriptions (no API keys, no gateway). The agent you are talking to (the *brain*) delegates bounded subtasks to the best available model in your connected accounts, e.g. Opus 5.5 for code and GPT-6-Astra for images. The bridge runs the other CLI, then independently verifies scope, diffs, acceptance tests and images, and records which model actually ran (read from Codex's own session log). Install with `git clone … && npm ci && npm link` (or the release `.tgz`), run `duo init --apply` inside a Git project, and use `/duo-delegate` in Claude Code or `$duo-delegate` in Codex. Docs are in Portuguese.

</details>

## O que o projeto é e o que não é

| É | Não é |
| --- | --- |
| Uma ponte local que chama `codex exec` e `claude -p` oficiais | Um gateway que reutiliza tokens para chamar endpoints privados |
| Uso individual, cada cliente com seu próprio login oficial | Um serviço que oferece login de assinaturas a terceiros |
| Perfil `subscription-only`, que bloqueia API, gateway e nuvem | Uma API paga disfarçada ou fallback automático de cobrança |
| Um cérebro por tarefa e um executor ativo por vez | Um enxame autônomo ou uma terceira IA planejadora |

## Requisitos

| Item | Como conseguir |
| --- | --- |
| **Node.js 22.12+** e **Git** | [nodejs.org](https://nodejs.org) (ou `brew install node`) |
| **Claude Code CLI 2.1.280+** com assinatura Pro/Max | `npm install -g @anthropic-ai/claude-code`, depois `claude` e `/login`. Já tem? `claude update` |
| **Codex CLI** com conta ChatGPT (Plus/Pro) | `npm install -g @openai/codex`, depois `codex login` |

As extensões do VS Code não colocam as CLIs no PATH: instale as CLIs mesmo que já use as extensões. Confira com `claude --version` e `codex --version`.

Você pode usar só uma das duas contas, mas o objetivo do projeto é combinar as duas.

## Instalação rápida

**Opção 1 — clonar e linkar (recomendado; fácil de atualizar):**

```bash
git clone https://github.com/vitorvnascimento/duo-orchestrator.git
cd duo-orchestrator
npm ci          # instala só typescript e @types/node e compila
npm link        # coloca o comando duo no PATH
duo --version
```

Para atualizar depois: `git pull && npm ci`. Para rodar os testes offline (nenhum modelo é invocado): `npm test`.

**Opção 2 — pacote pronto da release (sem compilar):**

```bash
npm install -g https://github.com/vitorvnascimento/duo-orchestrator/releases/download/v0.2.0/duo-orchestrator-0.2.0.tgz
duo --version
```

Ou baixe com o GitHub CLI e instale o arquivo local:

```bash
gh release download v0.2.0 -R vitorvnascimento/duo-orchestrator -p "*.tgz"
npm install -g ./duo-orchestrator-0.2.0.tgz
```

Sem `npm link` ou instalação global, use `node /caminho/duo-orchestrator/dist/src/cli/main.js` no lugar de `duo`. **Remover:** `npm uninstall -g duo-orchestrator` (ou `npm unlink -g duo-orchestrator`).

### Atualizações

O `duo` avisa quando sai uma versão nova: no máximo uma vez por dia, em segundo plano, ele consulta a última release pública deste repositório no GitHub e, se houver versão mais nova, mostra no terminal (stderr, sem atrapalhar saídas `--json`):

```text
duo: nova versão 0.3.0 disponível (instalada: 0.2.0). Novidades: https://github.com/vitorvnascimento/duo-orchestrator/releases/tag/v0.3.0
     Atualize com: duo update --apply   (desligar aviso: DUO_NO_UPDATE_CHECK=1)
```

- `duo update` consulta na hora; `duo update --apply` instala a nova versão (`npm install -g` do `.tgz` oficial da release).
- A consulta é anônima: não envia token, login, e-mail nem variáveis de ambiente, e só aceita uma release estável deste repositório com o `.tgz` esperado. Nada é instalado sem você pedir.
- Não consulta dentro dos executores, em CI, no sandbox do Codex nem com `DUO_NO_UPDATE_CHECK=1`.
- Só o mantenedor publica releases; o repositório é público para leitura e uso.

> `npm install -g github:vitorvnascimento/duo-orchestrator` **não** é recomendado: nesse modo o npm 10 não prepara corretamente pacotes que precisam compilar. Use uma das opções acima.

## Primeiro uso (5 minutos)

**1. Ative num projeto** (precisa ser um repositório Git):

```bash
cd ~/meu-projeto
duo init            # mostra o que vai criar, sem gravar nada
duo init --apply    # cria .duo/config.json e as skills do Claude e do Codex
```

Isso cria `.claude/skills/duo-delegate/`, `.agents/skills/duo-delegate/` e `.duo/config.json`, e adiciona `.duo/` ao `.gitignore`. Se `duo` estiver no PATH, as skills chamam só `duo`, e o projeto funciona em qualquer máquina com o duo instalado.

**2. Revise `.duo/config.json`:**

- `acceptance.allowedCommands`: comandos que a ponte pode rodar para conferir o trabalho, como `[["npm","test"]]`. Se o projeto tem `npm test`, ele já vem configurado.
- `billing.acknowledgeUnverifiableExtraUsage`: **trava de proteção**. Nenhuma CLI informa se o uso extra ou os créditos estão ligados na sua conta. Confira nas configurações do claude.ai e do ChatGPT e, estando desligado (ou sendo algo que você aceita), mude para `true` a conta que vai receber delegações. Enquanto estiver `false`, a delegação para aquela conta fica bloqueada. Detalhes em [docs/autenticacao.md](docs/autenticacao.md).

```json
"billing": { "profile": "subscription-only", "acknowledgeUnverifiableExtraUsage": { "claude": true, "codex": true } }
```

**3. Confira:**

```bash
duo doctor    # as duas direções devem aparecer como "pronto"
duo models    # modelos disponíveis nas suas contas (não consome cota)
```

**4. Use.** Abra o projeto no VS Code e peça ao Claude Code:

```text
/duo-delegate adicione a função formatarPreco em src/preco.js com testes, e crie um ícone de carrinho em assets/carrinho.png
```

Ou peça ao Codex, invocando a skill pelo nome:

```text
$duo-delegate revise src/auth/ procurando falhas de segurança
```

Quando o cérebro pedir permissão para rodar `duo delegate`, aprove esse comando. A parte delegada leva de 30 segundos a 2 minutos. No Codex, ele pede para rodar fora do sandbox, porque precisa de rede e do login do Claude.

**5. Acompanhe:** `duo status` (o que foi delegado), `duo report` (tempo, tokens e a origem de cada número).

## Uso no dia a dia

- **Deixe a escolha com a evidência:** sem nomear modelos, o cérebro consulta `duo recommend`, que escolhe pelo histórico verificado do seu projeto e pelas capacidades (arte só vai para modelos que geram imagem). Num projeto novo, a primeira escolha é por julgamento e melhora com o uso.
- **Ou nomeie os modelos:** *"use Opus 5.5 no código e GPT-6-Astra na arte"*. O cérebro segue a sua escolha, desde que o modelo exista na sua conta (`duo models`).
- **Revisão cruzada:** *"implemente X e peça ao Codex para revisar"*. A revisão roda em modo somente leitura.
- **Trocar o cérebro no meio do trabalho:** `duo handoff --to codex --next "..."` gera um documento em `.duo/handoffs/` para abrir na outra IA.
- **Outro computador:** instale o duo (Opção 1 ou 2), faça login nas duas CLIs e pronto. Se o projeto já tem as skills versionadas e o `duo` está no PATH, não precisa rodar `init` de novo.

Dicas:
- No Codex com muitas skills instaladas, ele pode não achar a skill sozinho ("Exceeded skills context budget"). Invoque `$duo-delegate` explicitamente.
- Não edite os arquivos do escopo enquanto o executor roda: a ponte detecta a mudança e reprova a tarefa.
- Em páginas HTML abertas direto do disco no Safari, imagens em pastas acima da página não carregam. Deixe o HTML na raiz e as imagens em subpastas.

## Windows (não testado)

A ponte executa processos **sem shell**. Shims `.cmd` (como o `claude.cmd` do npm) exigiriam shell, então a ponte os recusa. Use o `.exe` oficial (o instalador nativo do Claude Code gera `claude.exe`) ou configure em `.duo/config.json`:

```json
{ "executors": { "claude": { "command": ["C:\\Users\\voce\\.local\\bin\\claude.exe"] },
                 "codex":  { "command": ["node", "C:\\caminho\\para\\@openai\\codex\\bin\\codex.js"] } } }
```

O código foi escrito para ser portável (`taskkill /T /F` para encerrar processos), mas os testes rodaram apenas no macOS. Relatos e correções são bem-vindos.

## Comandos

| Comando | O que faz |
| --- | --- |
| `duo doctor [--json]` | Diagnóstico sem inferência: versões, flags suportadas (lidas do `--help`), método de autenticação pelo status oficial, conflitos de cobrança, hooks/MCP, outros coordenadores. |
| `duo init [--brain claude\|codex] [--apply] [--overwrite]` | Config e skills do projeto com preview/diff e backup. |
| `duo delegate --request <arquivo>` | Executa um pedido do cérebro (formato em `schemas/delegation-request.schema.json`). Imprime um JSON final. |
| `duo delegate --resume <taskId> [--timeout-sec N]` | Retoma uma task `blocked` (timeout, interrupção, cota, login…), reutilizando a sessão nativa; `--timeout-sec` dá mais tempo à retomada. |
| `duo models [--refresh] [--json]` | Modelos disponíveis nas contas conectadas (Claude e Codex), com recomendado/legado do fornecedor, sucessor e aposentadoria, ferramentas (ex.: geração de imagem) e a fonte usada. Sem inferência; cache de 24 h (1 h se alguma fonte estiver degradada). |
| `duo recommend --kind … [--needs image_generation] [--paths …] [--risk …] [--brain …] [--brain-model …]` | Melhor modelo disponível para a subtarefa (filtro por capacidade + evidência medida + disponibilidade). Diz se é para delegar (a qual cliente e modelo) ou fazer você mesmo. Sem preferência de marca. |
| `duo status [--run-id]` | Runs e tasks. Detecta interrupções (ponte morta) e marca como `blocked`. |
| `duo report [--run-id] [--json]` | Relatório determinístico com a origem de cada número. |
| `duo cancel --run-id <id>` | Encerra ponte e executor (árvore de processos) e marca `cancelled`. |
| `duo apply --task-id <id>` | Integra o patch de uma task `worktree`, só se a base não mudou. |
| `duo accept --task-id <id> [--reject] --note "..."` | Registra a decisão do cérebro (tarefas aceitas entram na métrica). |
| `duo handoff --to <cliente>` | Documento de handoff para trocar o cérebro. |
| `duo quota show` / `duo quota set …` | Cota informada manualmente, com data e expiração. |
| `duo update [--apply]` | Procura nova versão (release pública, sem credenciais) e, com `--apply`, instala. |

Códigos de saída de `delegate`: `0` succeeded, `1` failed, `2` pedido inválido, `3` blocked, `4` cancelled.

## Vários modelos, o melhor para cada parte

A ponte não se limita a "Claude ou Codex": ela trabalha com **modelos**.

- **`duo models`** descobre o que as contas conectadas oferecem, sem inferência. No Claude, usa o handshake `initialize` (o mesmo do `supportedModels()` do Agent SDK). No Codex, usa o `model/list` e o `modelProvider/capabilities/read` do `codex app-server`, métodos da superfície estável do protocolo que a extensão do VS Code usa. Se uma fonte falhar ou mudar de formato, a ponte cai para a seguinte: `codex debug models`, depois o último catálogo bom (marcado como desatualizado), depois `routing.candidates`. O `duo doctor` confere o contrato do protocolo localmente e avisa antes de algo quebrar. Exemplo de conta: Opus 5.5, Sonnet 5, Fable 5.1, Haiku 4.5 e outros no Claude; GPT-6-Astra, GPT-6-Sol, GPT-6-Luna e a família 5.x no Codex, além da ferramenta **`image_generation`**.
- **Cada subtarefa declara o que exige:** `kind: "asset"` + `needs: ["image_generation"]` para arte. O roteador só considera modelos com essa capacidade.
- **Qualquer modelo, qualquer cérebro:** a delegação pode ir para o **mesmo cliente com outro modelo** (ex.: cérebro GPT-6-Sol → arte com GPT-6-Astra; cérebro Opus 5.5 → tarefa simples com Sonnet 5). Só é recusado delegar ao mesmo modelo que o cérebro já é.
- **A ponte valida antes e depois:** bloqueia um `model` que não exista na conta (listando os disponíveis) e, em arte, confere a assinatura binária da imagem gravada no escopo (PNG/JPEG/WebP/GIF). Um "completed" sem imagem válida vira `failed`.

Exemplo validado com as CLIs reais (E2E A1): pedido de arte ao `codex` com `model: "gpt-6-astra"` gerou `assets/mascot.png` (PNG 1254×1254), verificado pela ponte.

## Escolha do executor: evidência, não marca

A skill conduz o cérebro por um procedimento explícito: entender e decompor a tarefa, classificar risco e acoplamento, escolher o executor, montar o contexto mínimo, verificar e registrar a decisão. Para escolher o executor, o cérebro consulta `duo recommend`, que é determinístico e não chama IA:

- **Evidência:** tarefas comparáveis deste projeto (mesmo `kind` e mesma linguagem, com recuo para buckets mais amplos quando faltam amostras). Contam o sucesso verificado pela ponte, os testes de aceite, a penalidade para quem declarou sucesso e reprovou, e as rejeições do cérebro (`duo accept --reject`). Falhas de login, cota ou timeout **não** contam contra o modelo.
- **Eficiência:** em empate técnico, vence o menor tempo mediano.
- **Disponibilidade:** CLI instalada, login por assinatura, ciência de uso extra e limite observado.
- **Decisão:** `DELEGAR` ao melhor candidato (com o modelo), `FAZER VOCÊ MESMO` quando o melhor histórico é do próprio cliente do cérebro, ou `JULGAMENTO` quando a evidência é insuficiente (mínimo configurável; em baixo risco, sugere explorar para gerar evidência).
- **Candidatos** (`routing.candidates`): por padrão Claude `claude-opus-5-5` e o modelo padrão da conta no Codex; dá para adicionar outros, como `sonnet`. Preferências pessoais só entram como `routing.priors`, com bônus limitado a ±0,2 e sempre identificado.

Validado com as CLIs reais (E2E T12/T13): com histórico favorável ao Claude, o Claude cérebro decidiu **fazer ele mesmo** e o Codex cérebro **delegou ao Claude**.

## Como uma delegação é verificada

1. **Pedido**: validado pelo schema. `brain ≠ executor`, e o cérebro é fixo dentro de um run.
2. **Política** (`economico` por padrão): motivo da delegação compatível com a política, até **2 invocações por run** (incluindo correção) e preferência de cota.
3. **Escopo**: só caminhos relativos, sem `..`, sem symlinks, fora da lista de negação (`.env`, chaves, `.git`, `.duo`…).
4. **Compatibilidade**: flags obrigatórias precisam aparecer no `--help` da versão instalada.
5. **Autenticação**: variáveis de API/gateway são removidas do ambiente do executor, configurações como `apiKeyHelper` ou `model_provider` bloqueiam a execução, e o método efetivo precisa ser confirmado como assinatura pelo status oficial.
6. **Lock**: um executor ativo por projeto.
7. **Execução**: prompt pela stdin, argumentos separados, sem shell, com timeout, limite de saída e encerramento da árvore de processos.
8. **Verificação independente**: arquivos realmente alterados (por hash), violações de escopo, diff apenas do delta do executor, divergência entre o que o executor declarou e o que fez, base alterada e comandos de aceite executados pela ponte.

Um "completed" do modelo com teste falhando vira `failed`. Nada é revertido automaticamente: a ponte nunca usa `reset --hard`, `clean` ou `stash`.

## Estado local

```text
.duo/
  config.json
  runs/<runId>/run.json
  runs/<runId>/tasks/<taskId>/{task.json, request.json, prompt.txt, invocation.json, events.jsonl, stderr.txt, changes.diff|changes.patch, snapshot/}
  telemetry.jsonl   quota.json   lock.json   handoffs/   backups/   worktrees/
```

Todo arquivo persistido passa por redação de segredos. O texto de raciocínio (`reasoning` do Codex e `thinking` do Claude) não é gravado.

## Estado da validação

| Item | Situação |
| --- | --- |
| Código, testes e documentação | Implementados |
| 239 testes offline (adaptadores com CLIs simuladas, fluxo completo, roteador, catálogo de modelos com fallbacks, arte, CLI como processo real, encerramento de árvores de processos, redação de segredos) | **Passando**, sem processos órfãos |
| `duo doctor` real | Claude 2.1.114 e Codex 0.157.1 autenticados por assinatura, com todas as flags obrigatórias presentes |
| Bateria E2E real ([docs/e2e-real.md](docs/e2e-real.md)) | **16/16** numa execução completa do zero com Opus 5.5 (antes, 13/13 e 11/11): revisão read-only nos dois sentidos, aceite impossível, tentação fora do escopo, timeout + retomada (Codex e Claude), cancelamento, worktree + apply, recursão bloqueada, roteamento por evidência nos dois sentidos, **arte real com GPT-6-Astra** e **tarefas com modelos diferentes por parte** (Opus 5.5 no código + GPT-6-Astra na arte), com Claude ou Codex como cérebro |
| Cérebro nativo usando a skill | **Validado em modo headless**: `claude -p "/duo-delegate …"` → Codex e `codex exec "$duo-delegate …"` → Claude, ambos `succeeded` |
| Cota esgotada e violação de escopo com executor real | **Não exercitados**: os executores reais respeitaram o escopo e não houve cota esgotada; os dois casos seguem cobertos só pelos testes offline |
| Extensões do VS Code (painel interativo) | **Não exercitado**: os cérebros rodaram pelas CLIs em modo headless; as skills e os comandos são os mesmos, mas as aprovações interativas não foram testadas |
| Windows | Código portável escrito; **não testado** |

Detalhes em [docs/compatibilidade.md](docs/compatibilidade.md).

## Limitações conhecidas

- O executor Codex pode **ler** qualquer arquivo legível pelo usuário: o sandbox restringe escrita e rede, não leitura. O executor Claude tem regras de negação para caminhos protegidos, mas elas são aplicadas pelo cliente, não pelo sistema operacional.
- Lock, `DUO_DEPTH` e listas de negação de comandos são barreiras **cooperativas**. As barreiras impostas são o sandbox do Codex, as permissões `dontAsk`/`--tools` do Claude e a verificação posterior feita pela ponte (veja [SECURITY.md](SECURITY.md)).
- Cotas: o Claude Code emite no stream um `rate_limit_event` (janela, reset, uso extra), que a ponte registra como observação nativa **após** cada execução. O Codex não emite nada equivalente no `exec --json`; o `codex app-server` é usado só para descobrir modelos, não para ler limites. Sem observação, o relatório mostra o registro manual ou "não disponível".
- O executor carrega a configuração do usuário do cliente: no Claude, hooks e plugins do usuário (ex.: claude-mem); no Codex, skills, plugins e MCPs do `~/.codex`. Num ambiente com muitos plugins, isso levou a 142 mil tokens de entrada no Codex para uma tarefa trivial. Por isso, o executor Codex roda por padrão com `--disable hooks --disable plugins` (`executors.codex.disableUserExtensions`), depois de os hooks de um plugin (Ruflo) gravarem arquivos no projeto durante uma delegação real. `executors.codex.ignoreUserConfig: true` pode reduzir o consumo, mas **não foi testado** com a CLI real (muda também o modelo padrão).
- O modelo efetivo depende da versão da CLI: com `model: "opus"` no settings, o `claude` 2.1.114 usava `claude-opus-4-7`. Por isso o executor pede `claude-opus-5-5` explicitamente (CLI atualizada para 2.1.283). O modelo real fica registrado em cada task, e a ponte alerta se ele diferir do pedido.
- O roteador aprende só com o histórico **deste projeto**: num projeto novo, a recomendação começa como "julgamento". O desempenho do cérebro quando ele faz a tarefa sozinho não é medido; conta como evidência do mesmo cliente apenas o seu histórico como executor.
- Não há interface oficial para verificar se créditos ou uso extra estão ativos nas contas; por isso existe a confirmação explícita.
- Arquivos ignorados pelo Git e fora do escopo (ex.: `node_modules/`) não entram na detecção de mudanças.
- Comandos de aceite rodam sem as variáveis de API/gateway no ambiente (mesma limpeza do executor); testes que dependem delas vão falhar.
- Em modo `worktree`, os comandos de aceite rodam no worktree, onde dependências não versionadas (ex.: `node_modules`) podem estar ausentes.
- Com o Codex como cérebro em modo headless, a execução de `duo delegate` fora do sandbox foi aprovada pelo revisor automático (`--approve-for-me`). No VS Code interativo, quem aprova é você.

## Documentação

- [docs/autenticacao.md](docs/autenticacao.md): login oficial, perfil subscription-only e uso extra.
- [docs/compatibilidade.md](docs/compatibilidade.md): matriz observada.
- [docs/decisoes.md](docs/decisoes.md): decisões técnicas e referências consultadas.
- [docs/avaliacao.md](docs/avaliacao.md): como medir se a delegação realmente ajuda.
- [docs/e2e-real.md](docs/e2e-real.md): bateria E2E com as CLIs reais (consome cota), cenários, critérios e resultados.
- [SECURITY.md](SECURITY.md): modelo de ameaças e o que é imposto versus cooperativo.
- [examples/](examples/): pedidos nos dois sentidos, uma tarefa sem delegação e uma revisão cruzada.

## Provas de qual modelo executou

Cada tarefa delegada ao Codex registra, a partir do rollout da própria sessão do Codex, o modelo efetivo, o provedor, os IDs de resposta do servidor (`resp_…`), as ferramentas chamadas e o SHA-256 das imagens geradas pela ferramenta de imagem. Se o modelo efetivo diferir do pedido, a tarefa mostra um alerta. No Claude, o modelo vem do próprio stream (`system/init` e `modelUsage`). Veja `evidence` no JSON devolvido por `duo delegate`.

## Contribuindo

Issues e pull requests são bem-vindos. Antes de enviar: `npm ci && npm test` (tudo offline). A bateria real (`tests/e2e/real-e2e.mjs`) e o teste de qualidade (`tests/e2e/quality-test.mjs`) consomem cota das suas assinaturas e só rodam com `--confirm-quota`.

## Licença

[MIT](LICENSE).

## Evoluções possíveis

Painel próprio no VS Code, adaptador opcional para o Codex App Server (sessões, aprovações, limites) após validar maturidade, recomendação de cérebro antes de começar, e paralelismo com múltiplos worktrees. Nada disso deve introduzir login próprio de assinatura.
