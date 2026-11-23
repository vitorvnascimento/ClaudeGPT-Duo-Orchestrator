# Gemini on Windows — Phase 1 (implementation) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Gemini executor runs on `win32` with one preventive lock (the gate hook, hardened for Windows paths) plus a warning-only post-run check, and stays exactly as today on macOS.

**Architecture:** Platform branches inside the existing Gemini pipeline: one private-environment builder for every `agy` launch, a Windows private profile without the Keychains link, a gate that refuses Windows path tricks before resolving them, a hook that receives its files by argument and enforces its own deadline, a preflight that refuses `codeium.yaml`-style files above the worktree, and a drift snapshot around each Windows attempt. No OS sandbox on Windows (owner decision).

**Tech Stack:** TypeScript, Node built-ins only, `node:test`; Windows built-ins (`cmd.exe`, `git`).

**Spec:** `docs/superpowers/specs/2026-11-23-gemini-windows-design.md` (Amendment B wins where it disagrees). **Facts:** `docs/gemini-agy-facts-windows.md`.

## Global Constraints

- Branch `feature/gemini-windows`, worktree `.worktrees/duo-cu`. If the 0.5.1 Gemini fixes land on `develop` first and touch `gemini-gate.ts` or `gemini.ts`, rebase before Task 4.
- No runtime dependency. Every change behind `platform === "win32"` unless the task says otherwise; macOS behaviour and every existing test unchanged (`npm test` green after each task).
- Functions that branch on platform take an optional `platform: NodeJS.Platform = process.platform` parameter so tests on the Mac can exercise the `win32` branch; pure path logic uses `path.win32` explicitly.
- `GEMINI_VERIFIED` gets `{ version: "1.5.15", platform: "win32" }` **only** in Task 11, after the Windows battery passes on the owner's PC (pass bar: every scenario passes; any inconclusive needs the owner's waiver for that probe, version and platform).
- Release gates still open from Phase 0 (owner waiver 2026-11-23): F5 for every launch path through the integrated commands, and timeout attribution (hook cut near the deadline, last parent-alive sample ≤ limit + 500 ms).
- Risk HIGH (process execution, containment, credentials): Codex adversarial review of the whole branch before release; `main`/tag/release only with the owner's explicit permission.
- Repo text: English first, Portuguese below (README, CHANGELOG, SECURITY.md, release notes).
- Tests: `npm test` (build + `node --test dist/tests/*.test.js`). Inside the Codex sandbox use `env -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED npm test`.

## Review Focus

1. Project under a path with spaces (`C:\Users\x\My Projects\app`) → hook command line still parses in `cmd.exe` → Task 5 test with a spaced worktree path.
2. Owner profile with a non-ASCII name (`C:\Users\João`) → private state under `%LOCALAPPDATA%` and the hook command still work → Task 2 and Task 5 tests with an accented root.
3. `duo apply` of a sibling task during a Windows Gemini attempt → drift note names the apply, task not failed → Task 9 test.
4. Documents folder synced by OneDrive (placeholder files that fail to read) → snapshot error → `post-run check incomplete`, never clean → Task 8 test with an unreadable file.
5. A worktree whose ancestor holds `.codeium.yml` (dotted, `.yml`) → delegation refused on Windows → Task 7 test for each of the four names.

---

### Task 1: Case-insensitive child environment on Windows

**Files:**
- Modify: `src/permissions/auth.ts:51` (`childEnv`), `src/permissions/gemini-auth.ts:19` (`geminiParentEnvProblem`)
- Test: `tests/gemini-win32-env.test.ts` (new)

**Interfaces:**
- Produces: `childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): { env: NodeJS.ProcessEnv; removed: string[] }`. On `win32`: a key is removed when its upper-cased name is in `BILLING_ENV` or matches `BRAIN_SESSION_ENV` (test the upper-cased name); any existing key equal ignoring case to a key of `extra` is removed before `extra` is applied. Other platforms: unchanged.
- Produces: `geminiParentEnvProblem(parentEnv, platform = process.platform)` — on `win32` matches `GOOGLE_ENV` names ignoring case.

- [ ] **Step 1: Failing tests:** `geminiParentEnvProblem({ gemini_api_key: "k" }, "win32")` names the key (darwin: `null`, unchanged); `childEnv({ gemini_api_key: "k", Anthropic_Api_Key: "a", Home: "C:\\real", Path: "p" }, { HOME: "D:\\priv" }, "win32")` → no `gemini_api_key`, no `Anthropic_Api_Key`, no `Home`, `HOME === "D:\\priv"`, `Path === "p"`, `removed` contains the two billing keys. Same input with `"darwin"` keeps `gemini_api_key` and `Home` (unchanged behaviour).
- [ ] **Step 2:** `npm test` → the new tests fail.
- [ ] **Step 3:** Implement in `auth.ts`.
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** Commit `fix(auth): filtro de ambiente sem diferenciar caixa no Windows`.

### Task 2: Windows private profile and one environment builder

**Files:**
- Modify: `src/state/gemini-state.ts:21` (`geminiStateRoot`), `:37` (`createPrivateHome`)
- Test: `tests/gemini-state.test.ts`, `tests/gemini-win32-env.test.ts`

**Interfaces:**
- Consumes: Task 1 `childEnv`.
- Produces:
  - `geminiStateRoot(env = process.env, platform = process.platform): string` — `win32`: `join(env.LOCALAPPDATA ?? join(realHome(env), "AppData", "Local"), "duo", "gemini-state")` (use `path.win32` when `platform === "win32"`).
  - `createPrivateHome(chainDir: string, env = process.env, platform = process.platform): { home: string }` — `win32`: creates `home\AppData\Roaming` and `home\AppData\Local`, no `Library/Keychains` link; the seeded `.gemini/config/config.json` as today.
  - `privateProfileEnv(base: NodeJS.ProcessEnv, profile: { home: string; tmpDir: string }, platform = process.platform): { env: NodeJS.ProcessEnv; removed: string[] }` — darwin: `childEnv(base, { HOME, TMPDIR })` (today's behaviour); `win32`: `childEnv(base, { HOME, USERPROFILE: home, APPDATA: home\AppData\Roaming, LOCALAPPDATA: home\AppData\Local, TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir, HOMEDRIVE, HOMEPATH }, "win32")` with `HOMEDRIVE` = drive of `home` (`C:`) and `HOMEPATH` = rest.
  - `withMetadataProfile<T>(base: NodeJS.ProcessEnv, fn: (env: NodeJS.ProcessEnv, cwd: string) => T, platform = process.platform): T` — temp dir via `mkdtempSync(join(tmpdir(), "duo-agy-meta-"))`, `createPrivateHome`, a `tmp` subdir, calls `fn(privateProfileEnv(...).env, cwd)` where `cwd` is a private `work` subdir of the temp dir (on `win32` also checked with `agyConfigAbove(cwd)` from Task 7 — a found config throws), so metadata probes never run in the project directory, removes the temp dir in `finally`.

- [ ] **Step 1: Failing tests:** `geminiStateRoot({ LOCALAPPDATA: "C:\\Users\\João\\AppData\\Local" }, "win32") === "C:\\Users\\João\\AppData\\Local\\duo\\gemini-state"`; `createPrivateHome(tmp, env, "win32")` creates `home/AppData/Roaming` and `home/AppData/Local` and no `home/Library`; `privateProfileEnv({ userprofile: "C:\\real", Path: "p" }, { home: "C:\\S\\home", tmpDir: "C:\\S\\tmp" }, "win32").env` has `USERPROFILE "C:\\S\\home"`, `APPDATA "C:\\S\\home\\AppData\\Roaming"`, `TEMP`/`TMP "C:\\S\\tmp"`, `HOMEDRIVE "C:"`, `HOMEPATH "\\S\\home"`, no `userprofile`; darwin result equals `childEnv(base, { HOME, TMPDIR })`; `withMetadataProfile` passes an env whose `HOME` is inside a temp dir that no longer exists afterwards.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → green (existing Keychains tests still pass on darwin).
- [ ] **Step 5:** Commit `feat(gemini): perfil privado do Windows e construtor único de ambiente`.

### Task 3: Every `agy` launch through the private environment

**Files:**
- Modify: `src/adapters/gemini.ts:81` (`plan` env), `src/permissions/gemini-auth.ts:41,93` (`geminiAuthPreflight`, `geminiLoginProbe`), `src/adapters/catalog.ts:446,490` (`discoverGemini`, `cliVersions` gemini part), `src/orchestration/router.ts:211` (`--version`), `src/orchestration/delegate.ts:249` (`probe(... --help ...)`), `src/cli/doctor.ts:181-205` (`probe`, login probe)
- Test: `tests/gemini-win32-env.test.ts`, existing `tests/gemini-auth.test.ts`, `tests/gemini-catalog.test.ts`

**Interfaces:**
- Consumes: Task 2 `privateProfileEnv`, `withMetadataProfile`.
- Produces:
  - `GeminiAdapter.plan`: env = `privateProfileEnv(input.env, { home: input.gemini.privateHome, tmpDir: input.gemini.tmpDir }, this.platform).env`.
  - `geminiAuthPreflight(resolved, env, cfg, profilePath, platform = process.platform)`: `env` is already the private env (callers pass it); `home` read as today from `HOME`.
  - `geminiLoginProbe(resolved, env, cfg, platform = process.platform)`: builds the probe env with `privateProfileEnv` over its temp home.
  - `discoverGemini` and `cliVersions`, router `--version`, delegate and doctor `probe(...)`: wrap the launch in `withMetadataProfile(baseEnv, (env, cwd) => …, platform)` and launch with that `cwd` (`discoverGemini` stops using the project dir). Task 7's `agyConfigAbove` is implemented first inside this task as a pure helper; Task 7 wires it into delegation.

- [ ] **Step 1: Failing test:** a fake `agy` (a Node script made executable, as the existing catalog tests do) that writes `JSON.stringify({ HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, TMP })` to a file named by an env var, then behaves like `agy --version` / `models`. Assert, for `cliVersions`, `discoverGemini` (through the exported catalog entry point the existing tests use) and `geminiLoginProbe` with `platform: "win32"`, that `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` are inside a private temp/state dir and differ from the test process's real values, and that the child's working directory (written by the fake `agy` as `process.cwd()`) is the private `work` dir, never the project dir.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** Commit `feat(gemini): toda chamada do agy usa o perfil privado (versão, ajuda, modelos, login, tarefa)`.

### Task 4: Gate hardening for Windows paths

**Files:**
- Modify: `src/adapters/gemini-gate.ts` (`GateAllowlist` :11, `pathArgs` :69, `relInside` :79, `decideToolCall` :88)
- Test: `tests/gemini-gate.test.ts`

**Interfaces:**
- Produces:
  - `win32PathProblem(raw: string, worktreeRoot: string): string | null` (pure, `path.win32`): a reason when `raw` has `:` after the drive letter, a component ending in `.` or space (a standalone `.` is fine), a `..` component, a reserved device name in any component (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, superscript-digit variants; with or without extension), a `\\?\`, `\\.\`, `\??\` or UNC prefix, a drive different from `worktreeRoot`'s, a component shaped like an 8.3 short name (`/~\d/`) — reported as `"short-name"` so the caller can decide by existence —, or any of `<>"|?*` / control characters.
  - `insideExact(root: string, abs: string): string | null` (`path.win32`): the `/`-joined relative path when `abs` starts with `root` component by component **with exact spelling**, else `null`.
  - `GateAllowlist` gains `nonce: string` (hex, per preparation) and `hookTimeoutSec: number`.
  - `pathDigest(nonce: string, raw: string): string` — first 16 hex chars of `sha256(nonce + "\0" + raw)`.
  - `decideToolCall(input, allow, canon = canonicalPath, opts: { platform?: NodeJS.Platform; nlink?: (abs: string) => number } = {}): GateDecision` — on `win32`: every raw path arg through `win32PathProblem` before `canon` (a `"short-name"` result is allowed only when that component exists on disk, so `realpathSync.native` resolves it to its long name inside `canonicalPath`; a nonexistent short-name component is denied); `insideExact` instead of `relInside`; deny reads and writes of an existing file with `nlink(abs) > 1` (default `nlink` = `statSync(abs).nlink`, missing file = 0); grants keep exact, case-sensitive matching; protected names and `scope.deny` stay case-insensitive (already true).

- [ ] **Step 1: Failing tests** (all with `platform: "win32"`, `canon` = identity over `path.win32.resolve`): denied — `a.txt:x`, `a.txt::$DATA`, `src\app.ts.`, `src\app.ts `, `..\x`, `src\..\x`, `CON`, `nul.txt`, `COM¹`, `\\?\C:\wt\a`, `\\server\s\a`, `D:\wt\a` (root on `C:`), `a<b`; allowed — `.` (list_dir), `.\src\app.ts` (read); root `C:\Wt` vs path `C:\wt\a.txt` → denied (exact spelling); grant `a.txt` vs write `A.txt` not yet existing → denied; `nlink` returning 2 → read and write denied; `PROGRA~1\new.txt` where the `PROGRA~1` component does not exist → denied, and an existing short-name component (injected `exists`) → allowed and resolved by `canon`; darwin with the same inputs keeps today's results (`..` handling unchanged).
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** Commit `feat(gemini-gate): caminhos do Windows recusados antes de resolver; raiz exata; hard link negado`.

### Task 5: Hook command line, arguments and own deadline

**Files:**
- Modify: `src/adapters/gemini-gate.ts:184-213` (`shq`, `writeGateFiles`), `src/adapters/gemini-gate-hook.ts`
- Test: `tests/gemini-gate.test.ts`, `tests/gemini-gate-hook.test.ts` (new)

**Interfaces:**
- Consumes: Task 4 `GateAllowlist` (`nonce`, `hookTimeoutSec`), `pathDigest`.
- Produces:
  - `win32HookCommand(parts: string[]): string` — bare `node` first (the form Phase 0 proved under `cmd.exe`; a quoted first token followed by more quoted arguments is stripped by `cmd /c`), then each argument in double quotes; the bridge refuses when `where node` does not resolve first to `process.execPath` (case-insensitive); throws `Error("caractere não suportado na linha do hook: <c>")` for `%`, `^`, `&`, `"`, `!`, `` ` ``, `$`, `'` or control characters. (`cmd.exe` runs the hook on Windows, F3.)
  - `writeGateFiles(worktreeRoot, privateHome, allow, opts: { nodePath: string; hookScript?: string; timeoutSec?: number; platform?: NodeJS.Platform })` — `win32`: command = `win32HookCommand(["node", hookScript, allowlistPath, logPath])`, no env prefix; darwin unchanged. Writes `nonce` (random 16 bytes hex) and `hookTimeoutSec` into the allowlist.
  - Hook: allowlist path = `argv[2] ?? env.DUO_GATE_ALLOWLIST`, log = `argv[3] ?? env.DUO_GATE_LOG`. Order: read the allowlist (argv/env) first, arm the deadline and the parent watch, then read stdin **asynchronously** (`process.stdin` events, not `readFileSync(0)`); on a normal decision clear both timers so the hook exits at once. Own deadline: `setTimeout(denyAndExit, max(1000, hookTimeoutSec*1000 - 1500))`; on `win32` a 250 ms interval exits when `process.kill(process.ppid, 0)` throws `ESRCH`. Log line gains `pathDigest: string[]` (one per raw path arg, via `pathDigest(allow.nonce, raw)`).

- [ ] **Step 1: Failing tests:** `writeGateFiles(..., { platform: "win32", nodePath: "C:\\Program Files\\nodejs\\node.exe" })` writes `node "<script>" "<allowlist>" "<log>"` and an allowlist with a 32-hex `nonce`; a root containing `!` throws; spawn the built hook with the allowlist path as `argv[2]` and no env → deny/allow as `decideToolCall` says and a log line with `pathDigest` equal to `pathDigest(nonce, raw)`; with `hookTimeoutSec: 2` and a stdin that never closes, the hook prints a deny and exits within 2.5 s; with a normal stdin it exits within 1 s of answering. The real `cmd.exe` path (spaces in the script and log paths, Node under `Program Files`) is proven natively in Task 10.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** Commit `feat(gemini-gate): linha do hook para o cmd.exe, arquivos por argumento, prazo próprio`.

### Task 6: Platform gates, sandbox branches and schema location

**Files:**
- Modify: `src/adapters/gemini.ts` (new `GEMINI_PLATFORMS`, `enforced`, `--json-schema` path), `src/orchestration/delegate.ts:224,231-236,903-930`, `src/orchestration/alternates.ts:19`, `src/orchestration/router.ts:204-228`, `src/cli/doctor.ts:187-205,292-294`
- Test: `tests/gemini-delegate.test.ts`, `tests/gemini-router.test.ts`, `tests/gemini-adapter.test.ts`

**Interfaces:**
- Produces:
  - `GEMINI_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "win32"]`; `geminiPlatformSupported(p: NodeJS.Platform): boolean`.
  - Every `!== "darwin"` gate for Gemini becomes `!geminiPlatformSupported(...)`; refusal text `"executor gemini exige macOS ou Windows nesta versão"`.
  - On `win32`: `probeSandbox()` and `existsSync(SANDBOX_EXEC)` are never called (router both branches, delegate, doctor); delegate never builds `profile.sb`; `gemPrep.profilePath = null`; doctor prints `sandbox-exec: não se aplica (Windows: uma trava, decisão do dono)`; the doctor login check (`doctor.ts:201`, today `=== "darwin"`) becomes `geminiPlatformSupported(...)`, so Windows runs `geminiLoginProbe`.
  - `GeminiAdapter.plan` on `win32`: `--json-schema` file written into `input.gemini.tmpDir` instead of `input.artifactsDir`; `enforced` gains `"sem sandbox do sistema no Windows (decisão do dono, 2026-11-23); conferência pós-tarefa só avisa"`.

- [ ] **Step 1: Failing tests:** delegate with `gemini: { platform: "win32", verified: [{ version: "1.5.99", platform: "win32" }], sandbox: false }` passes `runGates`; `"linux"` still refused with the new text; `executorEligible("gemini", { platform: "win32", verified: [...win32] })` true; router availability on `win32` does not call an injected `probeSandbox` spy; adapter on `win32` puts `--json-schema` under `tmpDir` and lists the one-lock line in `enforced`; doctor on `win32` with a fake `agy` that logs no login signal reports the login blocker (not ready); the existing darwin assertions unchanged.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** Commit `feat(gemini): Windows liberado nos portões, sem sandbox-exec, esquema na pasta da tentativa`.

### Task 7: Refuse agy config files above the worktree

**Files:**
- Modify: `src/orchestration/delegate.ts:903-930` (gemini preparation; `agyConfigAbove` already exists from Task 3)
- Test: `tests/gemini-gate.test.ts`, `tests/gemini-delegate.test.ts`

**Interfaces:**
- Produces (helper written in Task 3, exported from `src/adapters/gemini-gate.ts`): `CODEIUM_CONFIG_NAMES = ["codeium.yaml", "codeium.yml", ".codeium.yaml", ".codeium.yml"] as const`; `agyConfigAbove(startDir: string, exists: (p: string) => boolean = existsSync): string | null` — walks from `dirname(startDir)` to the filesystem root and returns the first existing path among the four names (case-insensitive file systems make the literal names enough). Delegate on `win32` blocks before writing gate files: `"config do agy acima da worktree (<path redacted to its basename and depth>): remova ou mova o arquivo"`.

- [ ] **Step 1: Failing tests:** for each of the four names placed two levels above a temp start dir, `agyConfigAbove` returns it; none → `null`; a file with the name inside `startDir` itself is ignored; delegate on `win32` with one present → blocked with the message; on darwin → not checked.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** Commit `feat(gemini): no Windows recusa codeium.yaml e variantes acima da worktree`.

### Task 8: Drift snapshot (library)

**Files:**
- Create: `src/orchestration/drift.ts`
- Modify: `src/git.ts` (new `hashPathStrict`)
- Test: `tests/gemini-drift.test.ts` (new)

**Interfaces:**
- Produces:
  - `hashPathStrict(abs: string): { hash: string } | { missing: true } | { error: string }` — `missing` only for `ENOENT`/`ENOTDIR`.
  - `type CheckoutSnap = { head: string | null; files: Record<string, string>; index: Record<string, string>; hidden: string[] }`; `type DriftSnapshot = { checkouts: Record<string, CheckoutSnap>; roots: Record<string, Record<string, string> | "absent">; errors: string[] }` (per checkout: `files`: relative path → hash for every modified/untracked path; `index`: path → `"<mode> <blob>"` for dirty paths; `hidden`: paths flagged `assume-unchanged`/`skip-worktree`; `roots`: real config root → `{ relPath: "<type>:<size>:<mtimeMs>" }` or `"absent"`).
  - `takeDriftSnapshot(opts: { checkouts: string[]; configRoots: string[] }): DriftSnapshot` — per checkout: `git --no-optional-locks rev-parse HEAD`, `git --no-optional-locks status --porcelain=v1 -z --untracked-files=all`, `git --no-optional-locks ls-files -s -- <dirty>`, `git --no-optional-locks ls-files -v` (lowercase tag or `S` = hidden); any git failure or `hashPathStrict` error is pushed to `errors`, never treated as clean.
  - `compareDrift(before: DriftSnapshot, after: DriftSnapshot, applies: { taskId: string; files: string[] }[]): { changed: string[]; appliedNotes: { path: string; taskId: string }[]; hiddenUnchecked: string[]; incomplete: boolean }` — `incomplete` when either snapshot has `errors`; paths touched by an apply stay in `changed` and also get an `appliedNotes` entry.

- [ ] **Step 1: Failing tests** (temp git repos): second write to an already-modified file → `changed`; a sibling worktree advancing from one clean commit to another (clean before and after) → `changed` via its own `head`; staged-only change keeping `MM` → `changed` via `index`; untracked file created → `changed`; `.gemini` root appearing between snapshots (`absent` → map) → `changed`; a file made unreadable (`chmod 000` on POSIX, skipped on win32) → `incomplete`; a failing `git` (non-repo checkout) → `incomplete`; `skip-worktree` file listed in `hiddenUnchecked`; apply on a path → both `changed` and `appliedNotes`.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** Commit `feat(drift): retrato do checkout e das configs reais para a conferência pós-tarefa`.

### Task 9: Drift check wired into Windows delegation, cancel, recovery and apply

**Files:**
- Modify: `src/orchestration/delegate.ts` (before `lock.markSpawning` :997; after `parser.finish` :1142; limitations ~:1288), `src/orchestration/control.ts` (`cancelRun` :47, `refreshInterrupted` :17, `applyAdmitted` :140), `src/cli/main.ts` (`apply --ack-drift`), `src/cli/doctor.ts`
- Test: `tests/gemini-delegate.test.ts`, `tests/gemini-drift.test.ts`

**Interfaces:**
- Consumes: Task 8.
- Produces:
  - On `win32` Gemini attempts: `takeDriftSnapshot({ checkouts: [projectRoot, ...sibling worktrees under .duo/worktrees except this task's], configRoots: [join(realHome, ".gemini")] })` written to `<taskDir>/drift-pending.json` before spawn.
  - After the executor exits and its termination is confirmed: compare, store `task.drift = { changed, appliedNotes, hiddenUnchecked, incomplete }` with the task saved atomically (existing `writeJsonAtomic`), **then** delete the marker; recovery treats a saved `task.drift` with a leftover marker as done and only removes the marker; non-empty `changed` → limitation `"checkout drift during the Gemini attempt (<n> paths)"`; `incomplete` → `"post-run check incomplete"`. Task outcome unchanged (owner decision: warn only).
  - `cancelRun` / `refreshInterrupted`: a task with `drift-pending.json` whose executor is confirmed dead → finish the comparison; executor alive or unknown → keep the marker and set `task.drift = { …, incomplete: true }`.
  - `applies` for the comparison: tasks with `applied === true` whose apply decision time is inside the attempt window, files = `verification.filesChangedActual`.
  - `duo apply <task>`: when `task.drift?.changed.length || task.drift?.incomplete`, refuse unless `--ack-drift`; message lists the count and the flag.
  - `duo doctor`: prints the last Gemini task with drift.

- [ ] **Step 1: Failing tests:** win32 delegation with a fake `agy` that writes a file into the main checkout → task succeeds, `task.drift.changed` has the path, limitation present, `duo apply` refused without `--ack-drift` and accepted with it; sibling `duo apply` during the attempt → `appliedNotes` names it; cancel with the fake executor still alive → marker kept, `incomplete: true`; then the executor exits and recovery runs → comparison recorded once, marker removed; a crash between saving `task.drift` and removing the marker → recovery keeps the saved result; darwin delegation → no marker, no `task.drift`.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** Commit `feat(gemini): conferência pós-tarefa no Windows só avisa; apply pede --ack-drift`.

### Task 10: Windows mode of the containment battery

**Files:**
- Modify: `tests/e2e/gemini-e2e.mjs`
- Create: `tests/e2e/gemini-win-hooks/` (slow/timeout test hook reusing `tests/fixtures/agy/probe-win/hooks/timeout.mjs` logic)

**Interfaces:**
- Consumes: Tasks 1–9; `tests/fixtures/agy/probe-win/lib.mjs` (`tracePolicy`, `createTraceAnalyzer`, `summarizeAlive`, `classifyRun`).
- Produces (`win32` branch of the battery):
  - Imports via `pathToFileURL(join(ROOT, ...)).href`; a `--dry-run` that only loads modules and resolves `agy` (no quota).
  - `VERIFIED` from the full resolved command (`command` + `prefixArgs`).
  - `sandbox-exec` scenarios (G2 OS part, P-mcp OS part) skipped on `win32` and reported as `n/a`.
  - Path probes, each passing only with a matching gate-log `pathDigest` deny for that raw path: `a.txt:x`, `a.txt.`, `CON`, `..\x`, `\\?\` prefix, a hard link to a file outside the worktree — a **content read** (`read_file`) in a read-only task and a **write** to a granted path that is the hard link in a write task, both denied by digest, outside file unchanged, a case-distinct sibling worktree root.
  - Hook failure scenarios with test hooks, each showing the attempted write blocked and the target unchanged: crash (script throws), malformed output, and timeout. Timeout with the probe's slow hook: pass only with a parent-gone sample within limit −1 s … +1 s and last parent-alive ≤ limit + 500 ms.
  - G5 on `win32`: manifest of `%USERPROFILE%\.gemini` with `ENOENT` recorded as `absent`.
  - Tools that must stay denied, as on macOS: `run_command`, web, subagent, `schedule`, `run_workflow`, swarm, MCP and `P-browser`; each needs a gate-log deny or an "unavailable" proof.
  - Interruption scenario: force-kill the bridge during a Windows Gemini attempt; while the executor's termination is unknown the marker stays and the task shows `post-run check incomplete`; after the executor is confirmed dead, recovery records the comparison once.
  - Drift scenario: planted write to an already-dirty file in the main checkout and in a sibling worktree → `task.drift.changed` has both.
  - Trace attribution: `createTraceAnalyzer` gains `launchers: { pid: number; image: string }[]` (the `duo` CLI process of each command) in place of the single `probePid`; each `duo` command records its own PID and the PID/image of every `agy` it starts (new `DUO_TRACE_LOG` env var, test-only, appends JSON lines); the analyzer anchors each expected launch to its recorded launcher, and a test proves a missing expected launch yields `incomplete`, never `OK`.
  - Records launch PIDs/images for `duo models --refresh`, `duo doctor`, `duo recommend` (Gemini eligible), one delegation, and prints the `analyze-trace` command; F5 passes only with `OK` over every launch.
- [ ] **Step 1:** Port the battery; `node tests/e2e/gemini-e2e.mjs --dry-run` on the Mac → modules load, darwin scenarios unchanged.
- [ ] **Step 2:** Owner runs on Windows: dry run, full battery, Process Monitor capture, `analyze-trace`. Evidence (sanitized) into `docs/evidencias/gemini-windows-phase1/<runId>/`.
- [ ] **Step 3:** Commit `test(e2e): bateria de contenção do Gemini no Windows`.

### Task 11: Verify, document, review

**Files:**
- Modify: `src/adapters/gemini.ts:19` (`GEMINI_VERIFIED`), `README.md`, `CHANGELOG.md`, `SECURITY.md`, `docs/release-notes-0.6.0.md` (new), `tests/gemini-delegate.test.ts:95`
- [ ] **Step 1:** Only if Task 10's Windows run passes every scenario (or the owner waived each inconclusive one by name): add `{ version: <the version recorded by that battery run>, platform: "win32" }` to `GEMINI_VERIFIED` — the entry must equal the recorded version/platform pair exactly (expected `1.5.15`; if agy updated, the new version is the one that passed, and only it); update the `:95` assertion.
- [ ] **Step 2:** Docs (EN then PT): Windows has one preventive lock (the gate hook) and a warning-only post-run check; macOS keeps two; `SECURITY.md` both sections; `codeium.yaml` refusal; `--ack-drift`; installer command for `agy` on Windows.
- [ ] **Step 3:** `npm test` green; real quality gate 100/100 and E2E 17/17 on macOS; Codex adversarial review of the branch (focus: Windows path bypasses of the gate, hook deadline, env leakage, drift false-clean).
- [ ] **Step 4:** Commit `docs: Gemini no Windows (0.6.0)`; release only with the owner's permission.
