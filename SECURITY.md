# Política de segurança — duo-orchestrator

Projeto pessoal e local. Não expõe serviço de rede, não recebe credenciais e não publica nada.

## Princípios

1. **Credenciais ficam com os clientes oficiais.** A ponte nunca lê `~/.codex/auth.json`, `~/.claude/.credentials.json`, o Keychain nem variáveis de token. Ela só consulta `claude auth status` e `codex login status` e guarda apenas o método (`subscription`, `api_key`…), nunca e-mail, organização ou trechos de chave. A descoberta de modelos (`duo models`) usa o `initialize` do Claude e os métodos de leitura `model/list` e `modelProvider/capabilities/read` do `codex app-server`. Ela descarta o campo `account` e todas as notificações do servidor (como `account/updated`), e grava em `.duo/models.json` só a lista de modelos e as ferramentas.
2. **Um cérebro, profundidade 1.** O executor não pode chamar o cérebro, outro executor ou a própria ponte.
3. **Verificar em vez de confiar.** O relatório do executor é autodeclarado; a ponte confere hashes, escopo, diff e testes reais.
4. **Nunca descartar trabalho do usuário.** Sem `reset --hard`, `clean`, `stash` ou checkout de arquivos. Violações são reportadas, não revertidas.
5. **Sem efeitos colaterais externos.** Sem push, publicação, deploy, compra, recarga de créditos ou alteração de credenciais.

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

## Repositórios não confiáveis

- `claude -p` não mostra o diálogo de confiança do workspace. Por padrão o executor usa `--setting-sources user` e `--strict-mcp-config`, para que hooks, settings e `.mcp.json` do projeto não rodem. Hooks do **usuário** (`~/.claude/settings.json`) continuam rodando; `duo doctor` lista esses hooks.
- `CLAUDE.md` e `AGENTS.md` do projeto são lidos pelas CLIs como instruções.
- Comandos de aceite executam código do repositório com as suas permissões, **fora de sandbox**. Por isso existe a allowlist em `acceptance.allowedCommands`.
- Worktree isola mudanças Git; **não é sandbox de segurança**.

## Dados enviados aos provedores

O executor recebe o prompt montado pela ponte (objetivo, caminhos, restrições, interfaces, critérios) e lê arquivos do projeto com as ferramentas do próprio cliente. Envie ao segundo provedor apenas projetos em que isso seja permitido. Projetos corporativos podem exigir autorização da organização.

## Persistência

- Tudo o que vai para `.duo/` passa por redação de padrões de segredo (chaves `sk-…`, `ghp_…`, JWT, `Bearer …`, pares `api_key=…`) e dos valores de variáveis sensíveis do ambiente.
- O texto de raciocínio (`reasoning` do Codex e `thinking` do Claude) é omitido antes de gravar.
- `.duo/` fica no `.gitignore` (proposto por `duo init`).

## Relato de problemas

Projeto pessoal: registre o problema localmente ou abra uma issue privada, se o repositório vier a ser publicado. Vulnerabilidades nas CLIs oficiais devem ser relatadas aos fornecedores (Anthropic via HackerOne; OpenAI pelo programa de segurança da OpenAI).
