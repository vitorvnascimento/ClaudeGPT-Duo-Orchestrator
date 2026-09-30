# Official authentication and `subscription-only` profile

**English** · [Português](#português)

The bridge **does not receive** a password, cookie, OAuth token, or authentication-file contents. You log in directly to the official clients; the bridge only checks the non-sensitive status.

## Claude Code (Pro/Max subscription)

1. Install the official CLI (`npm install -g @anthropic-ai/claude-code` or the native installer). The VS Code extension uses the same account, but does not put `claude` on PATH.
2. Run `claude` and use `/login` with the claude.ai account.
3. Check: `claude auth status` should show `"authMethod": "claude.ai"` and `"apiProvider": "firstParty"`.

Documented precedence (code.claude.com/docs/en/authentication, consulted on 25/09/2026): cloud (`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`) → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profiles → subscription login. **In `claude -p`, `ANTHROPIC_API_KEY` is always used when present.** Therefore the bridge:

- removes these variables from the executor environment;
- blocks if `apiKeyHelper`, `forceLoginMethod: "console"`, or an `env` block with these variables appears in `~/.claude/settings*.json`, the project's `.claude/settings*.json`, or managed settings;
- runs `claude auth status` **with the same environment as the executor** and proceeds only with `authMethod=claude.ai` and `apiProvider=firstParty`. Any other value (including an unknown one) blocks.

`--bare` is **never** used: the documentation and the `--help` output of version 2.1.114 confirm that this mode does not read OAuth or the Keychain and requires `ANTHROPIC_API_KEY`.

## Codex (ChatGPT account)

1. Install the official CLI (`npm install -g @openai/codex` or `brew install --cask codex`). Do not use the binary bundled in the VS Code extension.
2. Run `codex login` and choose "Sign in with ChatGPT".
3. Check: `codex login status` should say `Logged in using ChatGPT`.

The bridge:

- removes `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and similar variables from the executor environment (the documentation indicates that `CODEX_API_KEY` applies to a `codex exec` run);
- blocks `model_provider` other than `openai`, `preferred_auth_method = "apikey"`, or `forced_login_method = "api"` in `$CODEX_HOME/config.toml` or `.codex/config.toml`. Only these non-secret values are read; `[model_providers.*]` generates a warning;
- proceeds only with `Logged in using ChatGPT`. "API key", "Not logged in", or an unrecognized output blocks.

## Credits and extra usage

Even with a subscription login, **credits or extra usage enabled on your account can incur charges**. Neither client exposes an official local interface for checking this setting, and the bridge does not scrape private endpoints. Therefore:

- `billing.acknowledgeUnverifiableExtraUsage.<cliente>` starts as `false` and delegation is blocked;
- after checking your account configuration on the official websites, change it to `true`. This is your confirmation, recorded on each task as `unverifiable-acknowledged`;
- the bridge never buys credits, enables extra usage, consumes reset credits, or changes spending limits;
- `--max-budget-usd` is **not** used because it is not a subscription-quota guarantee.
- **Post-execution signal (Claude):** the real `claude -p` 2.1.114 stream contains a `rate_limit_event` with `overageStatus` and `isUsingOverage`. The bridge stores this on each task and adds an explicit alert if `isUsingOverage=true`. In the real smoke test: `overageStatus=rejected`, `overageDisabledReason=out_of_credits`, `isUsingOverage=false`. This is an observation **after** execution, not a prior guarantee. Codex emits no equivalent signal in `exec --json`.

## Limits and cooldowns

When an executor reports a limit or quota reached, the task becomes `blocked`, with no automatic retry. The options are to wait for the reset, execute the subtask in the brain itself, or perform a handoff. Nothing is transferred automatically with partial work: the partial-work diff is recorded for you to decide.

## Individual use × product for third parties

The consulted terms (code.claude.com/docs/en/legal-and-compliance) allow a user to use the **unmodified** binary with their own subscription. They prohibit developers from offering claude.ai login in their products, routing requests through Free/Pro/Max credentials on behalf of other users, or brokering credentials. The duo was designed **only for local, individual use**: if it ever becomes a product for other people, it will need API-key authentication or a commercial agreement, and this design is not suitable.

---

## Português

A ponte **não recebe** senha, cookie, token OAuth nem conteúdo de arquivos de autenticação. Você faz login diretamente nos clientes oficiais; a ponte só consulta o status não sensível.

## Claude Code (assinatura Pro/Max)

1. Instale a CLI oficial (`npm install -g @anthropic-ai/claude-code` ou o instalador nativo). A extensão do VS Code usa a mesma conta, mas não coloca `claude` no PATH.
2. Rode `claude` e faça `/login` com a conta claude.ai.
3. Confira: `claude auth status` deve mostrar `"authMethod": "claude.ai"` e `"apiProvider": "firstParty"`.

Precedência documentada (code.claude.com/docs/en/authentication, consultada em 25/09/2026): nuvem (`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`) → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → perfis → login de assinatura. **Em `claude -p`, `ANTHROPIC_API_KEY` é sempre usada quando presente.** Por isso a ponte:

- remove essas variáveis do ambiente do executor;
- bloqueia se `apiKeyHelper`, `forceLoginMethod: "console"` ou um bloco `env` com essas variáveis aparecer em `~/.claude/settings*.json`, `.claude/settings*.json` do projeto ou em managed settings;
- roda `claude auth status` **com o mesmo ambiente do executor** e só segue com `authMethod=claude.ai` e `apiProvider=firstParty`. Qualquer outro valor (inclusive desconhecido) bloqueia.

`--bare` **nunca** é usado: a documentação e o `--help` da versão 2.1.114 confirmam que esse modo não lê OAuth nem o Keychain e exige `ANTHROPIC_API_KEY`.

## Codex (conta ChatGPT)

1. Instale a CLI oficial (`npm install -g @openai/codex` ou `brew install --cask codex`). Não use o binário embutido na extensão do VS Code.
2. Rode `codex login` e escolha "Sign in with ChatGPT".
3. Confira: `codex login status` deve dizer `Logged in using ChatGPT`.

A ponte:

- remove `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` e similares do ambiente do executor (a documentação indica que `CODEX_API_KEY` vale para uma execução de `codex exec`);
- bloqueia `model_provider` diferente de `openai`, `preferred_auth_method = "apikey"` ou `forced_login_method = "api"` em `$CODEX_HOME/config.toml` ou `.codex/config.toml`. Apenas esses valores, que não são secretos, são lidos; `[model_providers.*]` gera aviso;
- só segue com `Logged in using ChatGPT`. "API key", "Not logged in" ou uma saída não reconhecida bloqueiam.

## Créditos e uso extra

Mesmo com login de assinatura, **créditos ou uso extra ativados na sua conta podem gerar cobrança**. Nenhum dos dois clientes expõe uma interface oficial e local para verificar essa configuração, e a ponte não raspa endpoints privados. Por isso:

- `billing.acknowledgeUnverifiableExtraUsage.<cliente>` começa como `false` e a delegação fica bloqueada;
- depois de conferir a configuração da sua conta nos sites oficiais, mude para `true`. É uma confirmação sua, registrada em cada task como `unverifiable-acknowledged`;
- a ponte nunca compra créditos, ativa uso extra, consome créditos de reset nem muda limites de gasto;
- `--max-budget-usd` **não** é usado, porque não é garantia de cota de assinatura.
- **Sinal pós-execução (Claude):** o stream real do `claude -p` 2.1.114 traz um `rate_limit_event` com `overageStatus` e `isUsingOverage`. A ponte guarda isso em cada task e adiciona um alerta explícito se `isUsingOverage=true`. No smoke test real: `overageStatus=rejected`, `overageDisabledReason=out_of_credits`, `isUsingOverage=false`. É uma observação feita **depois** da execução, não uma garantia prévia. O Codex não emite sinal equivalente no `exec --json`.

## Limites e cooldowns

Quando um executor informa limite ou cota atingida, a task vai para `blocked`, sem nova tentativa automática. As opções são aguardar o reset, executar a subtarefa no próprio cérebro ou fazer um handoff. Nada é transferido automaticamente com trabalho parcial: o diff do trabalho parcial fica registrado para você decidir.

## Uso individual × produto para terceiros

Os termos consultados (code.claude.com/docs/en/legal-and-compliance) permitem que um usuário use o binário **não modificado** com a própria assinatura. Eles proíbem que desenvolvedores ofereçam login claude.ai em seus produtos, roteiem requisições por credenciais Free/Pro/Max em nome de outros usuários ou intermediem credenciais. O duo foi desenhado **só para uso local e individual**: se algum dia virar produto para outras pessoas, precisará de autenticação por API key ou de acordo comercial, e este desenho não serve.
