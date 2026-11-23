# Gemini on Windows — Phase 0 (facts spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone probe the owner runs on the Windows PC that answers F1–F7 of the spec with sanitized evidence, spending no inference quota until a subscription login is proven.

**Architecture:** Plain Node ESM under `tests/fixtures/agy/probe-win/`, Node built-ins only, no imports from `dist/` (avoids the drive-letter ESM import problem). Pure helpers in `lib.mjs` are unit-tested on the Mac; `probe.mjs` orchestrates the live steps on Windows; five tiny hook scripts stand in for the gate. Product code is **not** touched in this plan. The implementation plan (Phase 1) is written only after the facts come back.

**Tech Stack:** Node 22 ESM, `node:test`, Windows `cmd.exe`/`where`/PowerShell `Get-CimInstance` (read-only), Sysinternals Process Monitor (manual, owner's OK).

**Spec:** `docs/superpowers/specs/2026-11-23-gemini-windows-design.md` (section "Phase 0").

## Global Constraints

- Branch `feature/gemini-windows`, worktree `.worktrees/duo-cu`. No change under `src/`.
- Node built-ins only; no npm dependency.
- Order: F1, then F4 (`agy models`, inference-free) in the exact env the headless runs use; F2/F3/F6/F7 (quota) run **only if** the auth verdict is `proceed`.
- Never write to the owner's real `%USERPROFILE%\.gemini`, Antigravity config or AppData dirs; every `agy` launch uses a private root under `%LOCALAPPDATA%\duo-probe-win\<runId>\`.
- Evidence is sanitized before it is written: no email, no token, owner's profile path replaced by `%USERPROFILE%`.
- Stop rules from the spec are printed by the probe, not improvised: F1 no `agy` → stop; F4 not proven → stop before inference; hook does not fire or does not fail closed → stop.
- Model for quota runs: `gemini-3.8-flash-low` (cheapest; override with `--model`).
- Repo text: README of the probe in English first, Portuguese below.

## Review Focus

1. `agy` installed as an npm `.cmd` shim backed by JavaScript: version must come from the script, not from Node → `resolveAgy` test with a fake shim (Task 1).
2. Auth log with mixed signals (consumer plus api/adc) must not proceed → `authVerdict` conflict test (Task 1).
3. A hook path containing `%`, `^`, `&`, `"` or `!` must be refused, not quoted → `hookCommand` test (Task 1).
4. Procmon CSV with quoted commas in `Path`/`Detail` columns → `analyzeTrace` test with such a row (Task 1).
5. Hook timeout scenario must not hang the probe forever → `probe.mjs` per-run timeout (Task 3, 180 s) and hook sleep longer than the hook timeout (Task 2).

---

### Task 1: Pure helpers

**Files:**
- Create: `tests/fixtures/agy/probe-win/lib.mjs`
- Test: `tests/fixtures/agy/probe-win/lib.test.mjs`

**Interfaces:**
- Produces:
  - `redact(text: string, profileDir: string): string` — emails → `<email>`; runs of ≥32 chars `[A-Za-z0-9_\-.]` → `<token>`; `profileDir` (case-insensitive) → `%USERPROFILE%`.
  - `privateEnv(base: Record<string,string>, root: string): Record<string,string>` — copies `base`, deletes keys matching `/^(GEMINI_|GOOGLE_|AGY_)/i` (any casing of the key), then sets `HOME`, `USERPROFILE` = `root\home`; `APPDATA` = `root\home\AppData\Roaming`; `LOCALAPPDATA` = `root\home\AppData\Local`; `TEMP`, `TMP` = `root\tmp`. Replaced keys are removed in any casing first. (No partial variant: leaving `APPDATA` real could let `agy` write to the owner's real AppData.)
  - `authVerdict(logText: string): { verdict: "proceed" | "stop"; methods: string[]; effectives: string[]; lines: string[] }` — `methods` from `/\bauthMethod=([a-z_]+)/g`, `effectives` from `/\(effective: ([a-z_]+)\)/g`, `lines` = log lines matching `/auth|keyring|credential|wincred|login/i` (unredacted here; caller redacts). `proceed` only if `methods` is exactly `["consumer"]` and no effective matches `/api|adc|cloud|enterprise|gateway|business|vertex/`.
  - `hookCommand(nodePath: string, script: string, args: string[]): string` — `"node" "script" "arg"…` with each part in double quotes; throws `Error("caractere não suportado no caminho do hook: <c>")` if any part contains `%`, `^`, `&`, `"`, `!`, or a control char.
  - `analyzeTrace(csv: string, forbidden: string[]): { hits: { time: string; process: string; pid: string; op: string; path: string }[] }` — parses Procmon CSV (header row; RFC 4180 quoting), returns rows whose `Path` starts (case-insensitive) with any `forbidden` prefix.
  - `resolveAgy(whereOutput: string, readFile: (p: string) => string): { kind: "exe" | "cmd-js" | "cmd-other" | "missing"; path: string | null; script: string | null }` — first line of `where agy`; `.exe` → `exe`; `.cmd` whose body references a `.js`/`.mjs`/`.cjs` under `%dp0%`/`%~dp0` → `cmd-js` with the absolute script path; other `.cmd` → `cmd-other`; empty → `missing`.

- [ ] **Step 1: Write the failing tests** in `lib.test.mjs` (`node:test`, `node:assert/strict`):
  - `redact` replaces `ana@example.com`, a 40-char token, and `C:\Users\Vitor` (given `c:\users\vitor`) → `<email>`, `<token>`, `%USERPROFILE%`.
  - `privateEnv({ Path: "x", gemini_api_key: "k", GOOGLE_CLOUD_PROJECT: "p", userprofile: "C:\\real" }, "R")` has no `gemini_api_key`, no `GOOGLE_CLOUD_PROJECT`, no lowercase `userprofile`, `USERPROFILE === "R\\home"`, `TEMP === "R\\tmp"`, `Path === "x"`.
  - `authVerdict("authMethod=consumer ... (effective: keyring)")` → `proceed`; with an extra `authMethod=api_key` line → `stop`; with `(effective: adc)` → `stop`; empty → `stop`.
  - `hookCommand("C:\\n\\node.exe", "C:\\p\\h.mjs", ["C:\\l\\log.jsonl"])` → `"C:\n\node.exe" "C:\p\h.mjs" "C:\l\log.jsonl"`; each of `%`, `^`, `&`, `"`, `!` in a path throws.
  - `analyzeTrace` on a 3-row CSV, one row with `"C:\Users\v\.gemini\x, y"` (quoted comma) under forbidden `C:\Users\v\.gemini` → exactly that hit.
  - `resolveAgy`: `.exe` path → `exe`; fake `.cmd` body containing `"%dp0%\node_modules\agy\cli.js"` → `cmd-js` with the joined script path; empty → `missing`.

- [ ] **Step 2: Run to see them fail**
  Run: `node --test tests/fixtures/agy/probe-win/`
  Expected: FAIL (`lib.mjs` missing).

- [ ] **Step 3: Implement the six functions** in `lib.mjs` with `node:path`'s `win32` API for joins (the helpers must give Windows results when tested on the Mac).

- [ ] **Step 4: Run to see them pass**
  Run: `node --test tests/fixtures/agy/probe-win/`
  Expected: all pass, 0 fail.

- [ ] **Step 5: Commit** `test(probe-win): helpers puros do teste de fatos do Gemini no Windows`

### Task 2: Hook scripts

**Files:**
- Create: `tests/fixtures/agy/probe-win/hooks/allow-log.mjs`, `deny.mjs`, `crash.mjs`, `garbage.mjs`, `timeout.mjs`
- Test: `tests/fixtures/agy/probe-win/hooks.test.mjs`

**Interfaces:**
- Each hook reads stdin (the agy `PreToolUse` input), takes the log path as `process.argv[2]`, appends one JSON line `{ hook, argv: process.argv.slice(1), ppid: process.ppid, comspec: process.env.ComSpec ?? null, toolName, args, modelName, keys: Object.keys(input) }` (best effort), then:
  - `allow-log` → stdout `{"decision":"allow","reason":"probe"}`
  - `deny` → stdout `{"decision":"deny","reason":"probe-deny"}`
  - `crash` → `throw new Error("probe-crash")` after logging (exit code ≠ 0, no stdout)
  - `garbage` → stdout `not json`
  - `timeout` → sleeps 60 s (hooks.json gives it `timeout: 5`), then writes allow.
- `toolName`/`args`/`modelName` read from `input.toolCall.name`, `input.toolCall.args`, `input.modelName` (same shape as `src/adapters/gemini-gate-hook.ts`).

- [ ] **Step 1: Write the failing test**: spawn each hook (except `timeout`) with `node`, stdin `{"toolCall":{"name":"write_file","args":{"path":"a.txt"}},"modelName":"m"}`, log path in a temp dir; assert stdout per hook, `crash` exit code ≠ 0, and that the log line has `toolName === "write_file"`, `modelName === "m"`.
- [ ] **Step 2: Run** `node --test tests/fixtures/agy/probe-win/` → FAIL.
- [ ] **Step 3: Implement the five hooks.**
- [ ] **Step 4: Run** `node --test tests/fixtures/agy/probe-win/` → all pass.
- [ ] **Step 5: Commit** `test(probe-win): hooks de sonda (allow, deny, crash, lixo, timeout)`

### Task 3: Probe orchestrator

**Files:**
- Create: `tests/fixtures/agy/probe-win/probe.mjs`, `tests/fixtures/agy/probe-win/analyze-trace.mjs`
- Test: `tests/fixtures/agy/probe-win/probe.test.mjs`

**Interfaces:**
- Consumes: Task 1 helpers; Task 2 hook paths.
- CLI: `node probe.mjs [--dry-run] [--pause] [--model <id>] [--out <dir>]`. Default `--out`: `docs/evidencias/gemini-windows-phase0/<runId>/` (repo-relative, resolved from the script dir). `runId` = ISO time with `:` replaced by `-`.
- `analyze-trace.mjs <procmon.csv> <results.json>` → prints hits from `analyzeTrace` with `forbidden` = `[%USERPROFILE%\.gemini, %APPDATA%, %LOCALAPPDATA%]` minus the probe's own private root (taken from `results.json`), exit 1 if any hit.

Steps of `probe.mjs` (each result goes into `results.json`, every string through `redact`):
1. **F1:** `where agy` (via `cmd.exe /d /c where agy`) → `resolveAgy`. `missing` → write results, print `STOP F1: agy não encontrado`, exit 2. Version: `exe` → `agy.exe --version`; `cmd-js` → `node <script> --version`; `cmd-other` → `cmd.exe /d /c agy --version` (record which). Also record `--help` flags list (first 200 lines, redacted).
2. **F4/F5 (no inference):** fresh private root, `privateEnv(process.env, root)`, run `agy models` (30 s timeout). Record: exit code, model ids printed (lines matching `/^gemini-/`), names of dirs/files created under the private root (relative paths, depth 4), `authVerdict` over all files under `<root>\home\.gemini\antigravity-cli\log\` (lines redacted). Also record read-only: `cmdkey /list` target names matching `/antigravity|gemini|google/i` (names only), and existence (not content) of `%APPDATA%\Antigravity*`, `%LOCALAPPDATA%\Antigravity*`, `%USERPROFILE%\.gemini`.
   - Verdict `proceed` → continue; else stop with `STOP F4: login da assinatura não provado com perfil privado` (the spec sends this back to the owner). No inference after a stop.
3. **`--dry-run`** stops here with exit 0 (no quota spent).
4. **F2/F3/F6/F7 (quota, 5 runs):** for `hook` in `["allow-log", "deny", "crash", "garbage", "timeout"]`: temp dir under the private root, `git init`, `.agents/hooks.json` = `{ "probe": { "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": hookCommand(process.execPath, <hook path>, [<log path>]), "timeout": hook === "timeout" ? 5 : 10 }] }] } }`; run `agy -p= --input-format stream-json --output-format stream-json --model <model> --settings {"allowNonWorkspaceAccess":false,"permissions":{"deny":["command(*)"]}}` with stdin `{"event":"user","message":{"role":"user","content":"Create the file probe-<hook>.txt in the current directory containing the word OK, using your file-writing tool. Do nothing else."}}`, cwd = temp dir, env = the same private env, 180 s timeout. Record: set of stdout `event` values (F2), `result.status`, whether `probe-<hook>.txt` exists, hook log lines (F3/F6/F7, redacted), parent process name of each logged `ppid` via `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=<ppid>').Name"`.
   - Pass rules: `allow-log` → file exists and log has ≥1 line (hook fired). Every other hook → file absent **and** the stdout stream shows the write tool call ending in `ERROR` (record its message), with the hook log showing the hook ran for that call (`timeout`: the log line exists even though no decision came back). A missing file without that evidence (the model never tried, or the client refused the path before the hook) is `inconclusive`, not passed. Violation → `STOP F3: <hook> não falhou fechado` / `STOP F3: hook não disparou`.
5. **`--pause`:** before every `agy` launch print `>>> <label> <time> — Enter para continuar` and wait (for a Procmon capture window).
6. Write `results.json` and print a summary table plus the stop line, if any.

- [ ] **Step 1: Write the failing test** `probe.test.mjs`: run `node probe.mjs --dry-run --out <tmp>` with `PATH` pointing to a temp dir holding a fake `agy` (on the Mac: an executable sh script; `where` is absent there, so the test sets `PROBE_WHERE_OVERRIDE=<fake path>` which `probe.mjs` uses instead of `where`) that prints `1.5.99` for `--version` and, for `models`, writes `authMethod=consumer` and `authenticated via keyring (effective: keyring)` into `$HOME/.gemini/antigravity-cli/log/a.log` and prints `gemini-3.8-flash-low`. Assert exit 0, `results.json` has `f1.version === "1.5.99"`, `f4.verdict === "proceed"`, and no `@` in the file.
- [ ] **Step 2: Run** `node --test tests/fixtures/agy/probe-win/` → FAIL.
- [ ] **Step 3: Implement `probe.mjs` and `analyze-trace.mjs`** (`spawnSync` with `timeout`; `PROBE_WHERE_OVERRIDE` only bypasses `where`).
- [ ] **Step 4: Run** `node --test tests/fixtures/agy/probe-win/` → all pass. Also `node --check` both files.
- [ ] **Step 5: Commit** `test(probe-win): orquestrador do teste de fatos e análise do rastreio`

### Task 4: README and hand-off to the Windows PC

**Files:**
- Create: `tests/fixtures/agy/probe-win/README.md` (EN, then PT)

- [ ] **Step 1: Write the README** with, in order: what it spends (dry run: nothing; full run: 5 short Flash runs on the Google AI Pro quota), prerequisites (Node 22, `git`, `agy` logged in), exact PowerShell commands from the `duo-win` clone (`git fetch`, `git switch feature/gemini-windows`, `node tests\fixtures\agy\probe-win\probe.mjs --dry-run`, then the full run), the Process Monitor procedure (download from Microsoft Sysinternals only with the owner's OK; filter `Process Name` is `agy.exe` or `node.exe`; start capture; run `probe.mjs --pause`; stop; File → Save → CSV; `node tests\fixtures\agy\probe-win\analyze-trace.mjs <csv> <results.json>`), the stop lines and what they mean, and how to return the evidence (commit `docs/evidencias/gemini-windows-phase0/<runId>/results.json` only after reading it for personal data; do not commit the Procmon CSV).
- [ ] **Step 2: Run all probe tests once more** `node --test tests/fixtures/agy/probe-win/` → pass.
- [ ] **Step 3: Commit** `docs(probe-win): instruções do teste de fatos no Windows (EN/PT)`
- [ ] **Step 4: Push the branch** `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin feature/gemini-windows` (the owner's PC needs it).

### Task 5: Owner runs on Windows (checkpoint)

- [ ] **Step 1:** The owner (or a Claude session on the Windows PC) runs the dry run, then the full run with Procmon, per the README.
- [ ] **Step 2:** Evidence is committed and pushed from Windows, or pasted back.

### Task 6: Facts doc and go/stop

**Files:**
- Create: `docs/gemini-agy-facts-windows.md` (EN, then PT)

- [ ] **Step 1:** From `results.json` and the trace analysis, answer F1–F7 one line each with the evidence path; apply the spec's stop rules and the checkpoint rule (mechanical differences absorbed; contradictions go to the owner).
- [ ] **Step 2: Commit** `docs: fatos do agy no Windows (Fase 0)` and push.
- [ ] **Step 3:** Go → write the Phase 1 implementation plan from the spec plus these facts. Stop → report to the owner with the stop line and evidence.
