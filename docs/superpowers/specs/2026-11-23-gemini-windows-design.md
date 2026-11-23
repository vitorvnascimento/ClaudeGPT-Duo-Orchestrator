# Gemini executor on Windows — design

Date: 2026-11-23. Status: approved by the owner on 2026-11-23 ("Aprovo"). Items marked *(builder's call)* were decided by Claude, not by the owner. Base: `feature/gemini-windows`, cut from v0.5.0 (`f6da48d`). Prior design: `2026-11-22-gemini-executor-design.md` (Amendment A is the macOS contract this document extends).

## Amendment B (2026-11-23, Phase 0 facts on the owner's Windows PC)

Evidence: `docs/evidencias/gemini-windows-phase0/2026-11-23T18-00-35-080Z` (dry run) and `2026-11-23T18-43-09-657Z` (full run), plus a Process Monitor capture analyzed on the PC (not committed). This amendment supersedes the sections below wherever they disagree.

- **F1:** `agy` 1.5.15 for Windows is a native `agy.exe` in `%LOCALAPPDATA%\agy\bin` (official installer `irm https://antigravity.google/cli/install.ps1 | iex`).
- **F4:** with `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `HOMEDRIVE`, `HOMEPATH` all private, `agy models` still logs in: `authMethod=consumer`, `effective: keyring` (Windows Credential Manager). No copy or link of the real profile is needed.
- **F3:** the workspace `PreToolUse` hook fires on Windows and runs through `cmd.exe`. Denial blocks the write; a crashing hook and invalid output both fail closed.
- **Hook timeout on Windows:** `agy` kills only the `cmd.exe` it started, not the process tree, and reports `command failed: exit status 1` with no timeout cause. The hook process survives as an orphan. Consequences for the duo's Windows gate hook: it must enforce its own deadline shorter than the configured hook timeout and exit when its parent disappears; the battery proves a timeout through the hook's own lifecycle log (alive without answering until near the limit, parent gone near the limit).
- **Config discovery:** `agy` walks the parent directories of its workspace looking for `codeium.yaml` / `.codeium.yml` and VCS markers (`.git`, `.jj`, `.hg`, `.citc`, `.repo`), and searches `PATH` for `pwsh`. A `codeium.yaml` in an ancestor of a duo worktree would be loaded; the delegation preflight on Windows refuses when one exists in any ancestor of the worktree up to the drive root.
- **F5 criterion refined:** forbidden = the owner's `.gemini` and the Antigravity/Codeium/Windsurf config and state dirs under `%USERPROFILE%`, `%APPDATA%` and `%LOCALAPPDATA%`, plus agy config files (`codeium.yaml`, `.codeium.yml`, `GEMINI.md`, `AGENTS.md`) found outside the run's private root. Only successful accesses count; a not-found result is a lookup and is reported, not failed. `PATH` searches and directory opens of ancestors are not config reads. The first capture showed zero accesses to `.gemini`, Antigravity dirs or credential dirs; the re-analysis with this criterion decides F5.

## Intent

The owner works on a Windows PC as well as the Mac. On Windows, Duo 0.5.0 refuses the Gemini executor (`executor gemini exige macOS nesta versão`), so a run there can only spread work across the Claude and Codex subscriptions. The owner wants Google models as executors on Windows too, so three subscriptions share the load without losing quality.

## Owner decisions

- **One lock is enough on Windows** (2026-11-23). macOS keeps two locks: the bridge's `PreToolUse` gate hook (client layer) plus `sandbox-exec` (OS layer). Windows gets the gate hook as the only preventive lock, plus a post-run detection check. The owner accepted the residual risk: a bug in the gate or in `agy` could write outside the worktree before anyone notices.
- **Full executor, not read-only** (path 1, 2026-11-23). Windows Gemini runs the same task kinds as macOS (read and write), in a disposable worktree.

## Goals

- `duo delegate --request <file>` with `"executor": "gemini"` in the request works on `win32` with the same contract as macOS: disposable worktree, gate hook, private HOME per chain, inference-free login preflight, Google models only, executor only (never brain).
- The gate's path checks are correct under Windows path semantics.
- Adaptive routing can pick Gemini on Windows when it is enabled and the `agy` version is verified for `win32`.
- `duo doctor` on Windows reports Gemini readiness truthfully.

## Non-goals

- No OS-level sandbox on Windows (no AppContainer, low integrity level, Windows Sandbox or WSL). Revisit only if the owner asks for two locks later.
- No Linux support. Linux stays disabled.
- No change to the macOS behaviour, except shared code moving behind a platform branch.
- No relaxing of existing restrictions that came from the macOS OS profile (ASCII-only names under directory grants, `unsupportedDenyGlob`). They stay on Windows too *(builder's call: one rule set for both platforms is simpler to reason about and test)*.

## Anti-goals (failure even if it "works")

- Gemini on Windows touches the owner's real `%USERPROFILE%\.gemini`, real Antigravity config, plugins, MCP or instructions.
- A path the gate reads as inside an authorized target is written somewhere else on disk.
- Gemini silently runs on an `agy` version that never passed the battery on `win32`.
- The login preflight accepts an API key, ADC or enterprise login as "subscription".

## Constraints

- No runtime dependencies (no native modules); Node built-ins and Windows built-in tools only.
- The real tests run only on the owner's Windows PC. Claude on the Mac can run unit tests that simulate `win32` paths, but cannot run `agy` on Windows.
- Release gate unchanged: real quality 100/100 and E2E 17/17 (macOS), plus the Gemini containment battery **on Windows**, plus an independent Codex adversarial review (risk HIGH: sandbox, process execution, credentials). `main`/tag/release only with the owner's explicit permission.
- `GEMINI_VERIFIED` gets a `win32` entry only after the Windows battery passes on that exact `agy` version.

## Approaches considered

1. **Same executor, gate hardened for Windows paths, post-run detection** — chosen by the owner. Reuses the whole macOS pipeline; the work is in path semantics, the hook command line, private HOME and login on Windows.
2. **Read-only Gemini on Windows** — simpler and safer (no writes), but does not share implementation load, which is the point. Rejected by the owner.
3. **`agy` inside WSL** — would allow a Linux OS sandbox, but needs WSL installed, Linux is untested, and with one lock accepted it adds cost without benefit. Dropped.

## Phase 0 — facts on Windows (spike, before any product code)

A throwaway probe script, committed under `tests/fixtures/agy/probe-win/` with a README, run by the owner (or a Claude session on the Windows PC). It answers, with evidence written to `docs/gemini-agy-facts-windows.md` (sanitized: no email, no tokens):

| # | Question | Why it matters |
|---|----------|----------------|
| F1 | Does `agy` exist for Windows? Install path, `agy --version`, is it a `.exe` or an npm `.cmd` shim? | No `agy` → stop. Shim → reuse the bridge's existing shim resolution. |
| F2 | Does headless `-p= --input-format stream-json --output-format stream-json` behave as on macOS (same `init`/`step_update`/`result` events)? | Parser reuse. |
| F3 | Does the workspace `.agents/hooks.json` `PreToolUse` hook fire on Windows? Which shell runs `command` (`cmd.exe /c`, PowerShell, direct spawn)? Does it fail closed on crash, bad output and timeout? | The only lock. The hook command line is built in POSIX syntax today. |
| F4 | Where is the login stored (Credential Manager, a file under `%USERPROFILE%`/`%APPDATA%`/`%LOCALAPPDATA%`)? With `USERPROFILE`, `HOME`, `APPDATA` and `LOCALAPPDATA` pointed at a private dir, does `agy models` still log in? What log lines replace `authMethod=consumer` / `effective: keyring`? | Private HOME and the preflight. |
| F5 | Which env var decides where `agy` reads `.gemini` on Windows? With the private HOME, does the real `%USERPROFILE%\.gemini` stay untouched? | Isolation (G5). |
| F6 | Tool names and path argument format on Windows (`write_file`, `edit_file`…, backslashes, drive letters, relative vs absolute). | Gate allowlist and `pathArgs`. |
| F7 | Does the gate see the same `modelName` in the hook input? | Served-model evidence. |

**Order:** F1, then F4 with the inference-free `agy models` in the exact environment the headless probe will use. F2, F3 and F7 spend quota, so they run only after F4 proves a subscription login; an inconclusive F4 stops the spike before any inference.

**Stop rules:** F1 fails → stop and report. F3 shows the hook does not fire, or does not fail closed → stop (no lock left). Bring back to the owner, without a fallback, when:
- F4 shows no way to keep the login under a private profile, or the login is a token file under the real profile that would have to be copied or linked (copying may rotate the token; linking gives write access to the real profile);
- F5 shows `agy` finds its config through the Windows Known Folders API (ignoring the env vars) or otherwise reads the real `.gemini` instructions, plugins or MCP, or writes state somewhere no env var controls.

Each of these would break the isolation anti-goal. *(builder's call: stop, never improvise.)*

**F5 needs positive read evidence.** An unchanged real `.gemini` (the G5 manifest) proves no writes, not that `agy` never read the real instructions, plugins or MCP config. A log naming the private config proves it was loaded, not that the real one was not also read; a canary's absence in a reply proves nothing either. In Phase 0 the throwaway probe establishes F5 with a **file-access trace** of `agy models` and a headless `agy` run launched by the probe itself with the private profile (the product commands still refuse Windows delegation at this point). Metadata probes already run `agy` on Windows when Gemini is enabled: `cliVersions()` (`agy --version`), `discoverGemini()` (`agy models`) and `doctor`'s `probe()` (`--version`, `--help`), today with the real profile. They also go through the private environment, and the trace covers every invocation, not only `models` and the headless run. After implementation, separate traces of the integrated commands (`duo models --refresh`, `duo doctor`, a delegation), each with evidence that the expected `agy` child actually ran, are required before the version enters `GEMINI_VERIFIED`. **Forbidden:** the owner's `%USERPROFILE%\.gemini`, the Antigravity config and state dirs that F4/F5 identify under `%APPDATA%` and `%LOCALAPPDATA%`, and any other path F5 shows `agy` uses for config. **Allowed:** the generated executor report schema, which on `win32` is written into the private attempt directory instead of the main checkout's `.duo/runs/` (today `writeExecutorSchema(input.artifactsDir)`); the exact private subtree `%LOCALAPPDATA%\duo\gemini-state\<project>\<chain>\`, the worktree, and system dirs (Windows, Program Files, the `agy` and Node install dirs). The trace tool is Microsoft's Process Monitor (Sysinternals); downloading it and running it as administrator needs the owner's OK at that moment. An ambiguous trace counts as inconclusive and needs the owner's waiver.

**Version probe through the full resolved command.** If F1 finds an npm shim backed by JavaScript, the bridge resolves it to `node` plus the script in `prefixArgs`. The battery today runs `AGY.command --version` alone, which would record Node's version. On Windows the battery (version discovery and every direct probe) uses `command` plus `prefixArgs`, and a test covers the JavaScript-shim case.

**Checkpoint after Phase 0** *(builder's call)*: mechanical differences (which shell runs the hook, quoting, path format) are absorbed by the builder and reported. A fact that contradicts an assumption in this design beyond that goes to the owner before implementation.

## Design (after Phase 0 confirms the assumptions)

### Platform gates

Replace the `darwin`-only checks with a supported-platform check (`darwin` or `win32`) in `delegate.ts` (`executor gemini exige macOS`), `alternates.ts` (`executorEligible`), `doctor.ts`, and `router.ts` `liveAvailability()`. The router has two independent sandbox checks (`existsSync(SANDBOX_EXEC)` inside the Codex sandbox, `probeSandbox()` outside); both are skipped on `win32`, with a test that live availability succeeds on `win32` without `sandbox-exec`. Each platform keeps its own lock list: on `win32`, `sandbox-exec` is never probed and never required; the `enforced` list in `InvocationPlan` states "no OS sandbox on Windows (owner decision 2026-11-23); post-run detection" so the evidence is honest.

### Gate path hardening (the core of the work)

`canonicalPath`, `pathArgs`, `relInside` and `decideToolCall` in `src/adapters/gemini-gate.ts` must be correct under Windows semantics. On `win32` the gate **denies** any path argument that:

- has an NTFS stream or attribute (`:` anywhere after the drive letter: `a.txt:x`, `a.txt::$DATA`);
- has a component ending in `.` or space (Win32 strips them, so `a.txt.` becomes `a.txt`); a standalone `.` is a navigation component, not a trailing dot, so `list_dir .` and `read_file ./src/app.ts` stay allowed (tested next to the denial of `app.ts.`);
- has a `..` component: Win32 can collapse `..` before following a junction, so the hook's link-first walk and the tool could resolve different targets. Denied on `win32` unless a native test later proves both resolve to the same target;
- has a reserved device name as any component, with or without extension (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, also the superscript-digit variants);
- uses a `\\?\`, `\\.\`, `\??\` or UNC prefix, or a different drive than the worktree;
- has a component containing `~` followed by a digit (8.3 short-name form) that does not exist yet *(builder's call: existing ones resolve through `realpathSync.native`; new ones are refused because they cannot be matched against grants)*;
- contains characters invalid on Windows (`<>"|?*` and control characters).

**Root match before `relative()`.** `relInside()` uses `path.relative()`, which folds case on Windows. In a case-sensitive NTFS parent, two worktrees whose names differ only in case are distinct, and folding could strip the wrong root and leave a suffix that matches a grant. On `win32` the gate first requires the canonical path to start with the canonical worktree root component by component, with exact spelling, and only then computes the relative part. The native battery covers two case-distinct roots.

**Hard links.** A resumed worktree can hold an NTFS hard link left by an earlier executor or acceptance command. `lstat()` shows it as a regular file, and `realpathSync.native` resolves it to its in-worktree name, so another name for the same file outside the grant would be edited too. On `win32` the gate denies writes **and content reads** (`read_file`, file-scoped `grep_search` and the other read tools) of any existing file with `nlink > 1`, including descendants of directory grants: a hard link can also expose a file that `scope.deny` protects. The battery plants a hard link to a file outside the worktree and checks, in a write task and in a read-only task, that both are denied and the outside file is unchanged.

Case handling goes in the fail-closed direction only. Existing components already get their on-disk case from `realpathSync.native`. Not-yet-existing components must match a write grant with the **exact spelling** (NTFS can make a directory case-sensitive, where `a.txt` and `A.txt` are distinct files, so folding case could authorize a target nobody granted). Comparisons against protected names (`.agents`, `.git`, `.duo`) and `scope.deny` are **case-insensitive** on `win32`, so case can only add denials. The Windows battery probes this in a case-sensitive directory (`fsutil file setCaseSensitiveInfo <dir> enable`) when the PC allows it, not only with `path.win32`. Junctions are followed like symlinks (Node reports them through `lstat().isSymbolicLink()`; the unit tests must prove it on the Windows run). Each rule gets unit tests that run on any OS by injecting `path.win32` and a fake filesystem *(builder's call on the injection shape)*.

### Hook command line

`writeGateFiles` builds `DUO_GATE_ALLOWLIST='…' DUO_GATE_LOG='…' 'node' 'hook.js'`, which only a POSIX shell understands. On `win32`, pass the allowlist and log paths as **arguments** to the hook script instead of env vars, quoted for whatever shell F3 finds, and make `gemini-gate-hook.ts` accept either form (env on macOS stays as is). Paths with characters that the Windows shell would interpret (`%`, `^`, `&`, `"`, `!`) are refused at preparation time rather than escaped *(builder's call: refusing is fail-closed and simpler than proving escaping right)*.

### Private HOME and login on Windows

**One private-environment builder for every `agy` launch.** Creating the private profile does not change any child's environment. Today `discoverGemini()` (catalog, `duo models --refresh`, routing) and `geminiLoginProbe()` (doctor, preflight) launch `agy models` with only `HOME` overridden. A single function builds the child env for every `agy` launch (delegate, preflight, catalog discovery, doctor) from the private profile, setting every variable F4/F5 show `agy` reads. On `win32` it also sets `TEMP` and `TMP` (Windows ignores `TMPDIR`) to the private attempt directory, and the battery checks their effective values in a native child. The battery verifies isolation through `duo models --refresh` and `duo doctor` as well as through delegation. Windows env names are case-insensitive, but `childEnv()` (`src/permissions/auth.ts`) filters names case-sensitively, so a differently cased billing or brain-session variable could survive into the child. On `win32` the builder removes protected names and replaces profile variables **case-insensitively**, with mixed-case inputs covered by a test. The same gap may affect Codex and Claude children on Windows today; the fix lives in `childEnv()` so all executors get it.

`geminiStateRoot` on `win32`: `%LOCALAPPDATA%\duo\gemini-state`. `createPrivateHome` on `win32` creates the private profile dirs that F4/F5 show `agy` uses (expected: `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` pointing inside it), pre-seeds `.gemini/config/config.json` with `plugins.swarm.enabled=false`, and does **not** create the macOS `Library/Keychains` link. Whatever F4 shows is needed to keep the login (for example, Credential Manager needs nothing) is the only exception, and it must not give `agy` write access to the real profile. The preflight in `gemini-auth.ts` gets the Windows equivalent of `authMethod=consumer` + `effective: keyring` from F4; anything else (API key, ADC, enterprise) stays refused. File modes (`0o700`/`0o600`) are no-ops on Windows; the private state lives under the owner's own `%LOCALAPPDATA%`, which is per-user by default *(builder's call: no ACL changes)*.

### Post-run detection (Windows only)

Before and after each Gemini attempt on `win32`, the bridge records:

1. the main checkout: `HEAD`, `git --no-optional-locks status --porcelain=v1 -z --untracked-files=all` (every snapshot Git call runs with `--no-optional-locks`, so the observer never takes `index.lock` from a concurrent stage, commit or `duo apply`), a content hash of every modified and untracked file (status codes alone miss a second write to an already-dirty file), and the index blob ID and mode of every dirty path (`git ls-files -s`; a staged change can keep the `MM` status and the working-file hash);
2. every sibling task worktree under `.duo/worktrees/*` (gitignored in the main checkout, one `..\` away from the Gemini worktree), the same way;
3. a manifest of each real config root F5 identifies (at least `%USERPROFILE%\.gemini`); a missing root (`ENOENT`) is recorded as an absent baseline, distinct from an access error, so a root that appears during the attempt is detected and an installation without `.gemini` is not inconclusive by default. The manifest of each root (type, size, mtime; no content hashing per task) *(builder's call: the full hash manifest stays in the battery's G5; per task, mtime/size is cheap enough)*.

Not covered: Git-clean byte changes that filters normalize away (for example CRLF↔LF under `core.autocrlf=true`: `git status` stays clean, so the file is in neither hash set), gitignored files in the main checkout (`.env`, `node_modules`, `dist`), files inside submodules (top-level status shows only the submodule path), tracked files flagged `assume-unchanged` or `skip-worktree` (`git status` omits them; the snapshot lists them from the index flags and the report says their contents were not checked), and anywhere else on disk.

**Unreadable snapshots.** A snapshot can fail without a crash: a file locked by another Windows process without read sharing, or a failing `git` call. Today `hashPath()` in `src/git.ts` returns the same `null` for an unreadable file as for a missing one, and `dirtyPaths()` returns an empty list when Git fails, so two failed observations would compare equal. The snapshot records read and Git errors distinctly, and any error in either snapshot yields `post-run check incomplete` instead of a clean result. This is detection, not containment, as the owner accepted.

**Attribution.** Other writers are legitimate during the window: the brain, the owner's editor, an in-place Codex/Claude task, a `duo apply` of another task, other Gemini tasks, the owner's own Antigravity use. Nothing is excluded: a path changed by a `duo apply` during the window can also have been changed again by another writer, and the apply record has no resulting file hashes to tell them apart. Paths an apply touched in the window are reported with a note naming that apply, never dropped. No difference can be attributed to Gemini with certainty.

**What a detection does** — owner decision (2026-11-23: "Só avisa"): report it as `checkout drift during the Gemini attempt (<paths>)` on the task result and in `duo doctor`, keep the task's patch unapplied until the brain reviews it, and do not fail the task, quarantine Gemini or revert anything. Failing on every difference would make Gemini on Windows unusable whenever anything else edits the project.

**Interrupted checks.** The bridge persists a pending-check marker (with the "before" snapshot) before launching `agy`. If cancellation (`cancelRun()` force-kills the Windows bridge after its grace period) or a crash stops the bridge before the comparison is recorded, cancellation or recovery finishes the comparison from the marker, or reports `post-run check incomplete` on the task. A dead bridge does not mean `agy` stopped (`refreshInterrupted()` records surviving executors; `cancelRun()` keeps the child PID when termination fails): the comparison is recorded as complete only after the executor's termination is confirmed; until then the marker stays and the task shows `post-run check incomplete`. The battery covers this path separately from native resume after a timeout.

On macOS nothing changes.

### Kill and cancel

Reuse the existing Windows path (`run.cancelled` check, no `SIGTERM` handling). The `firstSignal: "SIGTERM"` field becomes platform-aware if the existing Windows code needs it *(builder's call)*.

### Battery on Windows

`tests/e2e/gemini-e2e.mjs` gets a `win32` mode: the G-scenarios that test the gate (allowed target, denied neighbour, denied descendant, outside the worktree, directory grant, parallel, native resume, read-only review, Gemini + Codex patches, isolation of the real `.gemini`), the Windows path tricks from the hardening section as live probes (each must be denied and must not create the file), the tools that must stay denied (`run_command`, web, subagent, `schedule`, `run_workflow`, swarm, MCP, and the browser probe `P-browser`), isolation through `duo models --refresh` and `duo doctor`, and the post-run detection firing on a planted write to an already-dirty file in the main checkout and in a sibling worktree. The `sandbox-exec` probes are skipped on `win32`. The battery loads its built modules with `import(join(ROOT, ...))`, which Node's ESM loader rejects for a drive-letter path; the Windows port converts those imports to `pathToFileURL(...)`, and a dry run on the target PC checks that the entry point loads before any quota is spent. The battery prints a JSON summary and writes sanitized evidence under `docs/evidencias/`.

On Windows a missing file does not prove the hook worked: the OS can refuse an invalid path even after the hook returned `allow`. Each path probe passes only with a matching hook denial for that attempted path in the gate log. The gate log gains one attempt-scoped correlation field, `pathDigest` = SHA-256 of the raw path argument salted with a per-attempt nonce, computed the same way by the hook and the battery (no path, content or other argument is logged); if the client rejects the path before invoking the hook, the probe is inconclusive, not passed. (The macOS G1 accepts a hook or an OS denial; the Windows port must not.) The battery also traces `duo recommend` (or an adaptive delegation) with the candidate version eligible in the test harness, because `liveAvailability()` in `router.ts` launches its own `agy --version`, and checks that this child uses the private profile.

Because the hook is the only preventive lock on Windows, the battery also re-proves, on the exact `agy` build being approved, that a hook crash, malformed hook output and a hook timeout each block the tool call.

**Pass bar:** every scenario passes. The macOS waiver for an inconclusive browser probe covers `1.5.14/darwin` only; any inconclusive result on Windows needs the owner's explicit waiver for that probe, version and platform. Then `{ version: X, platform: "win32" }` goes into `GEMINI_VERIFIED`.

The owner's standing authorization ("every Gemini update may run the test alone") covers running the battery on each new `agy` version on Windows too.

### Docs

README (EN, then PT), CHANGELOG, `SECURITY.md` (both language sections today describe two independent write-containment layers with no platform qualification), `docs/gemini-agy-facts-windows.md`, and the release notes state plainly that the hook is the only preventive layer on Windows and the post-run check only warns: on Windows, Gemini has one lock (the gate hook) plus post-run detection of the main checkout and the real `.gemini`; macOS keeps two locks.

## Left to the builder

Module layout for the platform branches, test injection shape, exact quoting once F3 is known, version number (proposal: ship as 0.6.0, separate from the 0.5.1 fixes) and the order of commits.

## Risks

- `agy` has no Windows build, or the hook does not fire there (Phase 0 stops the work).
- Path-semantics gaps not on the list above. Mitigation: the adversarial review is asked specifically for Windows path bypasses of the gate.
- The post-run detection misses writes to any other place. Accepted by the owner.
- The 0.5.1 fixes from the Gemini session are not committed yet (latest is `f6da48d`). If they land before or during this work and touch `gemini-gate.ts` or `gemini.ts`, rebase this branch on them.

---

## Resumo (PT)

Gemini como executor no Windows, com **uma trava** (o hook do duo, decisão do Vitor em 23/11/2026) e uma **conferência depois** de cada tarefa (checkout principal e o `.gemini` real). O macOS continua com duas travas. Antes de qualquer código, um teste no PC Windows responde F1–F7: se o `agy` existe lá, se o hook dispara e falha fechado, onde fica o login e se ele sobrevive a um perfil privado. O centro do trabalho é endurecer o hook para os caminhos do Windows (fluxos `:`, ponto ou espaço no fim, `CON`/`NUL`, `\\?\`, nomes curtos `~1`, maiúsculas e minúsculas). A versão do `agy` só é liberada no Windows depois que a bateria passar no seu PC.
