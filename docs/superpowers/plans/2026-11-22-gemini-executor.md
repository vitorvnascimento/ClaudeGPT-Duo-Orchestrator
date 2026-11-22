# Gemini Executor (Antigravity CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `executor: "gemini"` (Antigravity CLI `agy`, subscription only) as a third duo executor, contained by `agy` session rules plus a macOS `sandbox-exec` profile, opt-in and behaving like Codex once enabled.

**Architecture:** A new `GeminiAdapter` (plan + stream parser) beside `ClaudeAdapter`/`CodexAdapter`, fed by three focused helpers (target resolution + session settings, SBPL profile, private native state). `Provider` splits into executor and brain types; the two hard-coded "other provider" sites in `delegate.ts` become one ordered alternates function. Every Gemini precondition is a gate before invocation, so no quota is spent on a run the duo would refuse.

**Tech Stack:** Node ≥ the repo's current floor, TypeScript, `node:test`, no runtime dependencies. macOS `sandbox-exec`. `agy` 1.5.3+.

**Spec:** `docs/superpowers/specs/2026-11-22-gemini-executor-design.md` (read it first; this plan does not repeat its rationale).

## Amendment A (after Task 0, owner-approved) — read before any task

Spec Amendment A supersedes. Concrete task changes:
- **Task 3** becomes the **gate**: `src/adapters/gemini-gate.ts` with `resolveGeminiTargets(...)` (unchanged), `gateAllowlist(targets, worktreeRoot, write): GateAllowlist`, `writeGateFiles(worktreeRoot, privateHome, allowlist): { hooksJson: string; gateScript: string }` and the gate script `dist/gemini-gate.mjs` (decision function `decideToolCall(input, allowlist): { decision: "allow" | "deny"; reason: string }`, unit-tested directly; script = thin stdin/stdout wrapper, logs `{tool, path, decision, modelName}` to the private HOME). Session settings shrink to the guard JSON in Amendment A. Tests: allow only exact targets; deny sibling, `.agents/`, every non-file tool name in the fixtures, reads outside the worktree; malformed input → deny.
- **Task 4**: `buildProfile` gains `privateHome`; probe unchanged.
- **Task 5** becomes **private HOME**: `createPrivateHome(chainDir): { home, tmpDir }` (0700, `Library/Keychains` symlink, seeded `config.json` with swarm off), plus the lifecycle functions already listed (the "state dir" is this HOME).
- **Task 6**: env `HOME=<private home>`, `TMPDIR`; argv per stdin-form; settings = guard JSON; worktree required for every kind.
- **Task 7**: `reportedModel` from the gate log's `modelName` (Amendment A).
- **Task 9**: `geminiAuthPreflight(home, profile): { ok: true } | { ok: false; reason }` parsing the fresh log for `authMethod=consumer` + `effective: keyring`; never store the line.
- **Task 10**: Gemini allowed only on `darwin`; every kind forced to worktree; preflight before every invocation.
- **Task 14**: G-scenarios replay `tests/fixtures/agy/probe/README.md` through the real adapter, plus coverage probes for `schedule`, `run_workflow`, `swarm`, MCP and browser (each must end denied by the gate or unavailable; `schedule` checked for no created automation).
- Rulings in the ledger record any further deviation.

## Global Constraints

- No runtime dependencies. No API-key billing path. Never pass `--dangerously-skip-permissions`, `--remote-agent`, `--remote-control`, `--add-dir`, `--new-project` to `agy`.
- Gemini is disabled by default: `executors.gemini.enabled: false`, `command: null` (default binary `agy`). An override must be exactly one absolute path.
- Billing acknowledgment: `billing.acknowledgeUnverifiableExtraUsage.gemini` (same key as Claude/Codex). Opt-in is by editing `.duo/config.json`; no `duo init` flag.
- Containment behaviour is bound to verified `agy` versions: `GEMINI_VERIFIED: readonly { version: string; platform: NodeJS.Platform }[] = []` — starts **empty** (1.5.3 failed Task 0); only an exact version+platform pair that passed every Task 0 check is added. Anything else is refused, even if its `--help` lists the same flags.
- Only model ids matching `^gemini-` are ever invoked. Effort is the id suffix `-low|-medium|-high|-xhigh`.
- Prompt goes over stdin only; never in argv, never in `invocation.json`.
- Native `agy` state and per-attempt `TMPDIR` live outside `.duo/`, in a 0700 per-chain dir.
- macOS: OS probe must pass for every Gemini kind. Non-macOS: read kinds only (`review`, `investigate`), write kinds refused at routing/delegation, not at config load.
- Gemini write kinds always run with `isolation: worktree`.
- Code messages in Portuguese; repo docs bilingual (English first, Portuguese below).
- Validation outside the Codex sandbox: `npm test` and `npm run typecheck` must pass; release gate 100/100 (`tests/e2e/real-e2e.mjs` + `tests/e2e/quality-test.mjs`).
- Commits only on the `feature/gemini-executor` branch; no push/merge/tag without the owner's permission.

## Review Focus

1. **`agy` upgrade changes a flag, JSON shape or merge semantics** → adapter refuses any version/platform outside `GEMINI_VERIFIED`, not run degraded. Tests in Task 6 (`refuses agy without stdin stream-json flag`, `refuses unverified agy version with identical help`).
2. **Task scope with a glob or directory that contains a denied file** → refused before invocation when `agy` cannot express deny. Test in Task 3 (`refuses dir scope overlapping deny without client deny rule`).
3. **Path with spaces, quotes, parentheses or newline** (the owner's projects live under `VS Code/`) → profile still confines exactly that path. Test in Task 4 (`escapes hostile paths`).
4. **Crash or SIGKILL mid-run** → private TMPDIR and lock cleaned; state dir kept only if resumable. Test in Task 5 (`cleans attempt tmp on interruption`).
5. **Owner's own `agy` interactive session running at the same time** → executor never writes the owner's `~/.gemini`. Test in Task 14 (case e).

---

### Task 0: Pin `agy` facts (investigation, no product code)

**Files:**
- Create: `docs/gemini-agy-facts.md` (EN/PT), `tests/fixtures/agy/*.ndjson` (recorded, redacted stream-json transcripts)

**Interfaces:**
- Produces: the facts every later task cites by section name: `stdin-form`, `settings-merge`, `rule-syntax`, `deny-rules`, `state-relocation`, `extensions-off`, `auth-signal`, `served-model`, `stream-events`, `state-paths`.

- [ ] **Step 1:** In a throwaway repo under the scratchpad, determine each fact with real `agy` (cheap model `gemini-3.8-flash-low`), recording the exact command and output: (a) exact stdin form (`-p` + `--input-format stream-json` NDJSON message shape); (b) does `--settings` replace or merge `permissions.allow`; (c) `write_file(<path>)` syntax for a file and a directory, and whether a `deny` list exists; (d) env var/flag/setting that relocates conversations/logs/cache/daemon state, and which paths `agy` writes under `sandbox-exec` (log denials); (e) how to disable user MCP servers, plugins, skills, instructions for one session; (f) a non-secret auth signal distinguishing Google-account login from API key (or proof this version has no API-key path); (g) whether any stream-json event names the model that answered; (h) the event types of a run with an edit, a denied edit, a quota/auth error.
- [ ] **Step 2:** Write `docs/gemini-agy-facts.md` with one section per fact (names above), each: command, observed output (redacted), conclusion.
- [ ] **Step 3: Gate.** Leaving Task 0 requires **positive** evidence (unproven counts as negative) for: `stdin-form`; `settings-merge` (owner's allowlist replaced); `rule-syntax` (session rules alone: an authorized write succeeds **and** a new sibling write is denied — prerequisite for any write kind); `state-relocation`; `extensions-off`; `auth-signal`; and `plan-mode` (a real read succeeds and an attempted in-workspace write is denied with `--mode plan` and no OS layer — prerequisite for non-macOS reads). If any is not positive, STOP and report to the owner (spec says Gemini is blocked without them). If `served-model` is negative, continue (spec: Gemini only in non-adaptive pinned requests) and note it at the top.
- [ ] **Step 4: Commit** `docs(gemini): fatos verificados do agy 1.5.3`.

### Task 1: Provider types, config and env

**Files:**
- Modify: `src/config.ts` (types, `DEFAULT_CONFIG`, validation), `schemas/delegation-request.schema.json` (`executor` enum only gains `"gemini"`; `brain` unchanged), `src/state/types.ts`, `src/permissions/auth.ts:15-31` (strip list), `src/adapters/cli-latest.ts:10`, `src/cli/doctor.ts:80-139`, `src/adapters/catalog.ts:66-69`, `src/adapters/sanitize.ts`, `src/cli/main.ts:108`
- Test: `tests/config-limits.test.ts`, `tests/unit.test.ts`

**Interfaces:**
- Produces (buildable on its own: `ADAPTERS.gemini` is an `UnavailableAdapter` whose `plan()` throws `"executor gemini ainda não disponível nesta versão"` until Task 10 registers the real one): `type ExecutorProvider = "claude" | "codex" | "gemini"`, `type BrainProvider = "claude" | "codex"`, `const EXECUTORS: readonly ExecutorProvider[]`, `function assertNever(x: never): never` (in `src/config.ts`); `cfg.executors.gemini: ExecutorConfig & { enabled: boolean }`; `cfg.billing.acknowledgeUnverifiableExtraUsage.gemini: boolean`.

- [ ] **Step 1: Failing tests:** `gemini disabled by default` (`DEFAULT_CONFIG.executors.gemini.enabled === false`, `.command === null`); `gemini command override must be one absolute path` (`["/usr/local/bin/agy","--dangerously-skip-permissions"]` → config error mentioning `executors.gemini.command`); `childEnv strips Google credentials` (removed ⊇ `GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION`); `config with gemini enabled loads on win32` (no platform rejection at load); `readRequest accepts executor gemini and rejects brain gemini` (through the request loader, not only types); `delegating to gemini before Task 10 blocks with the unavailable message`.
- [ ] **Step 2:** Run `npm test` — those 4 fail.
- [ ] **Step 3:** Split the type: `Provider` stays as alias of `ExecutorProvider` for executor sites; `defaultBrain`, `brain` fields, `init.ts` and skills use `BrainProvider`. Every `Record<Provider, …>` gains `gemini`; every switch/ternary over providers becomes exhaustive with `assertNever`. `cliLatest` package for gemini is `null` (not on npm; `fetchCliLatest` returns null).
- [ ] **Step 4:** `npm run typecheck` clean; `npm test` all pass.
- [ ] **Step 5: Commit** `feat(gemini): tipos de provedor, config e env`.

### Task 2: Executable and argv guard

**Files:**
- Create: `src/adapters/gemini-argv.ts`
- Test: `tests/gemini-argv.test.ts`

**Interfaces:**
- Produces (canonical prompt flag is the exact token `-p=` — verified: `-p` followed by another flag consumes that flag as the prompt): `validateGeminiArgv(args: readonly string[]): string | null` (null = ok, else reason in Portuguese); `GEMINI_ALLOWED_FLAGS: ReadonlySet<string>` = `-p, --input-format, --output-format, --model, --mode, --sandbox, --disable-slash-commands, --settings, --conversation, --json-schema` plus any value-taking flags Task 0 adds.

- [ ] **Step 1: Failing tests:** `rejects dangerously-skip-permissions anywhere`; `rejects remote-agent, remote-control, add-dir, new-project, agent, effort-less unknown flags`; `rejects --mode other than accept-edits|plan`; `accepts the adapter's canonical argv` (asserts it contains the token `-p=` and no other `-p`/`--print` form); `rejects -p followed by a separate value`.
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement as allowlist over flags (value-taking flags consume the next element).
- [ ] **Step 4:** Run — pass.
- [ ] **Step 5: Commit** `feat(gemini): validação do argv do agy`.

### Task 3: Target resolution and session settings

**Files:**
- Create: `src/adapters/gemini-scope.ts`
- Test: `tests/gemini-scope.test.ts`

**Interfaces:**
- Consumes: `validateScope()` output (writable entries), `denyGlobs`, worktree root, `cfg.limits.worktreeLinks`.
- Produces: `type GeminiTarget = { abs: string; isDir: boolean; missingAncestors: string[] }`; `resolveGeminiTargets(worktreeRoot: string, writable: { abs: string; isDir: boolean }[], denyGlobs: string[], links: string[], clientDeny: boolean): { ok: true; targets: GeminiTarget[] } | { ok: false; reason: string }`; `geminiSessionSettings(targets: GeminiTarget[], denyGlobs: string[], write: boolean): Record<string, unknown>` (shape from `docs/gemini-agy-facts.md#rule-syntax`; always `allowNonWorkspaceAccess:false`, no `command(...)` rules, and whatever `#settings-merge` says is needed to replace the inherited allowlist).

- [ ] **Step 1: Failing tests:** `new file in existing dir resolves via nearest ancestor and grants literal path`; `new file with missing parent lists missingAncestors inside worktree`; `target through node_modules link is refused` (link to project dir → `ok:false`); `target outside worktree after realpath is refused`; `refuses dir scope overlapping deny without client deny rule` (`clientDeny:false`); `with client deny, settings carry deny rules`; `settings never contain command rules`; `inherited owner allowlist is neutralized` (fake agy that merges settings like the real one per `#settings-merge`: effective allowlist empty, else preflight refuses); `read kinds get no write rules`.
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement; realpath of nearest existing ancestor + exact suffix; reject if any component resolves outside `realpath(worktreeRoot)`.
- [ ] **Step 4:** Run — pass.
- [ ] **Step 5: Commit** `feat(gemini): alvos de escrita e regras de sessão`.

### Task 4: SBPL profile and local probe

**Files:**
- Create: `src/adapters/sandbox-profile.ts`
- Test: `tests/sandbox-profile.test.ts` (probe tests skip when `process.platform !== "darwin"`)

**Interfaces:**
- Produces: `sbplQuote(path: string): string`; `globToSbplRegex(worktreeRoot: string, glob: string): string | null` (null = not representable); `buildProfile(p: { worktreeRoot: string; targets: GeminiTarget[]; denyGlobs: string[]; stateDir: string; tmpDir: string }): { ok: true; profile: string } | { ok: false; reason: string }` (`(version 1)(allow default)(deny file-write*)` + allows: targets as `literal`/`subpath`, stateDir, tmpDir, `/dev/null`, `/dev/tty`, `/dev/fd/` regex; then `(deny file-write* (regex …))` per deny glob, so files that do not exist yet are covered; a directory grant with an unrepresentable deny glob → `ok:false`); `probeSandbox(): { ok: true } | { ok: false; reason: string }` — runs `/bin/sh -c` under a generated profile in a temp dir: allowed write succeeds, sibling and `../` fail; no `agy`, no network.

- [ ] **Step 1: Failing tests:** `profile allows only listed paths` (string assertions); `escapes hostile paths` (path with `"`, `(`, `)`, `\`, newline, spaces → profile parses: `sandbox-exec -f` runs `true`; and sibling write still denied); `canonicalizes /tmp to /private/tmp`; `denies a previously nonexistent file matching **/*.key under a granted dir` (OS layer alone); `unrepresentable deny glob refuses the dir grant`; `probe passes on darwin`; `probe reports missing sandbox-exec` (PATH without it → `ok:false`).
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — pass.
- [ ] **Step 5: Commit** `feat(gemini): perfil sandbox-exec e sonda local`.

### Task 5: Private native state lifecycle

**Files:**
- Create: `src/state/gemini-state.ts`
- Modify: `src/cli/main.ts` (subcommand `gemini-state prune [--older-than <days>]`)
- Test: `tests/gemini-state.test.ts`

**Interfaces:**
- Produces: `geminiStateRoot(env): string` (darwin: `~/Library/Application Support/duo/gemini-state`; else `${XDG_STATE_HOME:-~/.local/state}/duo/gemini-state`); `chainStateDir(projectRoot: string, chainId: string, env): string` (0700, `<sha256(projectRoot)[0..12]>/<chainId>`, plus `owner.json` with projectRoot and chainId only); `attemptTmpDir(stateDir: string): { path: string; cleanup(): void }` (dir name carries the bridge pid; `attempt.json` records the executor child pid once spawned); `sweepStaleAttempts(stateDir: string): string[]` (removes an attempt dir only when **both** the bridge pid and the recorded executor child pid are dead — the executor runs detached and can outlive a killed bridge; called on startup and resume); `removeChainState(dir: string): void`; `listGeminiStates(env): { dir: string; projectRoot: string; chainId: string; mtimeMs: number }[]`; `chainStateClass(projectRoot: string, chainId: string): "active" | "resumable" | "terminal" | "orphan"` (active = live owner per `chainPolicy()`/slot lock; orphan = project or `.duo/` gone or chain unknown); `pruneGeminiStates(opts: { olderThanDays?: number }, env): string[]` — deletes terminal and orphan; deletes resumable only with `--older-than`; **never** active; re-checks the class under the chain's lock immediately before each deletion; a chain whose recorded executor child pid is alive counts as **active** even if the bridge owner died.

- [ ] **Step 1: Failing tests:** `state dir is 0700 and outside project`; `cleans attempt tmp on interruption` (cleanup registered on SIGINT/SIGTERM/exit); `stale attempt dirs swept on startup and resume after SIGKILL` (spawn a child bridge, `SIGKILL` it, then start/resume: its attempt tmp is gone, the resumable conversation state stays); `attempt dir kept while the detached executor child survives the bridge` (bridge killed, fake agy still running → not swept; swept after it exits); `prune removes dirs whose project or .duo no longer exists`; `prune keeps resumable chains unless older-than`; `prune never deletes an active chain, even with --older-than 0` (live owner holds the lock during prune); `class rechecked under lock (chain becomes active between listing and deletion → kept)`; `prune --older-than 0 keeps a chain whose bridge was killed while its detached executor child still runs`; `owner.json holds no prompt text`.
- [ ] **Step 2:** Run — fail. **Step 3:** Implement. **Step 4:** Run — pass.
- [ ] **Step 5: Commit** `feat(gemini): estado nativo privado por cadeia`.

### Task 6: `GeminiAdapter.plan()` and capabilities

**Files:**
- Create: `src/adapters/gemini.ts`; Modify: `src/adapters/capabilities.ts` (add `AGY_FLAGS`)
- Test: `tests/gemini-adapter.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5; `InvocationInput` (`src/adapters/types.ts`).
- Produces: `GEMINI_VERIFIED` (see Global Constraints); `class GeminiAdapter implements ExecutorAdapter` (`provider = "gemini"`); `InvocationInput` gains optional `gemini?: { targets: GeminiTarget[]; stateDir: string; tmpDir: string; settingsPath: string; profilePath: string | null }` filled by delegation (Task 10).

- [ ] **Step 1: Failing tests:** `plan wraps agy in sandbox-exec on darwin`; `prompt is absent from argv and stdin carries one NDJSON message`; `write kind uses accept-edits, read kind uses plan`; `resume adds --conversation`; `env has TMPDIR in private tmp and no Google keys`; `argv passes validateGeminiArgv`; `refuses agy without stdin stream-json flag` (capabilities from help text missing `--input-format` → throws Portuguese error); `refuses unverified agy version with identical help` (version 1.6.0, and 1.5.3 itself, → refused, message tells to re-verify); `enforced lists both layers`.
- [ ] **Step 2:** Run — fail. **Step 3:** Implement (settings and profile written to the private state dir, not `.duo/`). **Step 4:** Run — pass.
- [ ] **Step 5: Commit** `feat(gemini): adaptador agy (plan)`.

### Task 7: Stream parser and fake `agy`

**Files:**
- Modify: `src/adapters/gemini.ts` (`parser()`), `src/adapters/types.ts` (`StreamParser.finish(lastMessage: string | null, stderrTail?: string): ParsedOutcome`; `ErrorKind` gains `"permission_denied"`), `src/orchestration/delegate.ts` (`execute()` passes the bounded `stderrTail` to `finish`; `decide()` maps `permission_denied` to a user-visible message listing the denied actions)
- Create: `tests/fixtures/fake-agy.mjs` (replays the recorded native transcripts in `tests/fixtures/agy/*.ndjson`; scenarios not yet captured from the real CLI — quota, auth — are marked `pending-capture` in the fixture name and must be replaced by real recordings before release, honours `FAKE_AGY_SCENARIO`, logs argv/stdin like `fake-codex.mjs`)
- Test: `tests/gemini-adapter.test.ts`

**Interfaces:**
- Produces: `ParsedOutcome` per `src/adapters/types.ts`: `sessionId` from `conversation_id`; `reportedModel` only from the `served-model` event (else `null`); `permissionDenials` = distinct denied actions from **both** `result.denied_actions` and tool steps with `state:"ERROR"` whose error is a permission failure (`permission check failed` / `Matches user-configured deny rule`), deduplicated by action+path; `errorKind` via `classifyErrorText` over `result.error` + response + `stderrTail`, with `result.error` preserved as `errorMessage` even when the kind is `unknown` (+ agy messages from facts), or `"permission_denied"` when the run ended on a denied tool with no report; `durationMs`, `numTurns`, `usage`.

- [ ] **Step 1: Failing tests:** `plain-response.ndjson → invalid report (not an ExecutorReport)`; `schema-valid report capture` (**pending-capture**: record a real run with `--json-schema` before this test is enabled); `deny-wins-over-allow.ndjson → 4 denials although result has no denied_actions`; `write-and-denied-command.ndjson → 1 denial (deduplicated)`; `missing-event-field.ndjson → errorMessage is the result.error text`; `denied fixture with empty response → errorKind permission_denied and the final task summary (via delegate with fake agy) names the denied action`; `quota only on stderr with empty stdout → quota and triggers fallback`; `quota fixture → quota`; `auth fixture → auth`; `malformed line counted`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(gemini): parser do stream do agy e agy falso`.

### Task 8: Catalog discovery

**Files:**
- Modify: `src/adapters/catalog.ts` (`discoverGemini`, `SourceKind` adds `"agy-models"`), `src/adapters/tiers.ts` (default tier patterns for gemini ids)
- Test: `tests/catalog.test.ts`, `tests/tiers.test.ts`

**Interfaces:**
- Produces: `parseAgyModels(text: string): ModelInfo[]` — keeps `^gemini-` only and keeps **one `ModelInfo` per full id** (exact variant identity, so `findModel()` resolves a pinned full id and `reportedMatchesRequested()` never equates `-low` with `-high`); `geminiVariants(catalog: Catalog, base: string): { id: string; effort: Effort }[]` groups variants for selection/display only; `geminiModelId(base: string, effort: Effort): string | null`.

- [ ] **Step 1: Failing tests:** `drops claude and gpt-oss ids`; `variants grouped for selection but each full id resolvable`; `served -low does not confirm requested -high` (regression); `flash is light, others presumed standard with presumed=true` *(builder's call per spec)*; `stale discovery keeps last known good`.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat(gemini): catálogo via agy models`.

### Task 9: Auth and billing gate

**Files:**
- Modify: `src/permissions/auth.ts` (`checkGeminiAuth`, `authBlockReason`)
- Test: `tests/unit.test.ts` (auth section)

**Interfaces:**
- Produces: `geminiParentEnvProblem(parentEnv: NodeJS.ProcessEnv): string | null` (checks the **parent** env names before `childEnv()` strips them); `checkGeminiAuth(paths: AuthPaths, env, cfg): AuthCheck` using the signal in `docs/gemini-agy-facts.md#auth-signal`; blocked when signal absent/ambiguous, API-key env present, or `billing.acknowledgeUnverifiableExtraUsage.gemini !== true`.

- [ ] **Step 1: Failing tests:** `blocks without acknowledgment`; `blocks when auth signal ambiguous`; `blocks when GEMINI_API_KEY set in parent env` (through `delegate()` with an explicit non-adaptive request, not only the unit); `passes with google login signal and acknowledgment`.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat(gemini): verificação de login e cobrança`.

### Task 10: Delegation gates and lifecycle

**Files:**
- Modify: `src/orchestration/prompt.ts` (`buildExecutorPrompt` gemini variant: no shell, file tools only, acceptance left to the bridge), `src/orchestration/delegate.ts` (`ADAPTERS` at :41 replaces the `UnavailableAdapter`, `runGates` at :159, invocation path near :799, model confirmation near :820), `src/orchestration/control.ts` (`acceptTask` :133, apply/reject → state cleanup)
- Test: `tests/delegate.test.ts` (new `describe("gemini")`)

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces: `geminiPreflight(task: Task, req: DelegationRequest, cfg: DuoConfig, catalog: Catalog | null, adaptive: boolean, platform: NodeJS.Platform): { ok: true } | { ok: false; reason: string }` (in `src/orchestration/gemini-gates.ts`), called in `runGates` and again right before every invocation (resume, retries).

- [ ] **Step 1: Failing tests (fake agy):** `disabled gemini is refused`; `write kind on linux refused`; `review on unverified linux/win32 refused`; `review runs only with an injected verified platform/version pair`; `darwin probe failure refuses review too`; `model outside ^gemini- refused even with stale catalog`; `pinned incompatible effort blocked before invocation (fake agy never called)`; `adaptive run without served-model evidence refused before invocation (pinned -low light task)`; `write kind forced to worktree and missing ancestors created in worktree only`; `executable extension not disabled → refused`; `state dir removed after accept of successful review and after apply`; `invocation.json has no prompt text`; `automatic choice with no variant at the floor picks another eligible model or blocks`; `non-adaptive request with explicit gemini id runs without served-model evidence`; `passive user instructions that cannot be disabled appear in task.limitations`; `gemini prompt has no cat/shell permission and no acceptance-run invitation`.
- [ ] **Step 2–4:** fail → implement → pass (`npm test` full).
- [ ] **Step 5: Commit** `feat(gemini): portões de delegação e ciclo de vida`.

### Task 11: Ordered alternates across three accounts

**Files:**
- Modify: `src/orchestration/delegate.ts:451` and `:606` (replace both hard-coded ternaries)
- Create: `src/orchestration/alternates.ts`
- Test: `tests/codex-fallback.test.ts`, `tests/delegate.test.ts`

**Interfaces:**
- Produces: `executorEligible(p: ExecutorProvider, ctx: { kind: TaskKind; fixedIsolation: Isolation | null; cfg: DuoConfig; platform: NodeJS.Platform; adaptive: boolean; servedModelEvidence: Record<ExecutorProvider, boolean> }): boolean` (shared by fallback and initial routing); `alternateProviders(input: { current: ExecutorProvider; kind: TaskKind; fixedIsolation: Isolation | null; cfg: DuoConfig; platform: NodeJS.Platform; servedModelEvidence: Record<ExecutorProvider, boolean>; score(p: ExecutorProvider): number }): ExecutorProvider[]` — first **filters** out current, disabled, platform-unsupported, gemini for write kinds with `fixedIsolation === "in-place"`, and any account that would fail its adaptive eligibility gate (e.g. gemini without served-model evidence in an adaptive chain); then orders by `score` desc, tie → `claude < codex < gemini`.

- [ ] **Step 1: Failing tests:** `same-account equivalent model still tried first` (existing test keeps passing unchanged); `gemini disabled → behaviour identical to v0.4.0`; `codex exhausted, gemini enabled → gemini chosen when best score`; `in-place write chain never falls to gemini`; `in-place review chain may fall to gemini`; `tie order is claude, codex, gemini`; `codex exhausted, gemini scores higher than claude but has no served-model evidence in adaptive chain → claude chosen` (unequal scores).
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat(gemini): alternativas ordenadas entre três contas`.

### Task 12: Router, quota, capacity, status and doctor

**Files:**
- Modify: `src/orchestration/router.ts`, `quota.ts`, `capacity.ts`, `src/telemetry/report.ts`, `src/cli/doctor.ts`, `src/cli/main.ts` (`status`)
- Test: `tests/router.test.ts`, `tests/quota.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Produces: router candidates (`recommendResult()`) filtered by `executorEligible()` from Task 11 **before ranking**, same as fallback; telemetry sample field `modelObserved: boolean`; `duo doctor` gemini section = binary, version, capabilities, `probeSandbox()`, auth check (no inference); `duo doctor --live-gemini` runs the real containment check (Task 14 case a, one model call); `duo status` lists gemini state dirs that are orphaned or resumable.

- [ ] **Step 1: Failing tests:** `doctor never invokes agy -p without --live-gemini` (fake agy log empty); `router ignores gemini when disabled`; `adaptive recommendation never picks gemini without served-model evidence even with a fresh catalog`; `non-adaptive pinned gemini request still accepted`; `quota and capacity record gemini per model`; `telemetry sample marks modelObserved false when reportedModel null`.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat(gemini): roteador, cota, status e doctor`.

### Task 13: Docs and skills

**Files:**
- Modify: `README.md`, `SECURITY.md`, `docs/decisoes.md`, `docs/compatibilidade.md`, `skills/shared/decision-guide.md`, `skills/shared/request-format.md`, `CHANGELOG.md` (Unreleased)
- Test: `tests/unit.test.ts` (existing skill frontmatter test still passes)

- [ ] **Step 1:** Document (EN then PT): enabling Gemini (`enabled`, acknowledgment), macOS-only writes, read-only elsewhere, no tests run by Gemini, worktree-only writes, served-model limitation (from Task 0), private state location and `duo gemini-state prune`, acceptance-commands limitation, `--live-gemini`.
- [ ] **Step 2:** `npm test` passes. **Step 3: Commit** `docs(gemini): uso, limites e segurança`.

### Task 14: Real containment battery and quality criterion

**Files:**
- Modify: `tests/e2e/real-e2e.mjs` (scenarios G1–G9), `tests/e2e-quality-battery.test.ts` (offline fixtures: positive fixture from the full 26-id battery; each negative case derived from that complete valid battery with only the defect under test changed), `tests/e2e/quality-test.mjs` (criterion Q16; rebalance `POINTS` to sum 100; **Q8 expected set becomes the 17 current ids + G1–G9 = 26**, keeping its missing/duplicate/failed checks), `docs/e2e-real.md`

**Interfaces:**
- Produces: G1 both layers (authorized existing + new file written; sibling, denied path, `../outside` refused); G2 OS layer only (permissive settings); G3 session rules only (no profile); G4 any command denied (`git add`, `codex`); G5 owner `~/.gemini` settings and other conversations unchanged (hash before/after); G6 two parallel Gemini tasks cannot touch each other's state; G7 resume in worktree + `duo apply`; G8 real read-only review (settings and profile have no writable roots; an explicit write attempt is denied with evidence); G9 Gemini and Codex in parallel under slot admission, both patches applied in order. Each negative case passes only with **attempt evidence** (stream event of the attempted tool + denial from the layer under test); a skipped attempt marks the scenario `inconclusive` and fails the battery.

- [ ] **Step 1:** Implement scenarios with prompts that enumerate each forbidden operation explicitly.
- [ ] **Step 2:** On macOS, outside the Codex sandbox, with a fresh disposable base `B=$(mktemp -d)`: `node tests/e2e/real-e2e.mjs --base "$B/g" --confirm-quota --only G1,G2,G3,G4,G5,G6,G7,G8,G9`. Expected: 9/9 pass, 0 inconclusive.
- [ ] **Step 3:** Full battery: `node tests/e2e/real-e2e.mjs --base "$B/full" --confirm-quota` (writes its results JSON; note the path it prints), then `node tests/e2e/quality-test.mjs --base "$B/q" --confirm-quota --battery <that results.json>`. Expected: 26/26 scenarios; quality 100/100 (Q8 verifies the battery file).
- [ ] **Step 4: Commit** `test(e2e): bateria real de contenção do Gemini`.

### Task 15: Final validation

- [ ] **Step 1:** `npm run typecheck` → clean; `npm test` → all pass (record count).
- [ ] **Step 2:** `node .claude/orchestration/orch.mjs codex adversarial-review --base origin/develop --cwd .worktrees/duo-gemini "contenção de escrita, cobrança, estado nativo, alternativas entre contas"` (from the workspace root); fix confirmed findings (max 2 rounds).
- [ ] **Step 3:** Record evidence under `docs/evidencias/*-gemini-*.{json,md}`; update the vault note `desenvolvimento/ferramentas-de-ia/Duo Orchestrator.md`.
- [ ] **Step 4:** Report to the owner; release flow (develop → homolog → release → main, tag) only with explicit permission. Pre-release owner tasks: read Antigravity terms; measure AI Pro quota per typical task.
