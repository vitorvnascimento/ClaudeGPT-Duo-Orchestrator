# ClaudeGPT - Duo Orchestrator by Fusic

**English** · [Português](#português)

**Claude Code and Codex working together in your VS Code, each part of the task handled by the model best suited to it, using the official CLIs and your own subscriptions.**

**ClaudeGPT - Duo Orchestrator by Fusic** (`duo-orchestrator`) is a local bridge that lets **Claude Code** and **OpenAI Codex** work together through their official CLIs and your own subscriptions (no API keys; optional user-authorized loopback proxy). You talk normally to Claude Code (or Codex). When a task has different parts, such as code and an illustration, the agent you opened (the **brain**) uses the `duo-delegate` skill to send each part to the best available model in your connected accounts: Opus 5.5 for code and GPT-6-Astra for art, for example. The `duo` bridge runs the other CLI and **independently verifies the result** (changed files, scope, diffs, acceptance tests and valid images) before returning it to the brain. It records which model actually ran, reading Codex's own session log. Install with `git clone … && npm ci && npm link` (or the release `.tgz`), run `duo init --apply` inside a Git project, and use `/duo-delegate` in Claude Code or `$duo-delegate` in Codex. Documentation is available in English and Portuguese.

```text
You: "/duo-delegate build the home page and a robot illustration at assets/robo.png"

Claude (Opus 5.5, brain)  ── writes the HTML/CSS
          │
          └─ duo delegate ──▶ Codex (GPT-6-Astra) ── generates assets/robo.png
                               │
                               └─ bridge checks: only assets/ changed, valid 1254×1254 PNG,
                                  effective model gpt-6-astra (from Codex's own session log)
```

> **Status (September 2026):** 424 offline tests in the current tree; historical v0.2.0 validation includes a real E2E suite of 16/16 and a real quality score of **100/100**, with independent evidence of which model executed each part ([docs/e2e-real.md](docs/e2e-real.md), [docs/evidencias/](docs/evidencias/)). Tested on macOS; Windows and Linux have not yet been tested.

## What the project is and is not

| It is | It is not |
| --- | --- |
| A local bridge calling the official `codex exec` and `claude -p` | A gateway reusing tokens to call private endpoints |
| Individual use, each client with its own official login | A service offering subscription login to third parties |
| A `subscription-only` profile that blocks API, gateway and cloud access | A disguised paid API or automatic billing fallback |
| One brain per task and one active executor at a time | An autonomous swarm or a third planning AI |

## Requirements

| Item | How to get it |
| --- | --- |
| **Node.js 22.12+** and **Git** | [nodejs.org](https://nodejs.org) (or `brew install node`) |
| **Claude Code CLI 2.1.280+** with a Pro/Max subscription | `npm install -g @anthropic-ai/claude-code`, then `claude` and `/login`. Already installed? `claude update` |
| **Codex CLI** with a ChatGPT account (Plus/Pro) | `npm install -g @openai/codex`, then `codex login` |

VS Code extensions do not put the CLIs on PATH: install the CLIs even if you already use the extensions. Check with `claude --version` and `codex --version`.

You can use just one of the two accounts, but the project's goal is to combine both.

## Quick installation

**Option 1 — clone and link (recommended; easy to update):**

```bash
git clone https://github.com/vitorvnascimento/duo-orchestrator.git
cd duo-orchestrator
npm ci          # instala só typescript e @types/node e compila
npm link        # coloca o comando duo no PATH
duo --version
```

To update later: `git pull && npm ci`. To run the offline tests (no model is invoked): `npm test`.

**Option 2 — prebuilt release package (no compilation):**

```bash
npm install -g https://github.com/vitorvnascimento/duo-orchestrator/releases/download/v0.2.0/duo-orchestrator-0.2.0.tgz
duo --version
```

Or download with the GitHub CLI and install the local file:

```bash
gh release download v0.2.0 -R vitorvnascimento/duo-orchestrator -p "*.tgz"
npm install -g ./duo-orchestrator-0.2.0.tgz
```

Without `npm link` or a global installation, use `node /caminho/duo-orchestrator/dist/src/cli/main.js` instead of `duo`. **Removal:** `npm uninstall -g duo-orchestrator` (or `npm unlink -g duo-orchestrator`).

### Updates

`duo` notifies you when a new version is released: at most once a day, in the background, it checks this repository's latest public GitHub release and, if a newer version exists, prints a terminal message (stderr, without interfering with `--json` output):

```text
duo: nova versão 0.3.0 disponível (instalada: 0.2.0). Novidades: https://github.com/vitorvnascimento/duo-orchestrator/releases/tag/v0.3.0
     Atualize com: duo update --apply   (desligar aviso: DUO_NO_UPDATE_CHECK=1)
```

- `duo update` checks immediately; `duo update --apply` installs the new version (`npm install -g` using the official release `.tgz`).
- The check is anonymous: it sends no token, login, email or environment variables, and only accepts a stable release from this repository with the expected `.tgz`. Nothing is installed unless you request it.
- It does not check inside executors, in CI, in the Codex sandbox or with `DUO_NO_UPDATE_CHECK=1`.
- Only the maintainer publishes releases; the repository is public for reading and use.

> `npm install -g github:vitorvnascimento/duo-orchestrator` is **not** recommended: in this mode, npm 10 does not correctly prepare packages that require compilation. Use one of the options above.

## First use (5 minutes)

**1. Enable it in a project** (must be a Git repository):

```bash
cd ~/meu-projeto
duo init            # mostra o que vai criar, sem gravar nada
duo init --apply    # cria .duo/config.json e as skills do Claude e do Codex
```

This creates `.claude/skills/duo-delegate/`, `.agents/skills/duo-delegate/` and `.duo/config.json`, and adds `.duo/` to `.gitignore`. If `duo` is on PATH, the skills call only `duo`, and the project works on any machine with duo installed.

**2. Review `.duo/config.json`:**

- `acceptance.allowedCommands`: commands the bridge can run to verify the work, such as `[["npm","test"]]`. If the project has `npm test`, it is configured automatically.
- `billing.acknowledgeUnverifiableExtraUsage`: **protective gate**. Neither CLI reports whether extra usage or credits are enabled in your account. Check the claude.ai and ChatGPT settings and, if disabled (or acceptable to you), set the account receiving delegations to `true`. While it is `false`, delegation to that account is blocked. Details in [docs/autenticacao.md](docs/autenticacao.md).

```json
"billing": { "profile": "subscription-only", "acknowledgeUnverifiableExtraUsage": { "claude": true, "codex": true } }
```

**3. Check:**

```bash
duo doctor    # as duas direções devem aparecer como "pronto"
duo models    # modelos disponíveis nas suas contas (não consome cota)
```

**4. Use it.** Open the project in VS Code and ask Claude Code:

```text
/duo-delegate adicione a função formatarPreco em src/preco.js com testes, e crie um ícone de carrinho em assets/carrinho.png
```

Or ask Codex, invoking the skill by name:

```text
$duo-delegate revise src/auth/ procurando falhas de segurança
```

When the brain requests permission to run `duo delegate`, approve that command. The delegated part takes 30 seconds to 2 minutes. In Codex, it requests execution outside the sandbox because it needs network access and the Claude login.

**5. Monitor:** `duo status` (what was delegated), `duo report` (time, tokens and the source of each number).

## Everyday use

- **Let evidence guide the choice:** without naming models, the brain consults `duo recommend`, which selects based on your project's verified history and capabilities (art only goes to models that generate images). When `model` is omitted from the request, adaptive selection chooses within the requested `executor` and records `tier`, `effort` and `selection`. In a new project, the first choice relies on judgment and improves with use.
- **Or force the choice:** *"use Opus 5.5 for code and GPT-6-Astra for art"*. Explicit `model` and `effort` are preserved; `complexity` (`light`, `standard` or `deep`) indicates the initial tier, subject to minimum tiers; `adaptive: false` or `duo delegate --no-adaptive` restores pre-adaptive behavior. The model must exist in the account (`duo models`).
- **Cross-review:** *"implement X and ask Codex to review it"*. The review runs in read-only mode.
- **Switch brains during work:** `duo handoff --to codex --next "..."` creates a document in `.duo/handoffs/` to open in the other AI.
- **Another computer:** install duo (Option 1 or 2), sign in to both CLIs and you are ready. If the project already has versioned skills and `duo` is on PATH, you do not need to run `init` again.

Tips:
- In Codex with many installed skills, it may not find the skill on its own ("Exceeded skills context budget"). Invoke `$duo-delegate` explicitly.
- Do not edit scoped files while the executor runs: the bridge detects the change and fails the task.
- For HTML pages opened directly from disk in Safari, images in folders above the page do not load. Keep the HTML at the root and images in subfolders.

## Windows (untested)

The bridge runs processes **without a shell**. `.cmd` shims (such as npm's `claude.cmd`) would require a shell, so the bridge rejects them. Use the official `.exe` (Claude Code's native installer creates `claude.exe`) or configure `.duo/config.json`:

```json
{ "executors": { "claude": { "command": ["C:\\Users\\voce\\.local\\bin\\claude.exe"] },
                 "codex":  { "command": ["node", "C:\\caminho\\para\\@openai\\codex\\bin\\codex.js"] } } }
```

The code was written to be portable (`taskkill /T /F` to terminate processes), but tests ran only on macOS. Reports and fixes are welcome.

## Commands

| Command | What it does |
| --- | --- |
| `duo doctor [--json]` | Diagnostics without inference: versions, supported flags (read from `--help`), authentication method from official status, billing conflicts, hooks/MCP and other coordinators. |
| `duo init [--brain claude\|codex] [--apply] [--overwrite]` | Project config and skills with preview/diff and backup. |
| `duo delegate --request <arquivo> [--no-adaptive]` | Executes a brain request (format in `schemas/delegation-request.schema.json`). Prints final JSON; `--no-adaptive` disables adaptive selection for this execution. |
| `duo delegate --resume <taskId> [--timeout-sec N]` | Resumes a `blocked` task (timeout, interruption, quota, login…), reusing the native session; `--timeout-sec` gives the resumed execution more time. |
| `duo models [--refresh] [--json]` | Models available in connected accounts (Claude and Codex), with tier, efforts, extra usage, origin, vendor recommended/legacy status, successor and retirement, tools (e.g. image generation) and the source used. No inference; 6 h cache per CLI version (1 h if any source is degraded). |
| `duo recommend [--request <pedido.json>] [--kind …] [--needs image_generation] [--paths …] [--risk …] [--brain …] [--brain-model …]` | Deterministic recommendation based on evidence, capability and availability. Output includes `tier`, `effort` and `selection`, plus executor/model, or indicates doing it yourself. `--request` provides the actual objective, scope and acceptance criteria. |
| `duo status [--run-id]` | Runs and tasks. Detects interruptions (bridge no longer running) and marks tasks `blocked`. |
| `duo report [--run-id] [--json]` | Deterministic report with the source of each number. |
| `duo cancel --run-id <id>` | Terminates bridge and executor (process tree) and marks `cancelled`. |
| `duo apply --task-id <id>` | Integrates a `worktree` task's patch, only if the base has not changed. |
| `duo accept --task-id <id> [--reject] --note "..."` | Records the brain's decision (accepted tasks enter the metric). |
| `duo handoff --to <cliente>` | Handoff document to switch brains. |
| `duo quota show` / `duo quota set …` / `duo quota refresh` | Observed account state, manual records and Codex reading through app-server. |
| `duo update [--apply]` | Checks for a new version (public release, no credentials) and, with `--apply`, installs it. |

`delegate` exit codes: `0` succeeded, `1` failed, `2` invalid request, `3` blocked, `4` cancelled.

## Multiple models, the best for each part

The bridge is not limited to "Claude or Codex": it works with **models**.

- **`duo models`** discovers what connected accounts offer, without inference. In Claude, it uses the `initialize` handshake (the same as the Agent SDK's `supportedModels()`). In Codex, it uses `model/list` and `modelProvider/capabilities/read` from `codex app-server`, methods on the stable protocol surface used by the VS Code extension. If a source fails or changes format, the bridge falls back to the next: `codex debug models`, then the last good catalog (marked stale), then `routing.candidates`. `duo doctor` checks the protocol contract locally and warns before something breaks. Example account: Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 4.5 and others in Claude; GPT-6.1-Sol, GPT-6-Astra, GPT-6-Sol, GPT-6-Luna and the 5.x family in Codex, plus the **`image_generation`** tool.
- **Each subtask declares its requirements:** `kind: "asset"` + `needs: ["image_generation"]` for art. The router only considers models with that capability.
- **Any model, any brain:** delegation can target the **same client with another model** (e.g. GPT-6-Sol brain → art with GPT-6-Astra; Opus 5.5 brain → simple task with Sonnet 5). Only delegation to the brain's own model is rejected.
- **The bridge validates before and after:** it blocks a `model` that does not exist in the account (listing available models) and, for art, checks the binary signature of the image written within scope (PNG/JPEG/WebP/GIF). A "completed" without a valid image becomes `failed`.

### v0.3.0 foundation (phases 1 and 2)

The catalog records `cliVersions` and expires after 6 h (1 h when degraded). Updating either CLI invalidates the cache on the next query; `duo models --refresh` forces discovery. The list depends on the installed version: the Codex server also filters by `client_version`.

`duo models` shows the `light`, `standard` or `deep` tier, supported efforts, origin and extra usage. JSON includes `tier`, `presumed`, `extraUsage` and `source`. Default tiers follow families: Opus/Fable/Astra → deep; Sonnet/Sol/Terra → standard; Haiku/Luna/Mini/Nano → light. Unknown families receive presumed standard. The first regex in `routing.adaptive.tiers` matching ID, alias or name (case-insensitive) takes precedence.

Models from the root `model` keys in `~/.codex/config.toml` and `~/.claude/settings.json`, or from `routing.extraModels` (`["codex:gpt-6.1-sol"]`), appear as user-configured if the CLI does not list them. IDs and aliases are not duplicated. These files are only read; presence in configuration does not confirm availability in the account.

A request may declare `"effort": "high"` (`low|medium|high|xhigh|max`). Claude receives `--effort high`; Codex receives `--config model_reasoning_effort="high"`. The bridge blocks before execution if the CLI does not advertise the flag. Without explicit `effort` and with adaptive selection disabled, argv is the same as in 0.2.0; with it enabled, the bridge may use the effort returned by `selection`. Requested effort is recorded in the task; older tasks remain valid.

`duo models` and `duo doctor` anonymously check published CLI versions on npm (`.duo/cli-latest.json` cache, 6 h, 5 s timeout), and suggest updates when needed. They never install anything. Without a network, there is no new warning. Disable with `DUO_NO_UPDATE_CHECK=1` or `discovery.checkCliUpdates=false`; the check is also disabled in executors (`DUO_DEPTH`), CI and the Codex sandbox. `doctor` shows installed/published versions and `--effort`/`--config` support. The new defaults, merged into older configs, are:

```json
{
  "discovery": { "checkCliUpdates": true },
  "routing": {
    "extraModels": [],
    "include": null,
    "adaptive": {
      "enabled": true,
      "tiers": [],
      "lightMaxFiles": 3,
      "maxAttempts": 2,
      "downgradeMinSuccess": 0.85,
      "quotaWarnPercent": 90
    }
  }
}
```

`selectEffort` prefers low/medium/high by tier (xhigh on escalation), or the next supported effort above it; it returns null without a suitable option. `extraUsage` flags `[1m]` context, credits or prices in the description.

### Phase 2 — adaptive selection

`duo recommend` passes `tier`, `effort` and `selection` into the decision. Use `--request <pedido.json>` to provide the actual objective, scope and acceptance commands; with `--kind` without acceptance criteria, the minimum tier is `standard`. When the request specifies `executor` and omits `model`, the bridge automatically chooses within that executor; it never changes the requested executor. `model`, `effort`, `complexity` (`light|standard|deep`) and `adaptive: false` force the indicated behavior. The CLI also accepts `duo delegate --no-adaptive`.

Minimum tiers apply to the effective model, including explicit choices, executor configuration and resumptions: high or sensitive risk requires `deep`; `light` is only allowed for low risk, few files, no directory in scope and acceptance commands. An incompatible model, unknown default or presumed tier under a `deep` minimum, or explicit `effort` below `high` under that minimum, blocks before execution. Capability (including image generation) and tier must both be satisfied. A downgrade only occurs with sufficient evidence and success at or above `routing.adaptive.downgradeMinSuccess`, respecting minimum tiers. Verification failure escalates `light → standard → deep`; `maxAttempts` counts the first attempt, and `deep` may use `xhigh` when supported. Explicit `model` does not change; explicit `effort` remains, and without it escalation only increases effort when supported.

Each `worktree` attempt receives a new worktree and keeps the previous one for inspection. In `in-place` mode, another attempt is allowed only if the executor left no changes. Infrastructure failures do not escalate. Extra usage is allowed only with `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` and the model included in `routing.include`. In phase 3, exhausted quota may switch executor/model to an equivalent at the same or higher tier, repeating all gates; it never lowers the tier.

`request.json` preserves the original request; `invocation.json` records resolved command/arguments and `selection.origin` distinguishes explicit from automatic choices. Resumptions keep automatic choices eligible for escalation, the chain counter even before the base, and the minimum effort already reached. Fallback looks for a destination supporting that effort or blocks. The chain shares the original request hash; repeating `taskKey` in the same run reuses the final success, without a blocked ancestor hiding it.

Example validated with real CLIs (E2E A1): an art request to `codex` with `model: "gpt-6-astra"` generated `assets/mascot.png` (PNG 1254×1254), verified by the bridge.

### Quota and continuity (phase 3)

`duo quota refresh` forces catalog discovery and queries `account/rateLimits/read` in the same Codex app-server session. It uses no custom API, consumes no credits and invokes no models. Claude provides `rate_limit_event` during execution; without a native percentage, remaining usage is unknown. `duo quota set --provider claude --used-percent 92 --resets-at <ISO8601>` records a manual observation. `duo quota show` keeps the previous format and adds `state` with status, source, usage, reset and affected models, plus `remainingPercent` (null when unknown). `duo recommend` shows quota health.

`.duo/quota-state.json` stores only `status`, `usedPercent`, `resetsAt`, `observedAt`, `source` and `affectedModels`, under `claude`/`codex` (one active account per CLI). Email, account ID, plan, credits and tokens are not stored. State becomes `unknown` after reset, or after 6 h without a reset. No estimate of remaining usage is invented when the CLI provides no percentage.

At usage ≥ `routing.adaptive.quotaWarnPercent` (90 by default), candidates from that account lose 0.15 in score for `light`/`standard` tasks; `deep` receives no such penalty. Exhausted quota blocks the account, or only models explicitly identified through an unambiguous catalog mapping. The observed percentage is the highest usage across windows; blocking limits reset at the latest known reset. If any blocking limit lacks a reset, reset is unknown.

If quota runs out during an adaptive task, the bridge first tries other models from the same provider when the limit is model-specific, then the other provider, always at the attempt's tier or above. Each fallback counts toward `maxAttempts` and the run's policy limits, keeps the original task resumable and records the chain in `selection.fallbacks`. The bridge prompt is neutral; sandbox and permissions remain specific to each executor. Explicit `model` may be replaced **only in this quota fallback**; explicit `effort` remains subject to destination support. Without an equivalent, with changes left in-place or if the destination is the brain's own client/model, it returns `blocked`. `adaptive: false` still records quota, without automatic fallback.

For a local proxy using your subscription, explicitly enable `billing.allowLoopbackProxy: true` (default `false`). The exception only accepts HTTP/HTTPS at `127.0.0.1`, `localhost` or `[::1]` in client settings/config. In Codex it also requires `requires_openai_auth = true`, with no credential keys in the custom provider. `ANTHROPIC_BASE_URL` is still removed from the process environment. `duo doctor` shows authorization or a hint to enable the option. The local proxy can see traffic and the session token; see [SECURITY.md](SECURITY.md).

## Choosing an executor: evidence, not brand

The skill guides the brain through an explicit procedure: understand and decompose the task, classify risk and coupling, choose the executor, assemble minimal context, verify and record the decision. To choose an executor, the brain consults `duo recommend`, which is deterministic and calls no AI:

- **Evidence:** comparable tasks in this project (same `kind` and language, falling back to broader buckets when samples are scarce). Bridge-verified success, acceptance tests, penalties for claimed success that failed verification, and brain rejections (`duo accept --reject`) count. Login, quota or timeout failures do **not** count against the model.
- **Efficiency:** in a technical tie, the lowest median time wins.
- **Availability:** installed CLI, subscription login, acknowledgment of extra usage and observed limits.
- **Decision:** `DELEGAR` to the best candidate (with the model), `FAZER VOCÊ MESMO` when the best history belongs to the brain's own client, or `JULGAMENTO` when evidence is insufficient.
- **Candidates** (`routing.candidates`): by default Claude `claude-opus-5-5` and the account's default model in Codex; others such as `sonnet` can be added. Personal preferences only enter as `routing.priors`, with a bonus limited to ±0.2 and always identified.

Validated with real CLIs (E2E T12/T13): with history favoring Claude, the Claude brain decided to **do it itself** and the Codex brain **delegated to Claude**.

## How delegation is verified

1. **Request**: validated against the schema. The executor may be the same client with another model, but not the brain's own model; the brain is fixed within a run.
2. **Policy** (`economico` by default): delegation reason compatible with policy, up to **2 invocations per run** (including correction) and quota preference.
3. **Scope**: relative paths only, no `..`, no symlinks, outside the denylist (`.env`, keys, `.git`, `.duo`…).
4. **Compatibility**: required flags must appear in the installed version's `--help`.
5. **Authentication**: API/gateway variables are removed from the executor environment, settings such as `apiKeyHelper` or custom providers block execution (except explicitly authorized loopback proxies), and the effective method must be confirmed as subscription authentication by official status.
6. **Lock**: one active executor per project.
7. **Execution**: prompt through stdin, separate arguments, no shell, with timeout, output limit and process-tree termination.
8. **Independent verification**: actually changed files (by hash), scope violations, diff of the executor's delta only, discrepancies between what the executor declared and did, changed base and acceptance commands executed by the bridge.

A model's "completed" with a failing test becomes `failed`. Nothing is automatically reverted: the bridge never uses `reset --hard`, `clean` or `stash`.

## Local state

```text
.duo/
  config.json
  runs/<runId>/run.json
  runs/<runId>/tasks/<taskId>/{task.json, request.json, prompt.txt, invocation.json, events.jsonl, stderr.txt, changes.diff|changes.patch, snapshot/}
  telemetry.jsonl   quota.json   quota-state.json   lock.json   handoffs/   backups/   worktrees/
```

Every persisted file undergoes secret redaction. Reasoning text (`reasoning` in Codex and `thinking` in Claude) is not recorded.

## Validation status

| Item | Status |
| --- | --- |
| Code, tests and documentation | Implemented |
| 424 offline tests across phases 1–3 (adapters with simulated CLIs, complete flow, router, model catalog with fallbacks, art, CLI as a real process, process-tree termination, secret redaction) | **Passing**, no orphan processes |
| Real `duo doctor` | Claude 2.1.114 and Codex 0.157.1 authenticated by subscription, with all required flags present |
| Real E2E suite ([docs/e2e-real.md](docs/e2e-real.md)) | **16/16** in a complete run from scratch with Opus 5.5 (previously 13/13 and 11/11): read-only review in both directions, impossible acceptance, out-of-scope temptation, timeout + resume (Codex and Claude), cancellation, worktree + apply, blocked recursion, evidence-based routing in both directions, **real art with GPT-6-Astra** and **tasks with different models per part** (Opus 5.5 for code + GPT-6-Astra for art), with Claude or Codex as brain |
| Native brain using the skill | **Validated in headless mode**: `claude -p "/duo-delegate …"` → Codex and `codex exec "$duo-delegate …"` → Claude, both `succeeded` |
| Exhausted quota and scope violation with a real executor | **Not exercised**: real executors respected scope and quota did not run out; both cases remain covered only by offline tests |
| VS Code extensions (interactive panel) | **Not exercised**: brains ran through CLIs in headless mode; skills and commands are the same, but interactive approvals were not tested |
| Windows | Portable code written; **untested** |

Details in [docs/compatibilidade.md](docs/compatibilidade.md).

## Known limitations

- The Codex executor can **read** any file readable by the user: the sandbox restricts writing and network access, not reading. The Claude executor has deny rules for protected paths, but the client enforces them, not the operating system.
- Lock, `DUO_DEPTH` and command denylists are **cooperative** barriers. Enforced barriers are the Codex sandbox, Claude's `dontAsk`/`--tools` permissions and the bridge's subsequent verification (see [SECURITY.md](SECURITY.md)).
- Quotas: Claude Code emits a `rate_limit_event` in the stream (window, reset, extra usage), recorded by the bridge as a native observation **after** each execution. Codex emits no equivalent in `exec --json`; `codex app-server` is used to discover models and, during discovery or `duo quota refresh`, to read limits through `account/rateLimits/read`. Without an observation, the report shows the manual record or "não disponível".
- The executor loads the client's user configuration: in Claude, user hooks and plugins (e.g. claude-mem); in Codex, skills, plugins and MCPs from `~/.codex`. In an environment with many plugins, this resulted in 142 thousand input tokens in Codex for a trivial task. Therefore, the Codex executor defaults to `--disable hooks --disable plugins` (`executors.codex.disableUserExtensions`), after a plugin's hooks (Ruflo) wrote files in the project during a real delegation. `executors.codex.ignoreUserConfig: true` may reduce usage, but **has not been tested** with a real CLI (it also changes the default model).
- The effective model depends on the CLI version: with `model: "opus"` in settings, `claude` 2.1.114 used `claude-opus-4-7`. Therefore, the executor explicitly requests `claude-opus-5-5` (CLI updated to 2.1.283). The actual model is recorded in each task, and the bridge warns if it differs from the request.
- The router learns only from **this project's** history: in a new project, recommendations start as "judgment". The brain's performance when it does a task itself is not measured; only its history as an executor counts as evidence for the same client.
- There is no official interface to verify whether credits or extra usage are active in accounts; this is why explicit acknowledgment exists.
- Files ignored by Git and outside scope (e.g. `node_modules/`) are excluded from change detection.
- Acceptance commands run without API/gateway variables in the environment (the same cleanup as the executor); tests depending on them will fail.
- In `worktree` mode, acceptance commands run in the worktree, where untracked dependencies (e.g. `node_modules`) may be absent.
- With Codex as brain in headless mode, execution of `duo delegate` outside the sandbox was approved by the automatic reviewer (`--approve-for-me`). In interactive VS Code, you approve it.

## Documentation

- [docs/autenticacao.md](docs/autenticacao.md): official login, subscription-only profile and extra usage.
- [docs/compatibilidade.md](docs/compatibilidade.md): observed matrix.
- [docs/decisoes.md](docs/decisoes.md): technical decisions and consulted references.
- [docs/avaliacao.md](docs/avaliacao.md): how to measure whether delegation actually helps.
- [docs/e2e-real.md](docs/e2e-real.md): E2E suite with real CLIs (consumes quota), scenarios, criteria and results.
- [SECURITY.md](SECURITY.md): threat model and enforced versus cooperative measures.
- [examples/](examples/): requests in both directions, a task without delegation and a cross-review.

## Evidence of which model executed

Each task delegated to Codex records, from Codex's own session rollout, the effective model, provider, server response IDs (`resp_…`), tools called and SHA-256 of images generated by the image tool. If the effective model differs from the request, the task shows a warning. In Claude, the model comes from the stream itself (`system/init` and `modelUsage`). See `evidence` in the JSON returned by `duo delegate`.

## Contributing

Issues and pull requests are welcome. Before submitting: `npm ci && npm test` (all offline). The real suite (`tests/e2e/real-e2e.mjs`) and quality test (`tests/e2e/quality-test.mjs`) consume your subscription quota and only run with `--confirm-quota`.

## License

[MIT](LICENSE).

## Possible future developments

A dedicated VS Code panel, an optional Codex App Server adapter (sessions, approvals, limits) after validating maturity, brain recommendation before starting, and parallelism with multiple worktrees. None of these should introduce custom subscription login.

---

## Português

**Claude Code e Codex trabalhando juntos no seu VS Code, cada parte da tarefa feita pelo modelo que faz melhor, usando as CLIs oficiais e as suas próprias assinaturas.**

Você conversa normalmente com o Claude Code (ou com o Codex). Quando a tarefa tem partes diferentes, por exemplo código e uma ilustração, a IA que você abriu (o **cérebro**) usa a skill `duo-delegate` para mandar cada parte ao melhor modelo disponível nas suas contas: o Opus 5.5 no código e o GPT-6-Astra na arte, por exemplo. A ponte `duo` executa a outra CLI e **confere o resultado de forma independente** (arquivos alterados, testes, imagem válida) antes de devolver ao cérebro.

```text
Você: "/duo-delegate crie a página inicial e uma ilustração de um robô em assets/robo.png"

Claude (Opus 5.5, cérebro)  ── faz o HTML/CSS
          │
          └─ duo delegate ──▶ Codex (GPT-6-Astra) ── gera assets/robo.png
                               │
                               └─ ponte confere: só assets/ mudou, PNG válido 1254×1254,
                                  modelo efetivo gpt-6-astra (registro do próprio Codex)
```

> **Estado (setembro de 2026):** 424 testes offline na árvore atual; a validação histórica da v0.2.0 inclui bateria E2E real 16/16 e teste de qualidade real **100/100** com provas independentes de qual modelo executou cada parte ([docs/e2e-real.md](docs/e2e-real.md), [docs/evidencias/](docs/evidencias/)). Testado no macOS; Windows e Linux ainda não foram testados.


## O que o projeto é e o que não é

| É | Não é |
| --- | --- |
| Uma ponte local que chama `codex exec` e `claude -p` oficiais | Um gateway que reutiliza tokens para chamar endpoints privados |
| Uso individual, cada cliente com seu próprio login oficial | Um serviço que oferece login de assinaturas a terceiros |
| Perfil `subscription-only`, que bloqueia API, gateway e nuvem | Uma API paga disfarçada ou fallback automático de cobrança |
| Um cérebro por tarefa e um executor ativo por vez | Um enxame autônomo ou uma terceira IA planejadora |

## Requisitos

| Item | Como conseguir |
| --- | --- |
| **Node.js 22.12+** e **Git** | [nodejs.org](https://nodejs.org) (ou `brew install node`) |
| **Claude Code CLI 2.1.280+** com assinatura Pro/Max | `npm install -g @anthropic-ai/claude-code`, depois `claude` e `/login`. Já tem? `claude update` |
| **Codex CLI** com conta ChatGPT (Plus/Pro) | `npm install -g @openai/codex`, depois `codex login` |

As extensões do VS Code não colocam as CLIs no PATH: instale as CLIs mesmo que já use as extensões. Confira com `claude --version` e `codex --version`.

Você pode usar só uma das duas contas, mas o objetivo do projeto é combinar as duas.

## Instalação rápida

**Opção 1 — clonar e linkar (recomendado; fácil de atualizar):**

```bash
git clone https://github.com/vitorvnascimento/duo-orchestrator.git
cd duo-orchestrator
npm ci          # instala só typescript e @types/node e compila
npm link        # coloca o comando duo no PATH
duo --version
```

Para atualizar depois: `git pull && npm ci`. Para rodar os testes offline (nenhum modelo é invocado): `npm test`.

**Opção 2 — pacote pronto da release (sem compilar):**

```bash
npm install -g https://github.com/vitorvnascimento/duo-orchestrator/releases/download/v0.2.0/duo-orchestrator-0.2.0.tgz
duo --version
```

Ou baixe com o GitHub CLI e instale o arquivo local:

```bash
gh release download v0.2.0 -R vitorvnascimento/duo-orchestrator -p "*.tgz"
npm install -g ./duo-orchestrator-0.2.0.tgz
```

Sem `npm link` ou instalação global, use `node /caminho/duo-orchestrator/dist/src/cli/main.js` no lugar de `duo`. **Remover:** `npm uninstall -g duo-orchestrator` (ou `npm unlink -g duo-orchestrator`).

### Atualizações

O `duo` avisa quando sai uma versão nova: no máximo uma vez por dia, em segundo plano, ele consulta a última release pública deste repositório no GitHub e, se houver versão mais nova, mostra no terminal (stderr, sem atrapalhar saídas `--json`):

```text
duo: nova versão 0.3.0 disponível (instalada: 0.2.0). Novidades: https://github.com/vitorvnascimento/duo-orchestrator/releases/tag/v0.3.0
     Atualize com: duo update --apply   (desligar aviso: DUO_NO_UPDATE_CHECK=1)
```

- `duo update` consulta na hora; `duo update --apply` instala a nova versão (`npm install -g` do `.tgz` oficial da release).
- A consulta é anônima: não envia token, login, e-mail nem variáveis de ambiente, e só aceita uma release estável deste repositório com o `.tgz` esperado. Nada é instalado sem você pedir.
- Não consulta dentro dos executores, em CI, no sandbox do Codex nem com `DUO_NO_UPDATE_CHECK=1`.
- Só o mantenedor publica releases; o repositório é público para leitura e uso.

> `npm install -g github:vitorvnascimento/duo-orchestrator` **não** é recomendado: nesse modo o npm 10 não prepara corretamente pacotes que precisam compilar. Use uma das opções acima.

## Primeiro uso (5 minutos)

**1. Ative num projeto** (precisa ser um repositório Git):

```bash
cd ~/meu-projeto
duo init            # mostra o que vai criar, sem gravar nada
duo init --apply    # cria .duo/config.json e as skills do Claude e do Codex
```

Isso cria `.claude/skills/duo-delegate/`, `.agents/skills/duo-delegate/` e `.duo/config.json`, e adiciona `.duo/` ao `.gitignore`. Se `duo` estiver no PATH, as skills chamam só `duo`, e o projeto funciona em qualquer máquina com o duo instalado.

**2. Revise `.duo/config.json`:**

- `acceptance.allowedCommands`: comandos que a ponte pode rodar para conferir o trabalho, como `[["npm","test"]]`. Se o projeto tem `npm test`, ele já vem configurado.
- `billing.acknowledgeUnverifiableExtraUsage`: **trava de proteção**. Nenhuma CLI informa se o uso extra ou os créditos estão ligados na sua conta. Confira nas configurações do claude.ai e do ChatGPT e, estando desligado (ou sendo algo que você aceita), mude para `true` a conta que vai receber delegações. Enquanto estiver `false`, a delegação para aquela conta fica bloqueada. Detalhes em [docs/autenticacao.md](docs/autenticacao.md).

```json
"billing": { "profile": "subscription-only", "acknowledgeUnverifiableExtraUsage": { "claude": true, "codex": true } }
```

**3. Confira:**

```bash
duo doctor    # as duas direções devem aparecer como "pronto"
duo models    # modelos disponíveis nas suas contas (não consome cota)
```

**4. Use.** Abra o projeto no VS Code e peça ao Claude Code:

```text
/duo-delegate adicione a função formatarPreco em src/preco.js com testes, e crie um ícone de carrinho em assets/carrinho.png
```

Ou peça ao Codex, invocando a skill pelo nome:

```text
$duo-delegate revise src/auth/ procurando falhas de segurança
```

Quando o cérebro pedir permissão para rodar `duo delegate`, aprove esse comando. A parte delegada leva de 30 segundos a 2 minutos. No Codex, ele pede para rodar fora do sandbox, porque precisa de rede e do login do Claude.

**5. Acompanhe:** `duo status` (o que foi delegado), `duo report` (tempo, tokens e a origem de cada número).

## Uso no dia a dia

- **Deixe a escolha com a evidência:** sem nomear modelos, o cérebro consulta `duo recommend`, que escolhe pelo histórico verificado do seu projeto e pelas capacidades (arte só vai para modelos que geram imagem). Ao omitir `model` no pedido, a seleção adaptativa escolhe dentro do `executor` já pedido e registra `tier`, `effort` e `selection`. Num projeto novo, a primeira escolha é por julgamento e melhora com o uso.
- **Ou force a escolha:** *"use Opus 5.5 no código e GPT-6-Astra na arte"*. `model` e `effort` explícitos são preservados; `complexity` (`light`, `standard` ou `deep`) indica o nível inicial, sujeito aos pisos; `adaptive: false` ou `duo delegate --no-adaptive` restaura o comportamento pré-adaptativo. O modelo precisa existir na conta (`duo models`).
- **Revisão cruzada:** *"implemente X e peça ao Codex para revisar"*. A revisão roda em modo somente leitura.
- **Trocar o cérebro no meio do trabalho:** `duo handoff --to codex --next "..."` gera um documento em `.duo/handoffs/` para abrir na outra IA.
- **Outro computador:** instale o duo (Opção 1 ou 2), faça login nas duas CLIs e pronto. Se o projeto já tem as skills versionadas e o `duo` está no PATH, não precisa rodar `init` de novo.

Dicas:
- No Codex com muitas skills instaladas, ele pode não achar a skill sozinho ("Exceeded skills context budget"). Invoque `$duo-delegate` explicitamente.
- Não edite os arquivos do escopo enquanto o executor roda: a ponte detecta a mudança e reprova a tarefa.
- Em páginas HTML abertas direto do disco no Safari, imagens em pastas acima da página não carregam. Deixe o HTML na raiz e as imagens em subpastas.

## Windows (não testado)

A ponte executa processos **sem shell**. Shims `.cmd` (como o `claude.cmd` do npm) exigiriam shell, então a ponte os recusa. Use o `.exe` oficial (o instalador nativo do Claude Code gera `claude.exe`) ou configure em `.duo/config.json`:

```json
{ "executors": { "claude": { "command": ["C:\\Users\\voce\\.local\\bin\\claude.exe"] },
                 "codex":  { "command": ["node", "C:\\caminho\\para\\@openai\\codex\\bin\\codex.js"] } } }
```

O código foi escrito para ser portável (`taskkill /T /F` para encerrar processos), mas os testes rodaram apenas no macOS. Relatos e correções são bem-vindos.

## Comandos

| Comando | O que faz |
| --- | --- |
| `duo doctor [--json]` | Diagnóstico sem inferência: versões, flags suportadas (lidas do `--help`), método de autenticação pelo status oficial, conflitos de cobrança, hooks/MCP, outros coordenadores. |
| `duo init [--brain claude\|codex] [--apply] [--overwrite]` | Config e skills do projeto com preview/diff e backup. |
| `duo delegate --request <arquivo> [--no-adaptive]` | Executa um pedido do cérebro (formato em `schemas/delegation-request.schema.json`). Imprime um JSON final; `--no-adaptive` desliga a seleção adaptativa desta execução. |
| `duo delegate --resume <taskId> [--timeout-sec N]` | Retoma uma task `blocked` (timeout, interrupção, cota, login…), reutilizando a sessão nativa; `--timeout-sec` dá mais tempo à retomada. |
| `duo models [--refresh] [--json]` | Modelos disponíveis nas contas conectadas (Claude e Codex), com nível, esforços, uso extra, origem, recomendado/legado do fornecedor, sucessor e aposentadoria, ferramentas (ex.: geração de imagem) e a fonte usada. Sem inferência; cache de 6 h por versão das CLIs (1 h se alguma fonte estiver degradada). |
| `duo recommend [--request <pedido.json>] [--kind …] [--needs image_generation] [--paths …] [--risk …] [--brain …] [--brain-model …]` | Recomendação determinística por evidência, capacidade e disponibilidade. A saída inclui `tier`, `effort` e `selection`, além do executor/modelo, ou indica fazer você mesmo. `--request` fornece objetivo, escopo e aceite reais. |
| `duo status [--run-id]` | Runs e tasks. Detecta interrupções (ponte morta) e marca como `blocked`. |
| `duo report [--run-id] [--json]` | Relatório determinístico com a origem de cada número. |
| `duo cancel --run-id <id>` | Encerra ponte e executor (árvore de processos) e marca `cancelled`. |
| `duo apply --task-id <id>` | Integra o patch de uma task `worktree`, só se a base não mudou. |
| `duo accept --task-id <id> [--reject] --note "..."` | Registra a decisão do cérebro (tarefas aceitas entram na métrica). |
| `duo handoff --to <cliente>` | Documento de handoff para trocar o cérebro. |
| `duo quota show` / `duo quota set …` / `duo quota refresh` | Estado observado por conta, registro manual e leitura do Codex via app-server. |
| `duo update [--apply]` | Procura nova versão (release pública, sem credenciais) e, com `--apply`, instala. |

Códigos de saída de `delegate`: `0` succeeded, `1` failed, `2` pedido inválido, `3` blocked, `4` cancelled.

## Vários modelos, o melhor para cada parte

A ponte não se limita a "Claude ou Codex": ela trabalha com **modelos**.

- **`duo models`** descobre o que as contas conectadas oferecem, sem inferência. No Claude, usa o handshake `initialize` (o mesmo do `supportedModels()` do Agent SDK). No Codex, usa o `model/list` e o `modelProvider/capabilities/read` do `codex app-server`, métodos da superfície estável do protocolo que a extensão do VS Code usa. Se uma fonte falhar ou mudar de formato, a ponte cai para a seguinte: `codex debug models`, depois o último catálogo bom (marcado como desatualizado), depois `routing.candidates`. O `duo doctor` confere o contrato do protocolo localmente e avisa antes de algo quebrar. Exemplo de conta: Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 4.5 e outros no Claude; GPT-6.1-Sol, GPT-6-Astra, GPT-6-Sol, GPT-6-Luna e a família 5.x no Codex, além da ferramenta **`image_generation`**.
- **Cada subtarefa declara o que exige:** `kind: "asset"` + `needs: ["image_generation"]` para arte. O roteador só considera modelos com essa capacidade.
- **Qualquer modelo, qualquer cérebro:** a delegação pode ir para o **mesmo cliente com outro modelo** (ex.: cérebro GPT-6-Sol → arte com GPT-6-Astra; cérebro Opus 5.5 → tarefa simples com Sonnet 5). Só é recusado delegar ao mesmo modelo que o cérebro já é.
- **A ponte valida antes e depois:** bloqueia um `model` que não exista na conta (listando os disponíveis) e, em arte, confere a assinatura binária da imagem gravada no escopo (PNG/JPEG/WebP/GIF). Um "completed" sem imagem válida vira `failed`.

### Base da v0.3.0 (fases 1 e 2)

O catálogo registra `cliVersions` e expira após 6 h (1 h degradado). Atualizar qualquer CLI invalida o cache na próxima consulta; `duo models --refresh` força a descoberta. A lista depende da versão instalada: o servidor Codex também filtra por `client_version`.

`duo models` mostra o nível `light`, `standard` ou `deep`, esforços suportados, origem e uso extra. O JSON inclui `tier`, `presumed`, `extraUsage` e `source`. Os níveis padrão seguem famílias: Opus/Fable/Astra → deep; Sonnet/Sol/Terra → standard; Haiku/Luna/Mini/Nano → light. Famílias desconhecidas recebem standard presumido. A primeira regex de `routing.adaptive.tiers` que casar com ID, alias ou nome (sem distinguir caixa) tem precedência.

Modelos das chaves raiz `model` de `~/.codex/config.toml` e `~/.claude/settings.json`, ou de `routing.extraModels` (`["codex:gpt-6.1-sol"]`), aparecem como configurados pelo usuário se a CLI não os listar. IDs e aliases não são duplicados. Esses arquivos são somente lidos; a presença na configuração não confirma disponibilidade na conta.

O pedido pode declarar `"effort": "high"` (`low|medium|high|xhigh|max`). Claude recebe `--effort high`; Codex recebe `--config model_reasoning_effort="high"`. A ponte bloqueia antes de executar se a CLI não anunciar a flag. Sem `effort` explícito e com a seleção adaptativa desligada, o argv é o mesmo da 0.2.0; com ela, a ponte pode usar o esforço retornado por `selection`. O esforço pedido fica registrado na task; tasks antigas continuam válidas.

`duo models` e `duo doctor` consultam anonimamente as versões publicadas das CLIs no npm (cache `.duo/cli-latest.json`, 6 h, timeout 5 s), e sugerem atualização quando necessário. Nunca instalam nada. Sem rede não há aviso novo. Desative com `DUO_NO_UPDATE_CHECK=1` ou `discovery.checkCliUpdates=false`; a consulta também é desligada em executores (`DUO_DEPTH`), CI e sandbox Codex. `doctor` mostra versão instalada/publicada e suporte a `--effort`/`--config`.

Os novos defaults, mesclados em configs antigas, são:

```json
{
  "discovery": { "checkCliUpdates": true },
  "routing": {
    "extraModels": [],
    "include": null,
    "adaptive": {
      "enabled": true,
      "tiers": [],
      "lightMaxFiles": 3,
      "maxAttempts": 2,
      "downgradeMinSuccess": 0.85,
      "quotaWarnPercent": 90
    }
  }
}
```

`selectEffort` prefere low/medium/high por nível (xhigh na escalada), ou o esforço suportado imediatamente acima; retorna null sem opção adequada. `extraUsage` marca contexto `[1m]`, créditos ou preços na descrição.

### Fase 2 — seleção adaptativa

`duo recommend` passa `tier`, `effort` e `selection` para a decisão. Use `--request <pedido.json>` para fornecer objetivo, escopo e comandos de aceite reais; com `--kind` sem aceite, o piso é `standard`. Quando o pedido informa `executor` e omite `model`, a ponte escolhe automaticamente dentro daquele executor; nunca troca o executor solicitado. `model`, `effort`, `complexity` (`light|standard|deep`) e `adaptive: false` forçam o comportamento indicado. A CLI também aceita `duo delegate --no-adaptive`.

Os pisos são aplicados ao modelo efetivo, inclusive escolhas explícitas, configuração do executor e retomadas: risco alto ou sensível exige `deep`; `light` só vale para risco baixo, poucos arquivos, sem diretório no escopo e com comandos de aceite. Modelo incompatível, padrão desconhecido ou nível presumido sob piso `deep`, ou `effort` explícito abaixo de `high` nesse piso, bloqueiam antes de executar. Capacidade (inclusive geração de imagem) e nível precisam ser satisfeitos juntos. Um downgrade só ocorre com evidência suficiente e sucesso igual ou superior a `routing.adaptive.downgradeMinSuccess`, respeitando os pisos. Falha de verificação escala `light → standard → deep`; `maxAttempts` conta a primeira tentativa, e `deep` pode usar `xhigh` quando suportado. `model` explícito não troca; `effort` explícito permanece, e sem ele a escalada só aumenta o esforço quando houver suporte.

Cada tentativa em `worktree` recebe um worktree novo e mantém o anterior para inspeção. Em `in-place`, só há nova tentativa se o executor não deixou alterações. Falhas de infraestrutura não escalam. Uso extra só entra com `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` e o modelo incluído em `routing.include`. Na fase 3, cota esgotada pode trocar o executor/modelo por um equivalente de nível igual ou superior, refazendo todos os gates; nunca reduz o nível.

`request.json` conserva o pedido original; `invocation.json` registra comando/argumentos resolvidos e `selection.origin` distingue escolhas explícitas das automáticas. Retomadas mantêm escolhas automáticas elegíveis para escalada, o contador da cadeia mesmo antes da base e o esforço mínimo já alcançado. Fallback procura um destino que sustente esse esforço ou bloqueia. A cadeia compartilha o hash do pedido original; repetir `taskKey` no mesmo run reutiliza o sucesso final, sem ser ocultado por um ancestral bloqueado.

Exemplo validado com as CLIs reais (E2E A1): pedido de arte ao `codex` com `model: "gpt-6-astra"` gerou `assets/mascot.png` (PNG 1254×1254), verificado pela ponte.

### Cota e continuidade (fase 3)

`duo quota refresh` força uma descoberta pelo catálogo e consulta `account/rateLimits/read` na mesma sessão do app-server do Codex. Não usa API própria, não consome créditos e não invoca modelos. O Claude fornece `rate_limit_event` ao executar; sem porcentagem nativa, o uso restante é desconhecido. `duo quota set --provider claude --used-percent 92 --resets-at <ISO8601>` registra uma observação manual. `duo quota show` mantém o formato anterior e acrescenta `state` com status, fonte, uso, reset e modelos afetados, além de `remainingPercent` (null quando desconhecido). `duo recommend` mostra a saúde de cota.

`.duo/quota-state.json` guarda somente `status`, `usedPercent`, `resetsAt`, `observedAt`, `source` e `affectedModels`, sob `claude`/`codex` (uma conta ativa por CLI). E-mail, ID de conta, plano, créditos e tokens não são guardados. Estado passa a `unknown` após o reset, ou após 6 h sem reset. Não há estimativa inventada de quanto resta quando a CLI não fornece porcentagem.

Com uso ≥ `routing.adaptive.quotaWarnPercent` (90 por padrão), candidatos daquela conta perdem 0,15 no score para tarefas `light`/`standard`; `deep` não recebe essa penalidade. Cota esgotada bloqueia a conta, ou somente os modelos explicitamente identificados por um mapeamento inequívoco do catálogo. A porcentagem observada é o maior uso entre as janelas; o reset de limites bloqueantes é o último reset conhecido. Se faltar reset de algum limite bloqueante, o reset é desconhecido.

Se a cota acabar durante uma task adaptativa, a ponte tenta primeiro outros modelos do mesmo fornecedor quando o limite for específico, depois o outro fornecedor, sempre no nível da tentativa ou acima. Cada fallback conta em `maxAttempts` e nos limites de política do run, mantém a task original retomável e registra a cadeia em `selection.fallbacks`. O prompt da ponte é neutro; sandbox e permissões continuam próprios de cada executor. `model` explícito pode ser substituído **somente neste fallback de cota**; `effort` explícito continua sujeito ao suporte do destino. Sem equivalente, com trabalho alterado in-place ou se o destino for o próprio cérebro/modelo, retorna `blocked`. `adaptive: false` continua registrando cota, sem fallback automático.

Para um proxy local que usa sua assinatura, habilite explicitamente `billing.allowLoopbackProxy: true` (padrão `false`). A exceção aceita somente HTTP/HTTPS em `127.0.0.1`, `localhost` ou `[::1]` nas settings/config do cliente. No Codex exige também `requires_openai_auth = true`, sem chaves de credencial no provedor customizado. `ANTHROPIC_BASE_URL` do ambiente do processo continua removido. `duo doctor` mostra a autorização ou a dica para habilitar a opção. O proxy local pode ver o tráfego e o token de sessão; veja [SECURITY.md](SECURITY.md).

## Escolha do executor: evidência, não marca

A skill conduz o cérebro por um procedimento explícito: entender e decompor a tarefa, classificar risco e acoplamento, escolher o executor, montar o contexto mínimo, verificar e registrar a decisão. Para escolher o executor, o cérebro consulta `duo recommend`, que é determinístico e não chama IA:

- **Evidência:** tarefas comparáveis deste projeto (mesmo `kind` e mesma linguagem, com recuo para buckets mais amplos quando faltam amostras). Contam o sucesso verificado pela ponte, os testes de aceite, a penalidade para quem declarou sucesso e reprovou, e as rejeições do cérebro (`duo accept --reject`). Falhas de login, cota ou timeout **não** contam contra o modelo.
- **Eficiência:** em empate técnico, vence o menor tempo mediano.
- **Disponibilidade:** CLI instalada, login por assinatura, ciência de uso extra e limite observado.
- **Decisão:** `DELEGAR` ao melhor candidato (com o modelo), `FAZER VOCÊ MESMO` quando o melhor histórico é do próprio cliente do cérebro, ou `JULGAMENTO` quando a evidência é insuficiente (mínimo configurável; em baixo risco, sugere explorar para gerar evidência).
- **Candidatos** (`routing.candidates`): por padrão Claude `claude-opus-5-5` e o modelo padrão da conta no Codex; dá para adicionar outros, como `sonnet`. Preferências pessoais só entram como `routing.priors`, com bônus limitado a ±0,2 e sempre identificado.

Validado com as CLIs reais (E2E T12/T13): com histórico favorável ao Claude, o Claude cérebro decidiu **fazer ele mesmo** e o Codex cérebro **delegou ao Claude**.

## Como uma delegação é verificada

1. **Pedido**: validado pelo schema. O executor pode ser o mesmo cliente com outro modelo, mas não o próprio modelo do cérebro; o cérebro é fixo dentro de um run.
2. **Política** (`economico` por padrão): motivo da delegação compatível com a política, até **2 invocações por run** (incluindo correção) e preferência de cota.
3. **Escopo**: só caminhos relativos, sem `..`, sem symlinks, fora da lista de negação (`.env`, chaves, `.git`, `.duo`…).
4. **Compatibilidade**: flags obrigatórias precisam aparecer no `--help` da versão instalada.
5. **Autenticação**: variáveis de API/gateway são removidas do ambiente do executor, configurações como `apiKeyHelper` ou provedores customizados bloqueiam a execução (exceto proxy loopback explicitamente autorizado), e o método efetivo precisa ser confirmado como assinatura pelo status oficial.
6. **Lock**: um executor ativo por projeto.
7. **Execução**: prompt pela stdin, argumentos separados, sem shell, com timeout, limite de saída e encerramento da árvore de processos.
8. **Verificação independente**: arquivos realmente alterados (por hash), violações de escopo, diff apenas do delta do executor, divergência entre o que o executor declarou e o que fez, base alterada e comandos de aceite executados pela ponte.

Um "completed" do modelo com teste falhando vira `failed`. Nada é revertido automaticamente: a ponte nunca usa `reset --hard`, `clean` ou `stash`.

## Estado local

```text
.duo/
  config.json
  runs/<runId>/run.json
  runs/<runId>/tasks/<taskId>/{task.json, request.json, prompt.txt, invocation.json, events.jsonl, stderr.txt, changes.diff|changes.patch, snapshot/}
  telemetry.jsonl   quota.json   quota-state.json   lock.json   handoffs/   backups/   worktrees/
```

Todo arquivo persistido passa por redação de segredos. O texto de raciocínio (`reasoning` do Codex e `thinking` do Claude) não é gravado.

## Estado da validação

| Item | Situação |
| --- | --- |
| Código, testes e documentação | Implementados |
| 424 testes offline das fases 1–3 (adaptadores com CLIs simuladas, fluxo completo, roteador, catálogo de modelos com fallbacks, arte, CLI como processo real, encerramento de árvores de processos, redação de segredos) | **Passando**, sem processos órfãos |
| `duo doctor` real | Claude 2.1.114 e Codex 0.157.1 autenticados por assinatura, com todas as flags obrigatórias presentes |
| Bateria E2E real ([docs/e2e-real.md](docs/e2e-real.md)) | **16/16** numa execução completa do zero com Opus 5.5 (antes, 13/13 e 11/11): revisão read-only nos dois sentidos, aceite impossível, tentação fora do escopo, timeout + retomada (Codex e Claude), cancelamento, worktree + apply, recursão bloqueada, roteamento por evidência nos dois sentidos, **arte real com GPT-6-Astra** e **tarefas com modelos diferentes por parte** (Opus 5.5 no código + GPT-6-Astra na arte), com Claude ou Codex como cérebro |
| Cérebro nativo usando a skill | **Validado em modo headless**: `claude -p "/duo-delegate …"` → Codex e `codex exec "$duo-delegate …"` → Claude, ambos `succeeded` |
| Cota esgotada e violação de escopo com executor real | **Não exercitados**: os executores reais respeitaram o escopo e não houve cota esgotada; os dois casos seguem cobertos só pelos testes offline |
| Extensões do VS Code (painel interativo) | **Não exercitado**: os cérebros rodaram pelas CLIs em modo headless; as skills e os comandos são os mesmos, mas as aprovações interativas não foram testadas |
| Windows | Código portável escrito; **não testado** |

Detalhes em [docs/compatibilidade.md](docs/compatibilidade.md).

## Limitações conhecidas

- O executor Codex pode **ler** qualquer arquivo legível pelo usuário: o sandbox restringe escrita e rede, não leitura. O executor Claude tem regras de negação para caminhos protegidos, mas elas são aplicadas pelo cliente, não pelo sistema operacional.
- Lock, `DUO_DEPTH` e listas de negação de comandos são barreiras **cooperativas**. As barreiras impostas são o sandbox do Codex, as permissões `dontAsk`/`--tools` do Claude e a verificação posterior feita pela ponte (veja [SECURITY.md](SECURITY.md)).
- Cotas: o Claude Code emite no stream um `rate_limit_event` (janela, reset, uso extra), que a ponte registra como observação nativa **após** cada execução. O Codex não emite nada equivalente no `exec --json`; o `codex app-server` é usado para descobrir modelos e, durante a descoberta ou `duo quota refresh`, ler limites via `account/rateLimits/read`. Sem observação, o relatório mostra o registro manual ou "não disponível".
- O executor carrega a configuração do usuário do cliente: no Claude, hooks e plugins do usuário (ex.: claude-mem); no Codex, skills, plugins e MCPs do `~/.codex`. Num ambiente com muitos plugins, isso levou a 142 mil tokens de entrada no Codex para uma tarefa trivial. Por isso, o executor Codex roda por padrão com `--disable hooks --disable plugins` (`executors.codex.disableUserExtensions`), depois de os hooks de um plugin (Ruflo) gravarem arquivos no projeto durante uma delegação real. `executors.codex.ignoreUserConfig: true` pode reduzir o consumo, mas **não foi testado** com a CLI real (muda também o modelo padrão).
- O modelo efetivo depende da versão da CLI: com `model: "opus"` no settings, o `claude` 2.1.114 usava `claude-opus-4-7`. Por isso o executor pede `claude-opus-5-5` explicitamente (CLI atualizada para 2.1.283). O modelo real fica registrado em cada task, e a ponte alerta se ele diferir do pedido.
- O roteador aprende só com o histórico **deste projeto**: num projeto novo, a recomendação começa como "julgamento". O desempenho do cérebro quando ele faz a tarefa sozinho não é medido; conta como evidência do mesmo cliente apenas o seu histórico como executor.
- Não há interface oficial para verificar se créditos ou uso extra estão ativos nas contas; por isso existe a confirmação explícita.
- Arquivos ignorados pelo Git e fora do escopo (ex.: `node_modules/`) não entram na detecção de mudanças.
- Comandos de aceite rodam sem as variáveis de API/gateway no ambiente (mesma limpeza do executor); testes que dependem delas vão falhar.
- Em modo `worktree`, os comandos de aceite rodam no worktree, onde dependências não versionadas (ex.: `node_modules`) podem estar ausentes.
- Com o Codex como cérebro em modo headless, a execução de `duo delegate` fora do sandbox foi aprovada pelo revisor automático (`--approve-for-me`). No VS Code interativo, quem aprova é você.

## Documentação

- [docs/autenticacao.md](docs/autenticacao.md): login oficial, perfil subscription-only e uso extra.
- [docs/compatibilidade.md](docs/compatibilidade.md): matriz observada.
- [docs/decisoes.md](docs/decisoes.md): decisões técnicas e referências consultadas.
- [docs/avaliacao.md](docs/avaliacao.md): como medir se a delegação realmente ajuda.
- [docs/e2e-real.md](docs/e2e-real.md): bateria E2E com as CLIs reais (consome cota), cenários, critérios e resultados.
- [SECURITY.md](SECURITY.md): modelo de ameaças e o que é imposto versus cooperativo.
- [examples/](examples/): pedidos nos dois sentidos, uma tarefa sem delegação e uma revisão cruzada.

## Provas de qual modelo executou

Cada tarefa delegada ao Codex registra, a partir do rollout da própria sessão do Codex, o modelo efetivo, o provedor, os IDs de resposta do servidor (`resp_…`), as ferramentas chamadas e o SHA-256 das imagens geradas pela ferramenta de imagem. Se o modelo efetivo diferir do pedido, a tarefa mostra um alerta. No Claude, o modelo vem do próprio stream (`system/init` e `modelUsage`). Veja `evidence` no JSON devolvido por `duo delegate`.

## Contribuindo

Issues e pull requests são bem-vindos. Antes de enviar: `npm ci && npm test` (tudo offline). A bateria real (`tests/e2e/real-e2e.mjs`) e o teste de qualidade (`tests/e2e/quality-test.mjs`) consomem cota das suas assinaturas e só rodam com `--confirm-quota`.

## Licença

[MIT](LICENSE).

## Evoluções possíveis

Painel próprio no VS Code, adaptador opcional para o Codex App Server (sessões, aprovações, limites) após validar maturidade, recomendação de cérebro antes de começar, e paralelismo com múltiplos worktrees. Nada disso deve introduzir login próprio de assinatura.
