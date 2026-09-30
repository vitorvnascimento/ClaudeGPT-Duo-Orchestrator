# Política de segurança — ClaudeGPT - Duo Orchestrator by Fusic

Projeto pessoal e local. Não expõe serviço de rede, não recebe credenciais e não publica nada.

## Princípios

1. **Credenciais ficam com os clientes oficiais.** A ponte nunca lê `~/.codex/auth.json`, `~/.claude/.credentials.json`, o Keychain nem variáveis de token. Ela só consulta `claude auth status` e `codex login status` e guarda apenas o método (`subscription`, `api_key`…), nunca e-mail, organização ou trechos de chave. A descoberta de modelos (`duo models`) usa o `initialize` do Claude e os métodos de leitura `model/list` e `modelProvider/capabilities/read` do `codex app-server`. Ela descarta o campo `account` e todas as notificações do servidor (como `account/updated`), e grava em `.duo/models.json` só a lista de modelos e as ferramentas.
2. **Um cérebro, profundidade 1.** O executor não pode chamar o cérebro, outro executor ou a própria ponte.
3. **Verificar em vez de confiar.** O relatório do executor é autodeclarado; a ponte confere hashes, escopo, diff e testes reais.
4. **Nunca descartar trabalho do usuário.** Sem `reset --hard`, `clean`, `stash` ou checkout de arquivos. Violações são reportadas, não revertidas.
5. **Sem efeitos colaterais externos.** Sem push, publicação, deploy, compra, recarga de créditos ou alteração de credenciais.
6. **Uma única consulta de rede própria, anônima.** O aviso de nova versão faz um `GET` em `https://api.github.com/repos/vitorvnascimento/duo-orchestrator/releases/latest` no máximo uma vez por dia, com cabeçalhos fixos (`Accept` e `User-Agent`), sem token, cookie ou variável de ambiente, e sem seguir redirecionamentos. O processo que consulta recebe um ambiente mínimo (`PATH`, `HOME`). Da resposta só se usam uma versão `x.y.z` validada e a URL do `.tgz` desta release; o texto livre da release nunca é exibido. O resultado fica em `~/.cache/duo-orchestrator/update-check.json`, lido sem bloquear (só arquivo regular e pequeno), e uma reserva atômica garante uma consulta por vez, inclusive após falha de rede (nova tentativa só em 24 h). A instalação só ocorre com `duo update --apply`: `npm install -g --ignore-scripts` do `.tgz` validado, sem shell e com ambiente mínimo (sem tokens, proxies ou `npm_config_*` do shell). A autenticidade do pacote depende do HTTPS do GitHub e do controle de acesso ao repositório (só o mantenedor publica releases). Desligue com `DUO_NO_UPDATE_CHECK=1`.

## Imposto × cooperativo

| Controle | Tipo | Quem impõe |
| --- | --- | --- |
| Sandbox `read-only` / `workspace-write` do executor Codex | **Imposto** | Codex, via sandbox do SO (Seatbelt no macOS) |
| Rede desligada no sandbox do Codex (`sandbox_workspace_write.network_access=false`) | **Imposto** | Codex |
| `--permission-mode dontAsk` + `--tools` restrito no executor Claude | **Imposto pelo cliente** | Claude Code (não é sandbox de SO) |
| `--disallowedTools` para `claude`/`codex`/`duo`, git destrutivo e caminhos protegidos | **Imposto pelo cliente** | Claude Code |
| `--setting-sources user` e `--strict-mcp-config` (sem hooks/settings/MCP do projeto) | **Imposto pelo cliente** | Claude Code |
| `--disable-slash-commands` (skills desligadas no executor Claude) | **Imposto pelo cliente** | Claude Code |
| Remoção de variáveis de API/gateway do ambiente do executor | **Imposto** | Ponte (ambiente do processo filho) |
| Execução sem shell, com argumentos separados e prompt pela stdin | **Imposto** | Ponte |
| Timeout, limite de saída e encerramento da árvore de processos | **Imposto** | Ponte |
| Validação de escopo (traversal, symlink, lista de negação) antes da execução | **Imposto** | Ponte |
| Detecção de alteração fora do escopo, em arquivo protegido ou com base alterada | **Detecção posterior** | Ponte (hash + Git) |
| Comandos de aceite só a partir de uma allowlist | **Imposto** | Ponte |
| `DUO_DEPTH=1` (a ponte recusa rodar dentro de um executor) | **Cooperativo** | Pode ser removido por um processo que controle o próprio ambiente |
| Lock de executor único (`.duo/lock.json`) | **Cooperativo + detecção** | Um executor com escrita em `.duo/` pode removê-lo; a ponte confere o nonce ao final e reprova a task |
| Instruções do prompt ("não delegue", "não leia .env") | **Cooperativo** | Só texto; nunca é tratado como barreira |

Não há isolamento de **leitura** para o executor Codex: o sandbox do Codex restringe escrita e rede, não leitura. Não coloque o duo em repositórios com segredos em arquivos legíveis que não possam ser vistos pelo provedor.

## Encerramento de processos

No macOS e no Linux, o executor roda num grupo de processos próprio. Timeout, cancelamento e a saída da ponte encerram o grupo inteiro (primeiro sinal, SIGKILL após a carência), e a ponte só devolve o resultado quando o grupo está vazio, para que nenhum descendente continue alterando o projeto depois que o lock é liberado. Antes de cada sinal, a ponte confirma que o grupo ainda existe e o esquece ao observá-lo vazio. Se, ~2 s depois do SIGKILL, o grupo ainda não tiver sido visto vazio (ex.: processo preso em chamada de kernel), a ponte deixa de esperar e devolve o resultado, para não travar. Do mesmo modo, se o grupo já está vazio mas um processo que saiu dele (ex.: daemon com `setsid`) herdou stdout/stderr, a ponte solta os pipes ~2 s depois; esse processo não é encerrado pela ponte, por estar fora do grupo.

Risco residual: entre o grupo ficar vazio e a próxima sondagem (~50 ms), o número do grupo poderia, em teoria, ser reutilizado por outro processo. O sistema não reutiliza o ID enquanto o grupo tem membros, então isso exigiria dar a volta completa no espaço de PIDs nessa janela. No Windows, o encerramento usa `taskkill /T /F`, sem essa espera (não testado).

## Repositórios não confiáveis

- `claude -p` não mostra o diálogo de confiança do workspace. Por padrão o executor usa `--setting-sources user` e `--strict-mcp-config`, para que hooks, settings e `.mcp.json` do projeto não rodem. Hooks do **usuário** (`~/.claude/settings.json`) continuam rodando; `duo doctor` lista esses hooks.
- `CLAUDE.md` e `AGENTS.md` do projeto são lidos pelas CLIs como instruções.
- Comandos de aceite executam código do repositório com as suas permissões, **fora de sandbox**. Por isso existe a allowlist em `acceptance.allowedCommands`.
- Worktree isola mudanças Git; **não é sandbox de segurança**.

## Dados enviados aos provedores

O executor recebe o prompt montado pela ponte (objetivo, caminhos, restrições, interfaces, critérios) e lê arquivos do projeto com as ferramentas do próprio cliente. Envie ao segundo provedor apenas projetos em que isso seja permitido. Projetos corporativos podem exigir autorização da organização.

## Persistência

- Tudo o que vai para `.duo/` passa por redação de padrões de segredo (chaves `sk-…`, `ghp_…`, Google `AIza…`, Stripe, npm, JWT, `Bearer …`, pares `api_key=…`, blocos de chave privada PEM, inclusive quando chegam divididos em várias linhas ou em várias strings de um JSON; um bloco aberto sem fim é redigido até o final, junto com o que vier depois dele) e dos valores de variáveis sensíveis do ambiente. A redação é por padrões: um segredo em formato desconhecido pode passar. Limites conhecidos da redação de PEM: um delimitador `-----BEGIN …-----` partido entre dois eventos não é reconhecido (os executores suportados emitem mensagens inteiras, não deltas); nomes de propriedade JSON são preservados dentro de um bloco aberto (só os valores são redigidos), embora um delimitador numa chave abra ou feche o bloco para os valores seguintes; e uma linha de evento acima de 8 MiB interrompe o log de eventos da task.
- O texto de raciocínio (`reasoning` do Codex e `thinking` do Claude) é omitido antes de gravar. A identificação usa o evento original, então a redação de outros campos não esconde o raciocínio.
- `.duo/` fica no `.gitignore` (proposto por `duo init`).

## Relato de problemas

Vulnerabilidades no duo: use o [relato privado de vulnerabilidades do GitHub](https://github.com/vitorvnascimento/duo-orchestrator/security/advisories/new) em vez de uma issue pública. Outros problemas: abra uma issue. Vulnerabilidades nas CLIs oficiais devem ser relatadas aos fornecedores (Anthropic via HackerOne; OpenAI pelo programa de segurança da OpenAI).
