# Gemini on Windows — Phase 0 facts probe

Answers F1–F7 of `docs/superpowers/specs/2026-11-23-gemini-windows-design.md` on the owner's Windows PC. Node built-ins only; nothing here touches the duo's product code.

## What it spends

- `--dry-run`: **no quota.** Finds `agy`, reads `--version`/`--help`, and runs `agy models` (no inference) under a private profile to check the login.
- Full run: **5 short runs** of `gemini-3.8-flash-low` on the Google AI Pro quota. They start only if the dry-run part proved a subscription login (`authMethod=consumer`, no API key, ADC or enterprise signal).

Every `agy` launch uses a private profile under `%LOCALAPPDATA%\duo-probe-win\<runId>\` (`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`), and Google billing variables are removed from its environment. Evidence is sanitized (no email, no token, your profile path becomes `%USERPROFILE%`).

## Prerequisites

Node 22, `git`, and `agy` installed and logged in with your Google account.

## Steps (PowerShell, in the `duo-win` clone)

```powershell
git fetch origin
git switch feature/gemini-windows
node tests\fixtures\agy\probe-win\probe.mjs --dry-run
```

If the last line is `OK: dry-run concluído, nenhuma cota gasta`, run the full probe with a file-access trace:

1. Process Monitor (Microsoft Sysinternals) is needed for F5. Download it from Microsoft only if you agree; it runs as administrator.
2. In Process Monitor: **no process filter** (agy may start helpers with other names, and the analyzer follows the agy process tree by itself). Clear the list, then start the capture right before the next step.
3. Run:
   ```powershell
   node tests\fixtures\agy\probe-win\probe.mjs --pause
   ```
   It stops before every `agy` launch; press Enter each time.
4. Stop the capture right after the probe ends. File → Save → "All events", format CSV (it can be large; the analyzer reads it line by line).
5. Check the trace:
   ```powershell
   node tests\fixtures\agy\probe-win\analyze-trace.mjs <path-to.csv> docs\evidencias\gemini-windows-phase0\<runId>\results.json
   ```

## Stop lines

| Line | Meaning |
|------|---------|
| `STOP F1: agy não encontrado no PATH` | No `agy` on Windows: the work stops. |
| `STOP F1: shim do agy sem script JS identificado…` | `agy` is a shim the probe cannot call safely; send `where agy` output. |
| `STOP F4: login da assinatura não provado com perfil privado` | The login did not survive the private profile, or it is not a subscription login. No quota was spent. Goes back to the owner. |
| `STOP F3: <hook> não falhou fechado` | A hook that should block let the file be written. No lock left: the work stops. |
| `STOP F3: hook não disparou` | `agy` on Windows ignored the workspace hook: the work stops. |
| `STOP F4: agy models falhou…` / `STOP F4: fonte de login desconhecida…` | The login check itself failed, or Windows reports a credential source not seen before. No quota was spent; send `results.json` for review. |
| `STOP sonda: …` | A problem in the probe itself (for example, a character in your profile path it refuses). Not a fact about agy; send the line. |
| `INCONCLUSIVO: …` | A run gave no proof either way (the model never tried to write, or `hook-cmd-failed`: the hook command line did not run in agy's shell). Send `results.json`. |
| `PROIBIDO: …` (analyze-trace) | The agy process tree touched your real profile: F5 fails. |
| `INCOMPLETO: …` (analyze-trace) | The capture missed some agy launches. Capture again from start to end. |

## Returning the evidence

Read `docs\evidencias\gemini-windows-phase0\<runId>\results.json` for personal data first. Then commit and push **only that file** (never the Procmon CSV), or paste it back. Paste the analyze-trace output too.

---

# Gemini no Windows — teste de fatos da Fase 0

Responde F1–F7 do design (`docs/superpowers/specs/2026-11-23-gemini-windows-design.md`) no seu PC Windows. Só usa módulos nativos do Node e não mexe no código do duo.

## O que gasta

- `--dry-run`: **nada de cota.** Acha o `agy`, lê `--version`/`--help` e roda `agy models` (sem inferência) com um perfil privado para conferir o login.
- Rodada completa: **5 execuções curtas** do `gemini-3.8-flash-low` na cota do Google AI Pro. Só começam se a parte sem cota provar login de assinatura (`authMethod=consumer`, sem sinal de chave de API, ADC ou conta empresarial).

Todo `agy` roda com um perfil privado em `%LOCALAPPDATA%\duo-probe-win\<runId>\` (`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`), sem as variáveis de cobrança do Google. A evidência sai limpa: sem e-mail, sem token, e o caminho do seu perfil vira `%USERPROFILE%`.

## Pré-requisitos

Node 22, `git` e o `agy` instalado e logado com a sua conta Google.

## Passos (PowerShell, no clone `duo-win`)

```powershell
git fetch origin
git switch feature/gemini-windows
node tests\fixtures\agy\probe-win\probe.mjs --dry-run
```

Se a última linha for `OK: dry-run concluído, nenhuma cota gasta`, rode a sonda completa com rastreio de acesso a arquivos:

1. O Process Monitor (Microsoft Sysinternals) é necessário para o F5. Baixe do site da Microsoft só se concordar; ele roda como administrador.
2. No Process Monitor: **sem filtro de processo** (o agy pode abrir ajudantes com outros nomes, e a análise segue sozinha a árvore de processos do agy). Limpe a lista e comece a captura logo antes do próximo passo.
3. Rode:
   ```powershell
   node tests\fixtures\agy\probe-win\probe.mjs --pause
   ```
   Ele para antes de cada `agy`; aperte Enter a cada vez.
4. Pare a captura logo que a sonda terminar. File → Save → "All events", formato CSV (pode ficar grande; a análise lê linha a linha).
5. Confira o rastreio:
   ```powershell
   node tests\fixtures\agy\probe-win\analyze-trace.mjs <caminho-do.csv> docs\evidencias\gemini-windows-phase0\<runId>\results.json
   ```

## Linhas de parada

| Linha | Significado |
|-------|-------------|
| `STOP F1: agy não encontrado no PATH` | Não há `agy` no Windows: o trabalho para. |
| `STOP F1: shim do agy sem script JS identificado…` | O `agy` é um atalho que a sonda não chama com segurança; mande a saída de `where agy`. |
| `STOP F4: login da assinatura não provado com perfil privado` | O login não sobreviveu ao perfil privado, ou não é de assinatura. Nenhuma cota gasta. Volta para você decidir. |
| `STOP F3: <hook> não falhou fechado` | Um hook que devia bloquear deixou gravar. Sem trava: o trabalho para. |
| `STOP F3: hook não disparou` | O `agy` no Windows ignorou o hook: o trabalho para. |
| `STOP F4: agy models falhou…` / `STOP F4: fonte de login desconhecida…` | A própria checagem de login falhou, ou o Windows mostrou uma fonte de credencial nunca vista. Nenhuma cota gasta; mande o `results.json` para revisão. |
| `STOP sonda: …` | Problema da própria sonda (por exemplo, um caractere no caminho do seu perfil que ela recusa). Não é fato sobre o agy; mande a linha. |
| `INCONCLUSIVO: …` | Uma execução não provou nada (o modelo nem tentou gravar, ou `hook-cmd-failed`: a linha de comando do hook não rodou no shell do agy). Mande o `results.json`. |
| `PROIBIDO: …` (analyze-trace) | A árvore de processos do `agy` mexeu no seu perfil real: o F5 falha. |
| `INCOMPLETO: …` (analyze-trace) | A captura perdeu algum lançamento do agy. Capture de novo do início ao fim. |

## Devolvendo a evidência

Leia antes o `docs\evidencias\gemini-windows-phase0\<runId>\results.json` procurando dados pessoais. Depois faça commit e push **só desse arquivo** (nunca do CSV do Process Monitor), ou cole o conteúdo aqui. Cole também a saída do analyze-trace.
