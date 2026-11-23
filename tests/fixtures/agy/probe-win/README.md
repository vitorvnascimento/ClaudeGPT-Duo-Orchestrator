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
2. In Process Monitor: Filter → `Process Name` `is` `agy.exe` → Include, and `Process Name` `is` `node.exe` → Include. Clear the list, then start the capture.
3. Run:
   ```powershell
   node tests\fixtures\agy\probe-win\probe.mjs --pause
   ```
   It stops before every `agy` launch; press Enter each time.
4. Stop the capture. File → Save → "Events displayed using current filter", format CSV.
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
| `INCONCLUSIVO: …` | A run gave no proof either way (for example, the model never tried to write). Rerun once. |
| `PROIBIDO: …` (analyze-trace) | `agy` touched your real profile: F5 fails. |

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
2. No Process Monitor: Filter → `Process Name` `is` `agy.exe` → Include, e `Process Name` `is` `node.exe` → Include. Limpe a lista e comece a captura.
3. Rode:
   ```powershell
   node tests\fixtures\agy\probe-win\probe.mjs --pause
   ```
   Ele para antes de cada `agy`; aperte Enter a cada vez.
4. Pare a captura. File → Save → "Events displayed using current filter", formato CSV.
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
| `INCONCLUSIVO: …` | Uma execução não provou nada (por exemplo, o modelo nem tentou gravar). Rode de novo uma vez. |
| `PROIBIDO: …` (analyze-trace) | O `agy` mexeu no seu perfil real: o F5 falha. |

## Devolvendo a evidência

Leia antes o `docs\evidencias\gemini-windows-phase0\<runId>\results.json` procurando dados pessoais. Depois faça commit e push **só desse arquivo** (nunca do CSV do Process Monitor), ou cole o conteúdo aqui. Cole também a saída do analyze-trace.
