# Gemini as a third executor (Antigravity CLI) — design

Date: 2026-11-22. Status: draft for the owner's approval. Items marked *(builder's call)* were decided by Claude, not by the owner.

## Amendment A (22/11/2026, after Task 0 — approved by the owner: "Aprovo, siga")

Evidence: `docs/gemini-agy-facts.md` and `tests/fixtures/agy/` (recipe in `tests/fixtures/agy/probe/README.md`). This amendment **supersedes** the sections below wherever they disagree.

- **Client layer = bridge gate hook, not `--settings` rules.** Every Gemini task (reads included) runs in a bridge-controlled disposable worktree. The bridge replaces the worktree's `.agents/` with its own `.agents/hooks.json` declaring one `PreToolUse` hook (`matcher: "*"`) that runs the bridge's gate script. The gate reads a per-attempt allowlist (authorized write targets, readable root = the worktree) from the private HOME, allows only file read tools inside the worktree and `write_file`/`edit_file` on exact authorized targets, and **denies everything else** (commands, web, messages, subagents, schedules, workflows, swarm, MCP, browser). Writes to `.agents/` are denied by both layers and `.agents/` is excluded from the patch. The gate fails closed (crash, invalid output, timeout all deny — verified), and its own log lives in the private HOME.
- `--settings` keeps `{"allowNonWorkspaceAccess": false, "permissions": {"deny": ["command(*)"]}}` as an extra guard only.
- **Private HOME per chain** (replaces "task-private state"): a 0700 dir outside `.duo/` containing `Library/Keychains` → symlink to the real `~/Library/Keychains` (keeps the login; verified), a pre-seeded `.gemini/config/config.json` with `plugins.swarm.enabled=false`, the gate allowlist/log, and the per-attempt `TMPDIR`. `agy` runs with `HOME=<that dir>`; the owner's `~/.gemini` is never read or written (verified: unchanged under the exact profile).
- **OS profile** (exact §5 policy, verified): writes only to authorized targets (literal/subpath), the private HOME, its `TMPDIR`, `/dev/null`, `/dev/tty`, `/dev/fd/*`. Read tasks: no target.
- **Auth preflight (inference-free):** before any model call, run `agy models` under the same HOME/profile with an emptied `log/` dir; require a fresh `authMethod=consumer` and `authenticated via keyring (effective: keyring)`; never persist the line (it holds the email). This proves the login method only; entitlement stays the owner's acknowledgment.
- **Served model:** the gate log records the hook input `modelName` (agy: "the name of the model actually in use"). The adapter uses it as `reportedModel` (native, session-level evidence; a mismatch with the request is treated like today's model mismatch). If absent, `reportedModel` stays null and the earlier rules apply.
- **Platforms:** Gemini is **macOS-only** in this version, all kinds. Non-macOS stays disabled until a real per-platform check, including hook coverage of the unverified tools, passes.
- **Unverified tools** (`schedule`, `run_workflow`, `swarm`, MCP, browser): the real battery must show each denied by the gate or unavailable before release; `schedule` is probed only with the gate in place and the result checked for a created automation.
- **Verified versions:** `GEMINI_VERIFIED` starts empty; `{version: "1.5.3", platform: "darwin"}` is added only when the battery's G-scenarios pass on it.

## Intent

The owner pays for Gemini (Google AI Pro) and wants its new models (Gemini 4 Neon/Argon/Hydrogen, Gemini 3.8 Flash) working inside the duo the same way Codex and Claude do. The goal is more executor capacity and model choice **on subscriptions only**, never a paid API key. Gemini joins as an **executor only**; brains stay Claude or Codex.

The Gemini CLI stopped serving AI Pro users on 18/06/2026. The client is the **Antigravity CLI (`agy`)**, already installed (`~/.local/bin/agy`, 1.5.3) and logged in with the owner's account.

## What the spike proved (22/11/2026, `agy` 1.5.3, macOS)

- Headless: `agy -p "<prompt>" --model <id> --output-format json --mode accept-edits --sandbox` wrote a file and ran a command with no prompt. The JSON carries `conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, `usage` (input/output/thinking/cache_read/total tokens) and, when something was refused, `denied_actions: [{action, display_name}]`.
- Resume: `--conversation <id>` kept the previous turn's context.
- `agy models` lists ids such as `gemini-4-neon-high`, `gemini-4-argon-medium`, `gemini-4-hydrogen-xhigh`, `gemini-3.8-flash-low` (effort is part of the id), plus Claude Opus/Sonnet 5.5 and GPT-OSS 120B served through Google.
- **Danger:** with the owner's normal settings, a request to write `../fora-agy.txt` **succeeded**. Cause: `~/.gemini/antigravity-cli/settings.json` has `allowNonWorkspaceAccess: true` and a broad `permissions.allow` list (includes `command(rm .env .env.local)`, `command(git add)`, `command(kill ...)`). `--sandbox` only restricts the terminal, not file edits.
- **Layer 1 works (client rules):** `--settings '{"allowNonWorkspaceAccess":false,"permissions":{"allow":[]}}'` blocked the outside write and the `git add`. stderr: "a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. write_file(<target>))". `denied_actions` listed it.
- **Layer 2 works (OS):** `sandbox-exec -f <profile>` with `(deny file-write*)` plus allows for the workspace, `~/.gemini`, the temp dir and `/dev/*` let `agy` write inside the workspace; the outside write failed with `operation not permitted`. So file writes happen in the `agy` process, not in a daemon outside the sandbox (to be re-proved by tests, see below).
- `agy` loads the owner's global instructions (it answered with the owner's `[Certo]` marker). `--dangerously-skip-permissions` must never be used (Claude Code's own safety classifier refused it).

## Goals

1. `executor: "gemini"` usable in `duo delegate` for every task kind on macOS, with writes confined to the task's writable roots by **two independent layers**: `agy` session rules and a macOS `sandbox-exec` profile. Either layer alone must block an out-of-scope write.
2. Same verification, reports, budget, slots (up to 4 in parallel), worktree isolation, `duo apply`, quota/capacity tracking and telemetry as the other executors.
3. Executor does not inherit the owner's `agy` config: no broad allowlist, no non-workspace access, no user instructions/skills/MCP/plugins where `agy` allows turning them off.
4. Model catalog from `agy models`, only `gemini-*` ids; the router learns them like the others.
5. Backward compatible: an existing project never routes to Gemini until the owner enables it.

## Non-goals

- Gemini as a brain (no Gemini skill, no `duo init` brain option).
- Using the Claude/GPT-OSS models that `agy` exposes (they would confuse quota and routing). *(builder's call)*
- Gemini write tasks on Windows/Linux in this version (read-only kinds only there, see below).
- API-key mode (AI Studio, Vertex).
- ACP/stream-json integration beyond what the adapter needs.

## Anti-goals (failure even if it "works")

- An executor writing outside its writable roots or inside `scope.deny`.
- The executor running with the owner's allowlist (e.g. `rm .env`) or with `allowNonWorkspaceAccess: true`.
- Any code path that passes `--dangerously-skip-permissions`, or a fallback that silently drops a containment layer.
- A project upgraded to v0.5 sending tasks to Gemini without the owner turning it on.
- Billing through an API key (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, Vertex vars) instead of the subscription.
- Gemini calling another AI (claude, codex, duo, agy) from inside the task.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen by the owner)** | `agy` session rules **plus** macOS `sandbox-exec` | Real OS enforcement proved by the spike; write tasks are macOS-only; `sandbox-exec` is deprecated by Apple but still works on Darwin 27. |
| B | `agy` session rules only | Cross-platform like the Claude executor, but a single client-side layer; `agy` permission semantics are young and undocumented. |
| C | Gemini read-only (`--mode plan`) | Lowest risk, lowest value; no implementation work. |

## Design

### 1. Provider types

- Split today's `Provider = "claude" | "codex"` into `ExecutorProvider = "claude" | "codex" | "gemini"` and `BrainProvider = "claude" | "codex"`. Every switch over providers becomes exhaustive (TypeScript `never` check) so a missing branch fails the typecheck. *(builder's call)*
- Brain-only code (skills, `duo init` brain detection, handoff) keeps `BrainProvider`.

### 2. Config

- `executors.gemini`: `{ enabled: false, command: null, models: "auto" }` (same contract as `ExecutorConfig.command`: `null` = PATH lookup of the default binary, which for `gemini` is `agy`; an override for `gemini` must be a **single absolute executable path with no extra arguments**, because `resolveExecutable()` passes trailing elements through as `prefixArgs` unvalidated and one could inject `--dangerously-skip-permissions`; in addition, the complete effective argv is validated before every invocation against the adapter's allowed flag set) plus fields mirroring the other executors where they apply. Default **disabled**; editing `.duo/config.json` turns it on (no `duo init` flag in this version). *(builder's call: shape of the fields)*
- The config stays portable (one `enabled` switch, valid on every platform). Unsupported provider/kind combinations (Gemini write kinds without the OS layer) are rejected **during routing and explicit delegation**, not at config load, so read-only use keeps working on Windows/Linux.

### 3. Adapter `src/adapters/gemini.ts`

`plan()` builds, for every task:

```
[sandbox-exec -f <profile>] agy -p= --input-format stream-json --output-format stream-json --model <id>
  --mode accept-edits|plan --sandbox --disable-slash-commands
  --settings <session settings JSON or file in artifactsDir>
  [--conversation <id>] [--json-schema <report schema file>]
  < stdin: one NDJSON message carrying the prompt
```

This is the target form; the builder verifies it (or a plain-`-p` stdin form if `agy` supports one). The prompt never appears in argv: a plan test asserts the prompt text is absent from `args` and from `invocation.json`.

- `--mode accept-edits` for write kinds, `--mode plan` for read kinds (review, investigate). Read kinds still get both layers with no writable roots.
- Session settings *(exact rule syntax is the builder's to verify)*: `allowNonWorkspaceAccess: false`; `permissions.allow` = `write_file(<target>)` for each authorized target (write kinds only); **no commands at all**. Acceptance commands stay bridge-only (the duo runs them after the task): a command allowlist limits which program `agy` starts, not what it does, so a test runner executing a test the executor just edited would escape the session-rules layer. Gemini therefore cannot run tests itself in v0.5. *(changed after the Codex review)* If `agy` supports `permissions.deny`, add the `scope.deny` globs and recursion commands (`claude`, `codex`, `duo`, `agy`). Verify whether `--settings` **replaces or merges** the user's `permissions.allow`; if it merges, the adapter must neutralize the user list (e.g. a temporary `HOME`-independent settings path, or refusing to run) — a merged broad allowlist is an anti-goal.
- Executor prompt for Gemini: no shell at all; read files with the file tools; acceptance commands are run by the bridge, never by the executor (the shared prompt that allows `cat` and invites running acceptance does not apply).
- `--json-schema` with the existing report schema, so the final `response` is the `ExecutorReport` JSON. Fall back to `extractJson` on `response` if the schema flag misbehaves.
- Prompt transport: **stdin only** (SECURITY.md lists stdin transport as an enforced control; argv would expose the prompt in the process list). Verify a stdin mode, using `--input-format stream-json` (one NDJSON message on stdin, requires `--output-format stream-json`) if plain `-p` cannot read stdin. An `agy` version without a working stdin mode is refused; no argv fallback. *(changed after the second Codex review)*
- Effort: duo effort maps to the id suffix (`-low|-medium|-high|-xhigh`). The final id and its effort are resolved **before** `confirmFloor()`. For an **automatic** choice, if no variant meets the chain's minimum effort, pick another eligible model or block. For an **explicitly pinned** id, never change suffix or family: an incompatible pin is blocked before invocation (README routing contract). Never run below the floor. `--effort` only if it proves to change behaviour beyond the id. *(builder's call)*
- Model gate: right before every invocation (first run, explicit request, resume, adaptive retry) the final id must match `^gemini-`; anything else is refused, even when catalog discovery is stale or unavailable and `runGates()` skips the catalog check.
- `enforced[]` records each layer honestly: session rules, sandbox profile path and roots, mode, disabled slash commands, env vars removed.
- Env: `childEnv` also strips `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, Vertex vars. `TMPDIR` points to a per-attempt dir **next to the private native state** (outside `.duo/`), removed on success, failure, timeout and interruption.
- User extensions: find where `agy` loads user-level instructions, skills, MCP servers and plugins (the spike showed the owner's posture leaking in). **Executable extensions** (MCP servers, plugins, anything that can call another model or act outside the task: network writes, other AIs) must be disabled for the executor session; if any cannot be disabled or excluded, Gemini delegation is **refused** (depth-one and no-external-side-effects contracts). **Passive** instructions/skills that cannot be turned off are listed in `task.limitations` and the docs; they do not block. *(changed after the third Codex review)*

### 4. Parser

Map the JSON: `conversation_id`→`sessionId`; `status`≠`SUCCESS`→error with `classifyErrorText` on `result.error`+`response`+stderr, keeping `result.error` as the message; `usage`→`usage` (native fields kept); `num_turns`; `duration_seconds`→`durationMs`; `denied_actions.length`→`permissionDenials`; `reportedModel` stays **null** unless a trustworthy served-model source exists (copying the requested id would make `delegate.ts` treat it as native evidence in `confirmNative()`); the telemetry sample is attributed separately to the requested id. The builder looks for such a source (stream-json events, `agy` logs or conversation metadata that name the model that actually answered). Without one, the existing rules apply unchanged: `confirmFloor()` rejects an unknown model for automatic selection and for deep floors, so served-model evidence is a **prerequisite**: without it, any Gemini run on which `confirmNative()` would be called (every adaptive run, including a pinned `-low` id on a light task, because `chain.minEffort` is persisted before invocation) is **refused before invocation**, so no quota is spent on a result the duo would reject. A test covers the pinned case explicitly. *(changed after the second Codex review)* Empty `response` with `denied_actions` = the task hit a denied tool; the report must say so instead of "invalid report". If stream-json gives live events cheaply, the builder may use it for timeouts and liveness. *(builder's call)*

### 5. OS layer (macOS)

- A per-task `sandbox-exec` profile generated in `artifactsDir`: `(allow default)`, `(deny file-write*)`, then allow writes only to: each authorized target, the task `TMPDIR`, **task-private `agy` state** (below), `/dev/null`, `/dev/tty`, `/dev/fd/*`. Denied paths inside roots get explicit `(deny file-write* ...)` after the allows. Never the whole `~/.gemini`, and never the owner's shared `conversations` directory.
- **Task-private state:** the builder finds how to point `agy`'s writable state (conversations, logs, cache, daemon) at a private per-chain directory **outside `.duo/` and outside the artifact tree** (e.g. under the user's application-support dir for duo, mode 0700), so raw native conversations never sit next to the redacted artifacts. It survives `--resume` and `.duo/` stores only a non-secret reference (chain id → state dir). Lifecycle: the state dir is deleted as soon as the chain **can no longer resume**: applied, rejected, failed with no resume left, cancelled, and also any successful chain once accepted or superseded (a successful read-only review has nothing to apply and `duo apply` never needs the native conversation); abandoned resumable chains are listed by `duo status`/`duo doctor` and removed by an explicit cleanup command (e.g. `duo gemini-state prune [--older-than <days>]`), which also removes dirs whose project or `.duo/` no longer exists. Login state stays read-only. **If private writable state cannot be established, Gemini delegation is blocked** — the owner's shared state is never made writable. *(changed after the second Codex review)*
- Target resolution: an authorized file that does not exist yet (accepted by `validateScope()`) is resolved through its **nearest existing ancestor's realpath plus the exact remaining suffix**, and the profile grants that exact path (`literal`), not its parent. The resolved ancestor and target must be **inside the disposable worktree** (realpath, never through a `worktreeLinks` link such as `node_modules` back to the project); otherwise the task is refused before creating any directory or generating either permission layer. If intermediate directories are missing (e.g. `src/new/module.ts` with no `src/new`), the bridge creates them inside the disposable worktree before invocation (empty directories never reach the patch). Directories get `subpath`. Tested with a missing file in an existing directory **and** with a missing parent, each while a sibling write is denied.
- Denied descendants: when an authorized directory contains a `scope.deny` match, the session rules must express the exclusion (an `agy` deny rule). If `agy` cannot express it, such overlapping writable scopes are **refused** for Gemini before invocation; the OS layer alone is never accepted for them.
- Paths are canonicalized (`/private/tmp` vs `/tmp`, symlinks) and escaped for the SBPL string/regex syntax; profile generation is unit-tested against injection (quotes, parentheses, newlines in paths).
- `duo doctor` stays inference-free: it runs a deterministic local probe (a plain shell command under a generated profile writes an allowed file and fails on a sibling and on `../`). The real `agy` containment test runs only behind an explicit opt-in (e.g. `duo doctor --live-gemini`), since it spends subscription quota and a quota outage could look like a containment failure. On macOS a successful OS probe is required for **every** Gemini invocation, read or write. If `sandbox-exec` is missing or the local probe fails, all Gemini kinds are refused on macOS with a clear message; nothing falls back to fewer layers.
- Non-macOS: Gemini allowed only for read kinds, with layer 1 and `--mode plan`, and only on a platform where a real `agy` review has been shown to read successfully and to deny an attempted in-workspace write with no OS layer (until then the platform stays disabled); write kinds refused ("executor gemini exige macOS para tarefas de escrita").
- Network stays on (agy needs its backend). Recursion is prevented by the command allowlist (deny-by-default), not by the network.

### 6. Catalog, routing, quota

- `agy models` feeds the catalog (cached like `duo models --refresh`); keep only `gemini-*`. Tiers *(builder's call, conservative)*: Flash = fast/light; Neon/Argon/Hydrogen placed by what docs/naming support, all with low confidence until `minSamples`. The owner can exclude ids with `routing.exclude`.
- Quota/capacity/auth classification through the existing `classifyErrorText`, extended with any `agy`-specific messages found in testing; recorded per provider like the others.
- Auth check: `agy models` succeeding only proves the CLI can list models; it does not prove the billing path. Delegation additionally requires either a **non-secret auth signal** read under the executor's effective settings that identifies the Google-account (subscription) login, or evidence that this `agy` version supports no other credential source. If neither can be established, Gemini delegation is blocked. *(changed after the Codex review)*

### 7. Brain-facing surface

`duo status`, `duo doctor`, `duo models`, decision guide and request format mention `executor: "gemini"`, its macOS-only write rule and its models. Repo texts bilingual (English first, Portuguese below); code messages in Portuguese.

## Tests and release gate

- Unit: plan args per kind/platform, settings JSON, profile generation and escaping, env stripping, parser fixtures (success, denied, quota, auth, malformed), exhaustive provider switches.
- Integration with a fake `agy` binary (like the existing fake Codex/Claude).
- **Containment proofs (real `agy`, macOS).** Every case checks both files on disk, so a client that refuses every write cannot pass: (a) both layers on: the authorized file (existing and not-yet-existing) is written; an unauthorized **sibling in the same worktree**, a denied path and `../outside` are not; (b) only the OS layer (session settings deliberately permissive): same results; (c) only session rules (no profile): same results; (d) any command (e.g. `git add`, `codex`) is denied; (e) the owner's `~/.gemini` settings and other `agy` conversations are unchanged after the run; (f) two parallel Gemini tasks cannot touch each other's state. Every negative case also needs **evidence that the forbidden operation was attempted and denied by the layer under test** (`denied_actions` or the tool event for session rules; the tool's `operation not permitted` error for the OS layer). A forbidden operation the model skipped makes the case **inconclusive, not a pass**, and the gate fails until it is re-run conclusively.
- Real E2E battery gets Gemini scenarios (implement in worktree, review read-only, resume, parallel with Codex). Quality test gets a Gemini criterion. **Gate 100/100** as always; version bump and publication only with the owner's permission (develop → homolog → release → main).

## Release blockers outside code

- The owner reads the Antigravity terms on use by third-party tools. The duo runs the official CLI with the owner's own login (no own OAuth), but this must be confirmed before publishing.
- Measure how much a typical task costs in the AI Pro quota; document it.

## Decisions after the builder check (Codex, 22/11/2026)

- **Acceptance commands** *(builder's call)*: the duo re-runs acceptance commands itself, outside any executor sandbox, for every executor today; an executor that edits a test script can make that run do anything the owner's user can. Gemini does not change this risk and v0.5 does not fix it for all executors. It is documented as a known limitation (EN/PT) and listed as a follow-up ("run acceptance under the same OS profile").
- **`scope.deny` inside a writable root** *(builder's call)*: Gemini write tasks **always run with `isolation: worktree`**, even alone, so nothing they write reaches the project until `duo apply`. Inside the worktree, the OS profile and an `agy` deny rule both block denied paths, and the existing verification rejects any patch touching a denied path. If `agy` has no deny rules, writable scopes that contain a denied descendant are refused for Gemini (section 5).
- **Billing evidence** *(builder's call, mirrors the existing Claude/Codex rule)*: delegation to Gemini requires (a) all API-key env vars stripped, (b) `agy models` succeeding with the Google account login, and (c) an explicit `billing.acknowledgeUnverifiableExtraUsage.gemini: true` in config (the existing key used for Claude/Codex), set by the owner, stating that `agy` usage counts against the AI Pro subscription. Without (c) Gemini is blocked with a message, as the current extra-usage rule does.
- **Billing evidence** above is necessary but not sufficient: the auth-signal rule in section 6 also applies.
- **Unobservable model** *(builder's call)*: `agy` runs the exact id requested (no automatic model fallback was observed). Results are accepted on file verification as for other executors; `reportedModel` stays null (section 4) and the telemetry sample is attributed to the requested id with `modelObserved: false`, counting toward routing history. If a future `agy` reports the served model, the adapter uses it and a mismatch is treated like today's model mismatch.
- **Fallback between three accounts — owner's decision (22/11/2026):** "a minha ideia é o Gemini funcionar igual ao ChatGPT hoje, ser uma opção para ser utilizada caso necessário". Once enabled (and acknowledged), Gemini is a peer executor exactly like Codex: the router may choose it, and it is an eligible alternative when another account runs out of quota or capacity. Selection rule *(builder's call on the details)*: first the existing same-account retry (equivalent model on the same provider when only one model is at capacity or `affectedModels` limits the quota event) runs unchanged; only if it yields no candidate, among the other enabled accounts that pass every gate and meet the chain's floor, pick the one the router scores best; on a tie, prefer the account whose served model can be confirmed (today Claude/Codex). An explicitly pinned account changes only where today's quota-fallback rule already allows it. If no alternative passes, block as today. For **write kinds** (`isWriteKind(task.kind)`), Gemini is **not eligible** as fallback for a chain whose `fixedIsolation` is `in-place` (a lone in-place task that ran out of quota), since its write tasks must run in a worktree; read-only kinds stay eligible in-place; the fallback then considers only the other accounts.
- **Consequence to watch:** until a trustworthy served-model source is found (section 4), automatic selections that need model confirmation cannot land on Gemini, so in practice it would only be usable in a **non-adaptive** request with an explicit Gemini id (a pin alone does not disable adaptive routing; section 4 refuses a pinned adaptive run). Finding that source is therefore the first investigation of the implementation.

## Left to the builder

File layout, helper names, exact `agy` rule syntax (after testing), the exact stdin form, tier placement, message wording, test structure, which `agy` state paths the profile needs (found by running under the profile with logging).

## Coordination

Branch `feature/gemini-executor` from `origin/develop` (v0.4.0). `feature/computer-use` is also pending for "the next version"; the version number (0.5.0 or 0.6.0) is decided at release time by merge order.

---

## Português (resumo)

O Gemini entra no duo como terceiro executor (nunca cérebro), pelo Antigravity CLI (`agy`) e pela assinatura, sem API paga. Vem desligado por padrão. No macOS faz qualquer tipo de tarefa, com duas travas independentes contra escrita fora do escopo: as regras de sessão do próprio `agy` (`--settings` com `allowNonWorkspaceAccess: false` e lista mínima de permissões) e um perfil `sandbox-exec` do sistema. Cada trava sozinha precisa barrar a escrita, e os testes provam isso. Fora do macOS, só tarefas de leitura. O executor não herda a configuração do Vitor no `agy` (que hoje libera acesso fora da pasta e comandos como `rm .env`), nem chaves de API. Só modelos `gemini-*` entram no catálogo. Gate 100/100 antes de publicar; o Vitor confere os termos do Antigravity e mede a cota antes da release.
