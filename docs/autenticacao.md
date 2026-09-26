# Autenticação oficial e perfil `subscription-only`

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
