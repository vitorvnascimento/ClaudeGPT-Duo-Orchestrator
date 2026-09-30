# Security Policy — ClaudeGPT - Duo Orchestrator by Fusic

**English** · [Português](#português)

This is a personal, local project. It does not expose a network service, receive credentials, or publish anything.

## Principles

1. **Credentials stay with the official clients.** The bridge never reads `~/.codex/auth.json`, `~/.claude/.credentials.json`, the Keychain, or token variables. It only checks `claude auth status` and `codex login status` and stores only the method (`subscription`, `api_key`…), never an email address, organization, or key fragments. Model discovery (`duo models`) uses Claude's `initialize` and the read methods `model/list`, `modelProvider/capabilities/read`, and `account/rateLimits/read` from `codex app-server`. It discards the `account` field and all server notifications (such as `account/updated`), and writes the model list, tools, and, when available, a sanitized quota note to `.duo/models.json`.
2. **One brain, depth 1.** The executor cannot call the brain, another executor, or the bridge itself.
3. **Verify instead of trusting.** The executor's report is self-declared; the bridge checks hashes, scope, diff, and real tests.
4. **Never discard the user's work.** No `reset --hard`, `clean`, `stash`, or file checkout. Violations are reported, not reverted.
5. **No external side effects.** No push, publication, deploy, purchase, credit reload, or credential change.
6. **A single anonymous network request of its own.** The new-version notice sends a `GET` to `https://api.github.com/repos/vitorvnascimento/ClaudeGPT-Duo-Orchestrator/releases/latest` at most once per day, with fixed headers (`Accept` and `User-Agent`), without a token, cookie, or environment variable, and without following redirects. The process that makes the request receives a minimal environment (`PATH`, `HOME`). From the response, it uses only a validated `x.y.z` version and the `.tgz` URL for that release; the release's free-form text is never displayed. The result is stored in `~/.cache/duo-orchestrator/update-check.json`, read without blocking (regular and small file only), and an atomic reservation guarantees one request at a time, including after a network failure (a new attempt only after 24 h). Installation occurs only with `duo update --apply`: `npm install -g --ignore-scripts` of the validated `.tgz`, without a shell and with a minimal environment (without shell tokens, proxies, or `npm_config_*`). Package authenticity depends on GitHub HTTPS and access control to the repository (only the maintainer publishes releases). Disable it with `DUO_NO_UPDATE_CHECK=1`.

## Optional local proxy

`billing.allowLoopbackProxy` is disabled by default. When enabled, the bridge accepts only `http://` or `https://` with a raw authority exactly equal to `localhost`, `127.0.0.1`, or `[::1]`, without userinfo. In Claude, the exception applies to `env.ANTHROPIC_BASE_URL` in the settings. In Codex, it also requires the active custom provider to have `requires_openai_auth = true` and not declare `env_key`, `experimental_bearer_token`, or `http_headers`. The bridge continues removing `ANTHROPIC_BASE_URL` from the executor process environment; the option only authorizes the client's persistent configuration.

A local proxy sees the traffic sent to the client and may see the session token the client uses to authenticate the subscription. Enable the option only for a local process you control and understand. The check does not audit the process, port, proxy code, how it uses the data, DNS, redirects after the connection, or host security; it only performs this conservative validation of the declared configuration and URL authority. Alternate IPv4 representations, IPv4-mapped IPv6, userinfo, and remote hosts remain blocked.

## Enforced × cooperative

| Control | Type | Enforced by |
| --- | --- | --- |
| Codex executor `read-only` / `workspace-write` sandbox | **Enforced** | Codex, through the OS sandbox (Seatbelt on macOS) |
| Network disabled in the Codex sandbox (`sandbox_workspace_write.network_access=false`) | **Enforced** | Codex |
| `--permission-mode dontAsk` + restricted `--tools` in the Claude executor | **Client-enforced** | Claude Code (not an OS sandbox) |
| `--disallowedTools` for `claude`/`codex`/`duo`, destructive Git commands, and protected paths | **Client-enforced** | Claude Code |
| `--setting-sources user` and `--strict-mcp-config` (without project hooks/settings/MCP) | **Client-enforced** | Claude Code |
| `--disable-slash-commands` (skills disabled in the Claude executor) | **Client-enforced** | Claude Code |
| Removal of API/gateway variables from the executor environment | **Enforced** | Bridge (child-process environment) |
| Execution without a shell, with separate arguments and the prompt on stdin | **Enforced** | Bridge |
| Timeout, output limit, and process-tree termination | **Enforced** | Bridge |
| Scope validation (traversal, symlink, denylist) before execution | **Enforced** | Bridge |
| Detection of changes outside scope, in a protected file, or against a changed base | **Post-execution detection** | Bridge (hash + Git) |
| Acceptance commands only from an allowlist | **Enforced** | Bridge |
| `DUO_DEPTH=1` (the bridge refuses to run inside an executor) | **Cooperative** | A process controlling its own environment can remove it |
| Single-executor lock (`.duo/lock.json`) | **Cooperative + detection** | An executor with write access to `.duo/` can remove it; the bridge checks the nonce at the end and rejects the task |
| Prompt instructions ("do not delegate", "do not read .env") | **Cooperative** | Text only; never treated as a barrier |

There is no **read** isolation for the Codex executor: the Codex sandbox restricts writing and network access, not reading. Do not place the duo in repositories with secrets in readable files that the provider must not see.

## Process termination

On macOS and Linux, the executor runs in its own process group. Timeout, cancellation, and bridge exit terminate the entire group (first signal, SIGKILL after the grace period), and the bridge returns the result only when the group is empty, so no descendant can continue changing the project after the lock is released. Before each signal, the bridge confirms that the group still exists and forgets it after observing it empty. If, ~2 s after SIGKILL, the group has still not been observed empty (for example, a process stuck in a kernel call), the bridge stops waiting and returns the result so it does not hang. Likewise, if the group is already empty but a process that left it (for example, a daemon with `setsid`) inherited stdout/stderr, the bridge releases the pipes ~2 s later; that process is not terminated by the bridge because it is outside the group.

Residual risk: between the group becoming empty and the next probe (~50 ms), the group ID could theoretically be reused by another process. The system does not reuse the ID while the group has members, so this would require a complete wraparound of the PID space during that window. On Windows, termination uses `taskkill /T /F`, without this wait (not tested).

## Untrusted repositories

- `claude -p` does not show the workspace trust dialog. By default the executor uses `--setting-sources user` and `--strict-mcp-config`, so project hooks, settings, and `.mcp.json` do not run. **User** hooks (`~/.claude/settings.json`) continue to run; `duo doctor` lists these hooks.
- The project’s `CLAUDE.md` and `AGENTS.md` files are read by the CLIs as instructions.
- Acceptance commands execute repository code with its permissions, **outside the sandbox**. That is why `acceptance.allowedCommands` has an allowlist.
- A worktree isolates Git changes; it is **not a security sandbox**.

## Data sent to providers

The executor receives the prompt assembled by the bridge (objective, paths, constraints, interfaces, and criteria) and reads project files with the client's own tools. Send to the second provider only projects for which this is permitted. Corporate projects may require organization authorization.

## Persistence

- `.duo/quota-state.json` keeps one observation per provider (`claude`/`codex`): status, percentage used or null, ISO reset or null, observation date, source, and affected models or null. It stores no email, identity, account IDs, plan, credits, or tokens. The catalog cache receives only this same sanitized projection. Codex fields `accountId`, `planType`, `credits`, `individualLimit`, `rateLimitResetCredits`, and `spendControlReached` are discarded. No `account/*` method other than `account/rateLimits/read` is called; in particular, reset credits are never consumed. Without valid data, the quota remains unknown; observations expire at reset or after 6 h without a reset. The previous manual record (`quota.json`) keeps its format; do not include personal information or secrets in the free-form note.
- A fallback may send the same subtask to another provider, exclusively through CLIs authenticated by the subscription and passing through the gates again. The level is never reduced; no paid API, credential change, or credit reload is attempted.

- Everything written to `.duo/` goes through secret-pattern redaction (keys `sk-…`, `ghp_…`, Google `AIza…`, Stripe, npm, JWT, `Bearer …`, `api_key=…` pairs, PEM private-key blocks, including when they arrive split across multiple lines or multiple strings in JSON; an open block without an end is redacted to the end, along with anything that follows it) and redaction of sensitive environment-variable values. Redaction uses patterns: a secret in an unknown format may pass. Known PEM-redaction limits: a `-----BEGIN …-----` delimiter split between two events is not recognized (supported executors emit whole messages, not deltas); JSON property names are preserved inside an open block (only values are redacted), although a delimiter in a key opens or closes the block for subsequent values; and an event line above 8 MiB interrupts the task event log.
- Reasoning text (`reasoning` from Codex and `thinking` from Claude) is omitted before writing. Identification uses the original event, so redacting other fields does not hide reasoning.
- `.duo/` is in `.gitignore` (proposed by `duo init`).

## Reporting problems

Vulnerabilities in the duo: use GitHub's [private vulnerability reporting](https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator/security/advisories/new) instead of a public issue. For other problems, open an issue. Vulnerabilities in the official CLIs should be reported to the providers (Anthropic through HackerOne; OpenAI through the OpenAI security program).

## Floor confirmation and effective configuration

With adaptive selection enabled, model, effort and automatic eligibility must be confirmed before invocation. A deep floor requires a fresh catalog and supported explicit high or higher effort; missing, stale or merely user-configured metadata does not confirm this floor. Sensitivity is inspected across all authorized paths; any incomplete enumeration raises the floor to deep. A native model below the floor, or unknown under deep, prevents success and integration. This protection uses metadata reported by the CLIs; it does not prove the honesty of the provider or proxy. Partial work is preserved.

Loopback authorization considers the effective configuration rather than isolated files: Claude settings follow user/local, project and local sources; Codex providers merge global and project sources, key by key. Project tables and selections are revalidated. Remote endpoints, incompatible authentication, credential keys or unverifiable TOML routing forms block execution. Credential values are neither interpreted nor included in messages: only the presence/name of keys is used. The check remains limited to configuration and URL; it does not audit the local process or redirects.

---

## Português

Projeto pessoal e local. Não expõe serviço de rede, não recebe credenciais e não publica nada.

## Princípios

1. **Credenciais ficam com os clientes oficiais.** A ponte nunca lê `~/.codex/auth.json`, `~/.claude/.credentials.json`, o Keychain nem variáveis de token. Ela só consulta `claude auth status` e `codex login status` e guarda apenas o método (`subscription`, `api_key`…), nunca e-mail, organização ou trechos de chave. A descoberta de modelos (`duo models`) usa o `initialize` do Claude e os métodos de leitura `model/list`, `modelProvider/capabilities/read` e `account/rateLimits/read` do `codex app-server`. Ela descarta o campo `account` e todas as notificações do servidor (como `account/updated`), e grava em `.duo/models.json` a lista de modelos, as ferramentas e, quando disponível, uma observação de cota sanitizada.
2. **Um cérebro, profundidade 1.** O executor não pode chamar o cérebro, outro executor ou a própria ponte.
3. **Verificar em vez de confiar.** O relatório do executor é autodeclarado; a ponte confere hashes, escopo, diff e testes reais.
4. **Nunca descartar trabalho do usuário.** Sem `reset --hard`, `clean`, `stash` ou checkout de arquivos. Violações são reportadas, não revertidas.
5. **Sem efeitos colaterais externos.** Sem push, publicação, deploy, compra, recarga de créditos ou alteração de credenciais.
6. **Uma única consulta de rede própria, anônima.** O aviso de nova versão faz um `GET` em `https://api.github.com/repos/vitorvnascimento/ClaudeGPT-Duo-Orchestrator/releases/latest` no máximo uma vez por dia, com cabeçalhos fixos (`Accept` e `User-Agent`), sem token, cookie ou variável de ambiente, e sem seguir redirecionamentos. O processo que consulta recebe um ambiente mínimo (`PATH`, `HOME`). Da resposta só se usam uma versão `x.y.z` validada e a URL do `.tgz` desta release; o texto livre da release nunca é exibido. O resultado fica em `~/.cache/duo-orchestrator/update-check.json`, lido sem bloquear (só arquivo regular e pequeno), e uma reserva atômica garante uma consulta por vez, inclusive após falha de rede (nova tentativa só em 24 h). A instalação só ocorre com `duo update --apply`: `npm install -g --ignore-scripts` do `.tgz` validado, sem shell e com ambiente mínimo (sem tokens, proxies ou `npm_config_*` do shell). A autenticidade do pacote depende do HTTPS do GitHub e do controle de acesso ao repositório (só o mantenedor publica releases). Desligue com `DUO_NO_UPDATE_CHECK=1`.

## Proxy local opcional

`billing.allowLoopbackProxy` fica desligado por padrão. Quando habilitado, a ponte aceita apenas `http://` ou `https://` com autoridade raw exatamente `localhost`, `127.0.0.1` ou `[::1]`, sem userinfo. No Claude, a exceção vale para `env.ANTHROPIC_BASE_URL` nas settings. No Codex, também exige que o provedor customizado ativo tenha `requires_openai_auth = true` e não declare `env_key`, `experimental_bearer_token` ou `http_headers`. A ponte continua removendo `ANTHROPIC_BASE_URL` do ambiente do processo executor; a opção só autoriza a configuração persistente do cliente.

Um proxy local vê o tráfego enviado ao cliente e pode ver o token de sessão que o cliente usa para autenticar a assinatura. Habilite a opção somente para um processo local que você controla e compreende. A checagem não audita o processo, a porta, o código do proxy, o uso que ele faz dos dados, DNS, redirecionamentos depois da conexão ou a segurança do host; ela só faz essa validação conservadora da configuração declarada e da autoridade da URL. Representações alternativas de IPv4, IPv4 mapeado em IPv6, userinfo e hosts remotos continuam bloqueados.

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

- `.duo/quota-state.json` mantém uma observação por fornecedor (`claude`/`codex`): status, porcentagem usada ou null, reset ISO ou null, data da observação, fonte e modelos afetados ou null. Não guarda e-mail, identidade, IDs de conta, plano, créditos ou tokens. O cache de catálogo recebe somente essa mesma projeção sanitizada. Campos `accountId`, `planType`, `credits`, `individualLimit`, `rateLimitResetCredits` e `spendControlReached` da leitura Codex são descartados. Nenhum método `account/*` além de `account/rateLimits/read` é chamado; em particular, nunca consome créditos de reset. Sem dado válido, a cota permanece desconhecida; observações expiram no reset ou após 6 h sem reset. O registro manual anterior (`quota.json`) mantém seu formato; não inclua informações pessoais/segredos na nota livre.
- Um fallback pode enviar a mesma subtarefa a outro fornecedor, exclusivamente pelas CLIs autenticadas pela assinatura e passando novamente pelos gates. O nível nunca é reduzido; nenhuma API paga, troca de credenciais ou recarga de créditos é tentada.

- Tudo o que vai para `.duo/` passa por redação de padrões de segredo (chaves `sk-…`, `ghp_…`, Google `AIza…`, Stripe, npm, JWT, `Bearer …`, pares `api_key=…`, blocos de chave privada PEM, inclusive quando chegam divididos em várias linhas ou em várias strings de um JSON; um bloco aberto sem fim é redigido até o final, junto com o que vier depois dele) e dos valores de variáveis sensíveis do ambiente. A redação é por padrões: um segredo em formato desconhecido pode passar. Limites conhecidos da redação de PEM: um delimitador `-----BEGIN …-----` partido entre dois eventos não é reconhecido (os executores suportados emitem mensagens inteiras, não deltas); nomes de propriedade JSON são preservados dentro de um bloco aberto (só os valores são redigidos), embora um delimitador numa chave abra ou feche o bloco para os valores seguintes; e uma linha de evento acima de 8 MiB interrompe o log de eventos da task.
- O texto de raciocínio (`reasoning` do Codex e `thinking` do Claude) é omitido antes de gravar. A identificação usa o evento original, então a redação de outros campos não esconde o raciocínio.
- `.duo/` fica no `.gitignore` (proposto por `duo init`).

## Relato de problemas

Vulnerabilidades no duo: use o [relato privado de vulnerabilidades do GitHub](https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator/security/advisories/new) em vez de uma issue pública. Outros problemas: abra uma issue. Vulnerabilidades nas CLIs oficiais devem ser relatadas aos fornecedores (Anthropic via HackerOne; OpenAI pelo programa de segurança da OpenAI).

## Confirmação de piso e configuração efetiva

Com seleção adaptativa ligada, modelo, esforço e elegibilidade automática precisam de confirmação antes da invocação. Piso deep exige catálogo fresco e esforço explícito high ou superior suportado; metadados ausentes, stale ou apenas cadastrados pelo usuário não confirmam esse piso. A sensibilidade é inspecionada em todos os caminhos autorizados; qualquer enumeração incompleta eleva o piso para deep. Modelo nativo abaixo do piso, ou desconhecido em deep, impede sucesso e integração. Essa proteção usa os metadados informados pelas CLIs; não prova a honestidade do fornecedor ou proxy. Trabalho parcial é preservado.

A autorização loopback considera a configuração efetiva, e não arquivos isolados: settings do Claude seguem usuário/local, projeto e local; providers do Codex combinam global e projeto, chave a chave. Tabelas e seleções de projeto são revalidadas. Endpoint remoto, autenticação incompatível, chaves de credencial ou formas TOML de roteamento não verificáveis bloqueiam. Valores de credencial não são interpretados nem incluídos em mensagens: somente a presença/nome das chaves é usada. A checagem continua limitada à configuração e à URL; não audita o processo local nem redirecionamentos.
