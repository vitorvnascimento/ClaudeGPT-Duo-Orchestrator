# agy on Windows — Phase 0 facts

Date: 2026-11-23. Machine: the owner's Windows PC, Windows PowerShell 5.1, Node v24.22.1 (recorded in both `results.json`; the duo's Node 22 baseline was not the one exercised). Probe: `tests/fixtures/agy/probe-win/` on `feature/gemini-windows`. Spec: `docs/superpowers/specs/2026-11-23-gemini-windows-design.md` (Phase 0 and Amendment B).

Evidence:
- dry run `docs/evidencias/gemini-windows-phase0/2026-11-23T18-00-35-080Z/results.json`;
- full run `docs/evidencias/gemini-windows-phase0/2026-11-23T18-43-09-657Z/results.json`;
- full run with Process Monitor `2026-11-23T19-32-41-914Z` (6,757,738 events, 8 agy launches), analyzed on the PC with `analyze-trace.mjs` at `41cac76`. The CSV stays on the PC (not committed).

**Decision: GO, conditional.** No stop rule fired. Two items are not yet proven: F5 for three of the eight launches, and the timeout attribution in F3. Phase 0 closes either with the owner's waiver of both (they are re-proven in the Phase 1 battery before any version is verified), or with a new run of the current probe whose analyzer verdict is `OK` over all launches **and** whose timeout run is `pass`. A rerun that is complete but not clean does not close it: a confirmed stop-rule failure (forbidden access, or a hook that does not fail closed) stops the work; an inconclusive result needs the waiver. Until one of the two is recorded here, Phase 1 may be planned but not released.

| # | Question | Answer | Evidence |
|---|----------|--------|----------|
| F1 | Does `agy` exist for Windows? | Yes. Native `agy.exe` 1.5.15 in `%LOCALAPPDATA%\agy\bin`, installed with `irm https://antigravity.google/cli/install.ps1 \| iex`. | both `results.json` (`f1`) |
| F2 | Headless stream-json as on macOS? | Yes: `-p= --input-format stream-json --output-format stream-json` runs; the same `init` / `step_update` / `result` events. | full run (`quota.runs[].events`) |
| F3 | Does the workspace `PreToolUse` hook fire and fail closed? | Yes for deny, crash and invalid output: the hook runs through `cmd.exe` and each blocks the write. **Timeout: write blocked (observed); timeout attribution inconclusive.** agy reported `command failed: exit status 1` with no timeout cause, and the hook saw its `cmd.exe` parent disappear at 5,159 ms and 5,219 ms for a 5 s limit, staying alive itself (orphan). These samples predate the `lastParentAliveMs` field, so the current classifier (`41cac76`) cannot confirm the cut happened at the deadline; a rerun with the current probe settles it. | full run (`quota.runs`, hook lifecycle log) |
| F4 | Does the login survive a fully private profile? | Yes. With `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `HOMEDRIVE`, `HOMEPATH` private, `agy models` logs `authMethod=consumer` and `effective: keyring` (Windows Credential Manager). No copy or link of the real profile. | both `results.json` (`f4`) |
| F5 | Does agy read the owner's real config? | **No access observed.** Zero successful accesses to `%USERPROFILE%\.gemini`, Antigravity/Codeium/Windsurf dirs or other forbidden paths in the captured launches. Complete lifecycles (creation, file I/O, exit) for 5 of 8 launches, covering both Phase 0 launch paths: `agy --version`, `agy --help`, `agy models`, headless `allow-log`, headless `deny`. The capture ended during the `crash` run, so `crash`, `garbage` and `timeout` are not covered; they use the same headless launch path. | analyze-trace output (below) |
| F6 | Tool names and path format | `write_file` with an absolute Windows path argument (`Path`). | full run (`hookLines`) |
| F7 | Served model in the hook input | `modelName` is present in the hook input. | full run (`hookLines[].modelName`) |

## Config discovery seen in the trace

agy walks up from its workspace to the drive root looking for `codeium.yaml`, `codeium.yml`, `.codeium.yaml` and `.codeium.yml` (144 not-found lookups across 6 launches, from the probe's base dir up to `C:\Users`). It also probes VCS markers (`.git`, `.jj`, `.hg`, `.citc`, `.repo`) in ancestors and searches `PATH` for `pwsh`. Any of the four names (`codeium.yaml`, `codeium.yml`, `.codeium.yaml`, `.codeium.yml`) in an ancestor of a duo worktree would be loaded, so the Windows delegation preflight must refuse when **any** of them exists in any ancestor up to the drive root (Amendment B).

## What Phase 1 must re-prove

- F5 through the integrated commands (`duo models --refresh`, `duo doctor`, a delegation, and `duo recommend` for the router's own `agy --version`), each with a complete lifecycle in the capture (spec, Battery on Windows).
- The timeout case with the stricter rule at `41cac76` (last parent-alive sample within 500 ms after the limit); the full run above was classified under the earlier rule and lacks that field.

## Analyze-trace output (Process Monitor run)

```text
eventos lidos: 6757738; lançamentos do agy: 8
procuras sem sucesso (o agy tentou e não achou; não são acesso): 144
sem cobertura completa: PID 28060 (agy headless (crash)) criado=true eventosDeArquivo=30962 saiu=false filhosVivos=0
sem cobertura completa: PID 29064 (agy headless (garbage)) criado=false eventosDeArquivo=0 saiu=false filhosVivos=0
sem cobertura completa: PID 37796 (agy headless (timeout)) criado=false eventosDeArquivo=0 saiu=false filhosVivos=0
INCOMPLETO: 3 lançamento(s) do agy sem criação, eventos de arquivo ou saída no rastreio
```

---

# agy no Windows — fatos da Fase 0

**Decisão: SEGUE, com condição.** Nenhuma regra de parada disparou. Falta prova em dois pontos: o F5 de 3 das 8 execuções e a causa do corte no timeout (F3). A Fase 0 fecha de um destes dois jeitos: você libera os dois pontos (eles são provados de novo na bateria da Fase 1, antes de liberar qualquer versão), ou uma nova rodada da sonda atual dá `OK` na análise de todas as execuções **e** `pass` no timeout. Rodada completa mas não limpa não fecha: falha confirmada de regra de parada (acesso proibido, ou hook que não falha fechado) para o trabalho; resultado inconclusivo precisa da sua liberação. Até isso ficar registrado aqui, a Fase 1 pode ser planejada, mas não publicada.

- **F1:** existe `agy.exe` 1.5.15 nativo em `%LOCALAPPDATA%\agy\bin`.
- **F2:** o modo headless com stream-json funciona como no Mac.
- **F3:** o hook do workspace dispara pelo `cmd.exe` e bloqueia a escrita quando nega, quando o script quebra com erro (o `crash.mjs` lança exceção) e quando responde lixo. No timeout (hook que fica parado sem responder), a escrita foi bloqueada e o hook viu o `cmd.exe` pai sumir perto dos 5 s enquanto ele próprio continuava vivo. Quem encerrou o pai, e por quê, não está provado: a mensagem do agy é um `exit status 1` genérico e os registros são de antes do campo novo. Inconclusivo até rodar de novo.
- **F4:** o login da assinatura funciona com o perfil privado completo, pelo Gerenciador de Credenciais do Windows.
- **F5:** nenhum acesso à sua config real nas 5 execuções capturadas por inteiro, que cobrem os dois caminhos de lançamento da Fase 0. A captura terminou durante a execução `crash`: `crash`, `garbage` e `timeout` ficaram sem prova.
- **F6:** a ferramenta de escrita é `write_file`, com caminho absoluto do Windows.
- **F7:** o `modelName` vem na entrada do hook.

O agy procura `codeium.yaml`, `codeium.yml`, `.codeium.yaml` e `.codeium.yml` em todas as pastas acima da pasta de trabalho, até a raiz do disco. O duo vai recusar a tarefa no Windows se achar **qualquer um** desses quatro nomes.

A Fase 1 precisa provar de novo o F5 pelos comandos do duo e o timeout com a regra nova.
