# ClaudeGPT - Duo Orchestrator by Fusic

**English** · [Português](#português)

**Claude Code and Codex working together in your VS Code, each part of the task handled by the model best suited to it, using the official CLIs and your own subscriptions.**

**ClaudeGPT - Duo Orchestrator by Fusic** (`duo-orchestrator`) is a local bridge that lets **Claude Code** and **OpenAI Codex** work together through their official CLIs and your own subscriptions (no API keys; optional user-authorized loopback proxy). You talk normally to Claude Code (or Codex). When a task has different parts, such as code and an illustration, the agent you opened (the **brain**) uses the `duo-delegate` skill to send each part to the best available model in your connected accounts: Opus 5.5 for code and GPT-6-Astra for art, for example. The `duo` bridge runs the executor's CLI and **independently verifies the result** (changed files, scope, diffs, acceptance tests and valid images) before returning it to the brain. It records which model actually ran, reading Codex's own session log. Install with `git clone … && npm ci && npm run build && npm link` (or the release `.tgz`), run `duo init --apply` inside a Git project, and use `/duo-delegate` in Claude Code or `$duo-delegate` in Codex. Documentation is available in English and Portuguese.

```text
You: "/duo-delegate build the home page and a robot illustration at assets/robo.png"

Claude (Opus 5.5, brain)  ── writes the HTML/CSS
          │
          └─ duo delegate ──▶ Codex (GPT-6-Astra) ── generates assets/robo.png
                               │
                               └─ bridge checks: only assets/ changed, valid 1254×1254 PNG,
                                  effective model gpt-6-astra (from Codex's own session log)
```

> **Status (November 7, 2026):** **v0.4.0 is the latest public release.** Its macOS release gate passed: real quality test **100/100**, real E2E battery **17/17** (including four real Codex executors at once) and offline suite **680/680**, with independent Claude and Codex adversarial reviews leaving no blocker ([docs/e2e-real.md](docs/e2e-real.md), [docs/evidencias/](docs/evidencias/)). On Windows the offline suite passed (**646 passed, 0 failed, 12 skipped**) on an earlier v0.4.0 build; real E2E has not run there, and Linux remains untested.

## What the project is and is not

| It is | It is not |
| --- | --- |
| A local bridge calling the official `codex exec` and `claude -p` | A gateway reusing tokens to call private endpoints |
| Individual use, each client with its own official login | A service offering subscription login to third parties |
| A `subscription-only` profile that blocks API, gateway and cloud access | A disguised paid API or automatic billing fallback |
| One brain per run and up to four isolated executors per project | An autonomous swarm or a third planning AI |

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
git clone https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator.git duo-orchestrator
cd duo-orchestrator
npm ci          # install development dependencies
npm run build   # compile explicitly, even if prepare was blocked
npm link        # make the duo command available on PATH
duo --version
```

To update later, run these commands in the cloned duo installation directory (also on Windows):

```bash
git pull
npm ci
npm run build
npm link
duo --version
```

Recent npm versions may block automatic install scripts, including `prepare` in some installation modes. Run `npm run build` explicitly after `git pull`; `npm link` links the local package and its `duo` command globally. Keep npm's script protections enabled ([npm link](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-link.md), [npm script approval](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-approve-scripts.md)). To run the offline tests (no model is invoked): `npm test`.

**Option 2 — prebuilt release package (no compilation):**

These downloads remain **v0.3.1**, the latest published version. There is no published v0.4.0 download yet.

```bash
npm install -g https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator/releases/download/v0.3.1/duo-orchestrator-0.3.1.tgz
duo --version
```

Or download with the GitHub CLI and install the local file:

```bash
gh release download v0.3.1 -R vitorvnascimento/ClaudeGPT-Duo-Orchestrator -p "*.tgz"
npm install -g ./duo-orchestrator-0.3.1.tgz
```

Without `npm link` or a global installation, use `node /caminho/duo-orchestrator/dist/src/cli/main.js` instead of `duo`. **Removal:** `npm uninstall -g duo-orchestrator` (or `npm unlink -g duo-orchestrator`).

### Updates

`duo` notifies you when a new version is released: at most once a day, in the background, it checks this repository's latest public GitHub release and, if a newer version exists, prints a terminal message (stderr, without interfering with `--json` output):

```text
duo: nova versão 0.3.1 disponível (instalada: 0.3.0). Novidades: https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator/releases/tag/v0.3.1
     Atualize com: duo update --apply   (desligar aviso: DUO_NO_UPDATE_CHECK=1)
```

- `duo update` checks immediately; `duo update --apply` installs the new version (`npm install -g` using the official release `.tgz`).
- The check is anonymous: it sends no token, login, email or environment variables, and only accepts a stable release from this repository with the expected `.tgz`. Nothing is installed unless you request it.
- It does not check inside executors, in CI, in the Codex sandbox or with `DUO_NO_UPDATE_CHECK=1`.
- Only the maintainer publishes releases; the repository is public for reading and use.

> `npm install -g github:vitorvnascimento/ClaudeGPT-Duo-Orchestrator` is **not** recommended: installing directly from GitHub depends on automatic preparation of a package that requires compilation. Use the explicit build above or the published release package.

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

### When Claude has no quota

Open Codex as the brain and delegate independent work to another Codex model. Merge this field at the **root of the target project's `.duo/config.json`**, alongside `limits` and `routing`:

```json
{ "quotaPreference": "preserve-claude" }
```

In each delegation request, use `"brain": "codex"`, `"brainModel": "gpt-6-astra"` (replace with the brain's actual model), `"executor": "codex"` and an explicitly different `"model": "gpt-6.1-sol"`, available in your account. `quotaPreference` belongs in the project config, not inside `routing`, `billing` or the request. Delegating to the brain's own model is rejected. A run's brain is fixed: continue an existing Codex run or create a new Codex run with one initial request omitting `runId`; do not change a Claude run into a Codex run. The parallel example below uses this setup and `adaptive: false` to keep the executor choice explicit without automatic quota fallback.

Tips:
- In Codex with many installed skills, it may not find the skill on its own ("Exceeded skills context budget"). Invoke `$duo-delegate` explicitly.
- Do not edit scoped files during in-place execution. With worktrees, edits to files touched by the patch invalidate the base; other in-scope edits produce a warning.
- For HTML pages opened directly from disk in Safari, images in folders above the page do not load. Keep the HTML at the root and images in subfolders.

## Windows

The user reported an offline run with **646 passed, 0 failed and 12 skipped (658 total)**. This is a prior report, not a new run or a real E2E validation on Windows.

For a clone installation, use `npm link` and run `npm run build` explicitly after every `git pull`, following the update commands above: recent npm versions may block `prepare`. Edit **the target project's `.duo/config.json`**, not the duo installation's config, to set executor paths.

The bridge runs processes **without a shell**. For npm-generated `.cmd` shims with a single supported, existing target inside the `node_modules` directory beside the shim, the bridge reads the shim and executes the target directly: `.js`/`.cjs`/`.mjs` via the current Node.js executable, or `.exe` directly. Unknown or ambiguous shims, or those with targets outside that directory or otherwise unsupported, remain rejected. In those cases, configure the official `.exe` (Claude Code's native installer creates `claude.exe`) or an explicit `["node", "<script.js>"]` command in `.duo/config.json` as a fallback:

```json
{ "executors": { "claude": { "command": ["C:\\Users\\voce\\.local\\bin\\claude.exe"] },
                 "codex":  { "command": ["node", "C:\\caminho\\para\\@openai\\codex\\bin\\codex.js"] } } }
```

Worktrees share the existing `node_modules` directory through a **directory junction** (`limits.worktreeLinks` defaults to `["node_modules"]`), normally without administrator rights or Developer Mode. Ordinary symlinks, including file links, can still require administrator rights or Developer Mode; tests requiring them may be skipped when unavailable. Junction support does not make arbitrary symlinks valid scope paths. Prepare dependencies before launching executors; link failures are reported as limitations. Process termination uses `taskkill /T /F`.

## Commands

| Command | What it does |
| --- | --- |
| `duo doctor [--json]` | Diagnostics without inference: versions, supported flags (read from `--help`), authentication method from official status, billing conflicts, hooks/MCP and other coordinators. |
| `duo init [--brain claude\|codex] [--apply] [--overwrite]` | Project config and skills with preview/diff and backup. |
| `duo delegate --request <arquivo> [--no-adaptive]` | Executes a brain request (format in `schemas/delegation-request.schema.json`). Prints final JSON; `--no-adaptive` disables adaptive selection for this execution. |
| `duo delegate --resume <taskId> [--timeout-sec N]` | Resumes a `blocked` task (timeout, interruption, quota, login…), reusing the native session; `--timeout-sec` gives the resumed execution more time. |
| `duo models [--refresh] [--json]` | Models available in connected accounts (Claude and Codex), with tier, efforts, extra usage, origin, vendor recommended/legacy status, successor and retirement, tools (e.g. image generation) and the source used. No inference; 6 h cache per CLI version (1 h if any source is degraded). |
| `duo recommend [--request <pedido.json>] [--kind …] [--needs image_generation] [--paths …] [--risk …] [--brain …] [--brain-model …]` | Deterministic recommendation based on evidence, capability and availability. Output includes `tier`, `effort` and `selection`, plus executor/model, or indicates doing it yourself. `--request` provides the actual objective, scope and acceptance criteria. |
| `duo status [--run-id <id>] [--json]` | Runs, tasks and active executor slots. Detects interruptions (bridge no longer running) and marks tasks `blocked`. |
| `duo report [--run-id] [--json]` | Deterministic report with the source of each number. |
| `duo cancel --run-id <id>` | Terminates bridge and executor (process tree) and marks `cancelled`. |
| `duo apply --task-id <id>` | Integrates a `worktree` task's patch, only if HEAD and the files touched by the patch have not changed. |
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

Minimum tiers apply to the effective model, including explicit choices, executor configuration and resumptions: high or sensitive risk requires `deep`; `light` is only allowed for low risk, few files, no directory in scope and acceptance commands. Confirmation is mandatory before every execution, escalation, fallback and resumption: a `deep` floor requires a fresh catalog, a provider-confirmed model and explicit `high` or higher effort advertised in that catalog. An incompatible model, presumed tier, stale/missing catalog or unknown effort support blocks before execution; refresh with `duo models --refresh`. Every automatic choice, including the configured fallback or CLI default, must confirm extra usage, include/exclude and capabilities; a stale catalog never relaxes these filters. Sensitivity inspection covers all authorized paths, including ignored ones; incomplete inspection requires `deep`. If the executor reports a native model below the floor or unconfirmable under `deep`, the task becomes `failed`, without acceptance, integration or automatic escalation; in Claude, the bridge interrupts on receiving the incompatible init. Capability (including image generation) and tier must both be satisfied. A downgrade only occurs with sufficient evidence and success at or above `routing.adaptive.downgradeMinSuccess`, respecting minimum tiers. Verification failure escalates `light → standard → deep`; `maxAttempts` counts the first attempt, and `deep` may use `xhigh` when supported. Explicit `model` does not change; explicit `effort` remains, and without it escalation only increases effort when supported.

Each `worktree` attempt receives a new worktree and keeps the previous one for inspection. In `in-place` mode, another attempt is allowed only if the executor left no changes. Infrastructure failures do not escalate. Extra usage is allowed only with `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` and the model included in `routing.include`. In phase 3, exhausted quota may switch executor/model to an equivalent at the same or higher tier, repeating all gates; it never lowers the tier.

`request.json` preserves the original request; `invocation.json` records resolved command/arguments and `selection.origin` distinguishes explicit from automatic choices. Resumptions keep automatic choices eligible for escalation, the chain counter even before the base, and the minimum effort already reached. Fallback looks for a destination supporting that effort or blocks. The chain shares the original request hash; repeating `taskKey` in the same run reuses the final success, without a blocked ancestor hiding it.

Example validated with real CLIs (E2E A1): an art request to `codex` with `model: "gpt-6-astra"` generated `assets/mascot.png` (PNG 1254×1254), verified by the bridge.

### Quota and continuity (phase 3)

`duo quota refresh` forces catalog discovery and queries `account/rateLimits/read` in the same Codex app-server session. It uses no custom API, consumes no credits and invokes no models. Claude provides `rate_limit_event` during execution; without a native percentage, remaining usage is unknown. `duo quota set --provider claude --used-percent 92 --resets-at <ISO8601>` records a manual observation. `duo quota show` keeps the previous format and adds `state` with status, source, usage, reset and affected models, plus `remainingPercent` (null when unknown). `duo recommend` shows quota health.

`.duo/quota-state.json` stores only `status`, `usedPercent`, `resetsAt`, `observedAt`, `source` and `affectedModels`, under `claude`/`codex` (one active account per CLI). Email, account ID, plan, credits and tokens are not stored. State becomes `unknown` after reset, or after 6 h without a reset. No estimate of remaining usage is invented when the CLI provides no percentage.

At usage ≥ `routing.adaptive.quotaWarnPercent` (90 by default), candidates from that account lose 0.15 in score for `light`/`standard` tasks; `deep` receives no such penalty. Exhausted quota blocks the account, or only models explicitly identified through an unambiguous catalog mapping. The observed percentage is the highest usage across windows; blocking limits reset at the latest known reset. If any blocking limit lacks a reset, reset is unknown.

If quota runs out during an adaptive task, the bridge first tries other models from the same provider when the limit is model-specific, then the other provider, always at the attempt's tier or above. Each fallback counts toward `maxAttempts` and the run's policy limits, keeps the original task resumable and records the chain in `selection.fallbacks`. The bridge prompt is neutral; sandbox and permissions remain specific to each executor. Explicit `model` may be replaced **only in this quota fallback**; explicit `effort` remains subject to destination support. Without an equivalent, with changes left in-place or if the destination is the brain's own client/model, it returns `blocked`. `adaptive: false` still records quota, without automatic fallback.

For a local proxy using your subscription, explicitly enable `billing.allowLoopbackProxy: true` (default `false`). The exception only accepts HTTP/HTTPS at `127.0.0.1`, `localhost` or `[::1]` in client settings/config. The bridge validates the effective configuration after merging Claude user/project/local sources and Codex global/project sources. In Codex it also requires `requires_openai_auth = true`, with no credential keys in the merged provider; unverifiable TOML routing forms block execution. `ANTHROPIC_BASE_URL` is still removed from the process environment. `duo doctor` shows authorization or a hint to enable the option. The local proxy can see traffic and the session token; see [SECURITY.md](SECURITY.md).

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
2. **Policy** (`economico` by default): delegation reason compatible with policy, up to **8 invocations per run** (including retries) and quota preference.
3. **Scope**: relative paths only, no `..`, no symlinks, outside the denylist (`.env`, keys, `.git`, `.duo`…).
4. **Compatibility**: required flags must appear in the installed version's `--help`.
5. **Authentication**: API/gateway variables are removed from the executor environment, settings such as `apiKeyHelper` or custom providers block execution (except explicitly authorized loopback proxies), and the effective method must be confirmed as subscription authentication by official status.
6. **Slots**: up to four worktree executors; any in-place task is exclusive.
7. **Execution**: prompt through stdin, separate arguments, no shell, with timeout, output limit and process-tree termination.
8. **Independent verification**: actually changed files (by hash), scope violations, diff of the executor's delta only, discrepancies between what the executor declared and did, changed base and acceptance commands executed by the bridge.

A model's "completed" with a failing test becomes `failed`. Nothing is automatically reverted: the bridge never uses `reset --hard`, `clean` or `stash`.

## Parallel executors

One brain can run **up to four independent executors in separate worktrees in the same existing run**. Use `isolation: "worktree"`, the same `runId` and a distinct `taskKey` in every parallel request. Assign separate writable files and enough context for each executor to finish without another executor's patch.

The defaults in the target project's `.duo/config.json` are:

```json
{
  "limits": {
    "maxConcurrentExecutors": 4,
    "maxDelegationsPerRun": 8,
    "worktreeLinks": ["node_modules"]
  }
}
```

For example, start from an existing **Codex-brain run** and a Git repository with at least one commit. If no run exists, submit one initial request without `runId`, wait for its result and copy its returned `runId`. Do not dispatch four requests without `runId`: that would create separate runs.

Prepare `.duo/requests/a.json` as follows, replacing `run-existing-id` with that actual ID and `brainModel` with the model running the brain:

```json
{
  "version": 1,
  "runId": "run-existing-id",
  "taskKey": "docs-install",
  "brain": "codex",
  "brainModel": "gpt-6-astra",
  "executor": "codex",
  "model": "gpt-6.1-sol",
  "adaptive": false,
  "kind": "implement",
  "isolation": "worktree",
  "objective": "Document project installation in docs/install.md; change only that file.",
  "reason": "clear_benefit",
  "rationale": "Independent documentation task with a separate writable file.",
  "scope": { "allowedPaths": ["docs/install.md"] },
  "acceptance": { "criteria": ["Accurate installation instructions; only docs/install.md changed"], "commands": [] }
}
```

Prepare the other three requests with the **same `runId`, brain and models**, adapting `objective`, `scope.allowedPaths` and `acceptance.criteria` to each file:

| Request | Unique `taskKey` | Only writable file / topic |
| --- | --- | --- |
| `a.json` | `docs-install` | `docs/install.md` — installation |
| `b.json` | `docs-usage` | `docs/usage.md` — everyday usage |
| `c.json` | `docs-troubleshooting` | `docs/troubleshooting.md` — troubleshooting |
| `d.json` | `docs-faq` | `docs/faq.md` — FAQ |

Dispatch from the brain's project directory (POSIX shell example; on Windows, run one `delegate` command per terminal in four terminals, without the trailing `&` or `wait`, and wait for all four commands to finish):

```sh
duo delegate --request .duo/requests/a.json > .duo/a-result.json &
duo delegate --request .duo/requests/b.json > .duo/b-result.json &
duo delegate --request .duo/requests/c.json > .duo/c-result.json &
duo delegate --request .duo/requests/d.json > .duo/d-result.json &
duo status
duo status --json
wait
```

`duo status` shows occupied slots; `duo status --json` exposes them in `slots[]`. With only worktree executors active, free slots are `limits.maxConcurrentExecutors - slots.length`, **across the project**, not per run. The limit accepts 1..4 (default 4), with no queue: a fifth executor is blocked while all four slots are occupied. Wait for a slot before submitting more work. The default **8 delegations per run includes retries**, not eight per executor. If the run has only one prior invocation, these four initial executions bring the count to five, leaving three for further invocations, including retries.

After all four finish, inspect each result and patch. Apply only tasks with `state: "succeeded"` that the brain approves; replace the placeholders below with the `taskId` from each result. Run **one `duo apply` at a time**, then validate the combined result. Keep HEAD unchanged until all intended patches have been applied; committing between applies invalidates the remaining patches' base.

```sh
duo apply --task-id TASK_ID_FROM_A_RESULT
duo apply --task-id TASK_ID_FROM_B_RESULT
duo apply --task-id TASK_ID_FROM_C_RESULT
duo apply --task-id TASK_ID_FROM_D_RESULT
```

An in-place task of any kind is exclusive and blocks both admission and `duo apply`. An in-place request arriving while worktrees are active is forced into a worktree; isolation then stays fixed for the chain, including resume and adaptive retries. Without a git commit, parallel execution is blocked.

Each worktree starts with HEAD plus the brain's tracked and untracked non-ignored changes, excluding denied paths and `.duo/`. `limits.maxSnapshotBytes` bounds this snapshot. The local snapshot commit is detached and never pushed; the executor patch contains only its subsequent changes. Shared dependency links are excluded from the patch and are not executor writable roots. Keep dependency installation outside these runs.

The brain applies successful patches one at a time in its chosen order. A changed HEAD or a changed/created file touched by the patch rejects integration; other in-scope drift produces a warning. A rejected apply requires a fresh task on the new base. Nothing is merged or committed automatically. `duo status` shows active slots; `lock.json` remains a compatibility mirror while slots are occupied. Each slot owner refreshes the mirror every 5 seconds and stops its timer on release. After the mirrored owner dies, an older duo can reclaim it during the residual window of up to 5 seconds (longer if the event loop or guard is busy); avoid mixing versions during parallel runs. Inherited dependency links denied by `scope.deny` are silently omitted; explicitly configured denied links remain errors.

## Local state

```text
.duo/
  config.json
  runs/<runId>/run.json
  runs/<runId>/tasks/<taskId>/{task.json, request.json, prompt.txt, invocation.json, events.jsonl, stderr.txt, changes.diff|changes.patch, snapshot/}
  telemetry.jsonl   quota.json   quota-state.json   lock.json   locks/   handoffs/   backups/   worktrees/
```

Every persisted file undergoes secret redaction. Reasoning text (`reasoning` in Codex and `thinking` in Claude) is not recorded.

## Validation status

| Item | Status |
| --- | --- |
| Public release | **v0.3.1**, latest published package; download links above point to it |
| v0.4.0 | **Published (2026-11-07)**; macOS gate: quality 100/100, real E2E 17/17 |
| Integrated macOS offline suite | **672/672 passed, 0 failed** on November 5, 2026; Q9 **3/3** confirms only this offline check |
| Historical real `duo doctor` | Claude 2.1.114 and Codex 0.157.1 authenticated by subscription, with all required flags present; not a current compatibility check |
| Historical v0.3.1 real E2E suite ([docs/e2e-real.md](docs/e2e-real.md)) | **16/16** in a complete run from scratch with Opus 5.5 (previously 13/13 and 11/11): read-only review in both directions, impossible acceptance, out-of-scope temptation, timeout + resume (Codex and Claude), cancellation, worktree + apply, blocked recursion, evidence-based routing in both directions, **real art with GPT-6-Astra** and **tasks with different models per part** (Opus 5.5 for code + GPT-6-Astra for art), with Claude or Codex as brain; not validation of v0.4.0 |
| Historical native brain using the skill | **Validated in headless mode**: `claude -p "/duo-delegate …"` → Codex and `codex exec "$duo-delegate …"` → Claude, both `succeeded`; also covered by the v0.4.0 gate (T10, T11, Q7) |
| Historical v0.3.1 real-executor quota/scope-violation scenarios | **Not exercised in that validation**: real executors respected scope and quota did not run out; both cases had offline coverage |
| VS Code extensions (interactive panel) | **Not exercised**: brains ran through CLIs in headless mode; skills and commands are the same, but interactive approvals were not tested |
| Windows | User-reported offline run: **646 passed, 0 failed, 12 skipped (658 total)**; real E2E not run there |
| Linux | **Not tested** |

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
- Worktree acceptance uses that worktree. `limits.worktreeLinks` defaults to `["node_modules"]`; missing dependencies or failed links may require local setup. Windows directory links use junctions; failures are reported as limitations.
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

A dedicated VS Code panel, an optional Codex App Server adapter (sessions, approvals, limits) after validating maturity, brain recommendation before starting. None of these should introduce custom subscription login.

---

## Português

**Claude Code e Codex trabalhando juntos no seu VS Code, cada parte da tarefa feita pelo modelo que faz melhor, usando as CLIs oficiais e as suas próprias assinaturas.**

Você conversa normalmente com o Claude Code (ou com o Codex). Quando a tarefa tem partes diferentes, por exemplo código e uma ilustração, a IA que você abriu (o **cérebro**) usa a skill `duo-delegate` para mandar cada parte ao melhor modelo disponível nas suas contas: o Opus 5.5 no código e o GPT-6-Astra na arte, por exemplo. A ponte `duo` executa a CLI do executor e **confere o resultado de forma independente** (arquivos alterados, testes, imagem válida) antes de devolver ao cérebro.

```text
Você: "/duo-delegate crie a página inicial e uma ilustração de um robô em assets/robo.png"

Claude (Opus 5.5, cérebro)  ── faz o HTML/CSS
          │
          └─ duo delegate ──▶ Codex (GPT-6-Astra) ── gera assets/robo.png
                               │
                               └─ ponte confere: só assets/ mudou, PNG válido 1254×1254,
                                  modelo efetivo gpt-6-astra (registro do próprio Codex)
```

> **Estado (7 de novembro de 2026):** **v0.4.0 é a última release pública.** O gate da release no macOS passou: teste de qualidade real **100/100**, bateria E2E real **17/17** (incluindo quatro executores Codex reais ao mesmo tempo) e suíte offline **680/680**, com as revisões adversariais independentes do Claude e do Codex sem bloqueio ([docs/e2e-real.md](docs/e2e-real.md), [docs/evidencias/](docs/evidencias/)). No Windows a suíte offline passou (**646 pass, 0 fail, 12 skip**) num build anterior da v0.4.0; a bateria E2E real não rodou lá, e o Linux segue sem teste.


## O que o projeto é e o que não é

| É | Não é |
| --- | --- |
| Uma ponte local que chama `codex exec` e `claude -p` oficiais | Um gateway que reutiliza tokens para chamar endpoints privados |
| Uso individual, cada cliente com seu próprio login oficial | Um serviço que oferece login de assinaturas a terceiros |
| Perfil `subscription-only`, que bloqueia API, gateway e nuvem | Uma API paga disfarçada ou fallback automático de cobrança |
| Um cérebro por run e até quatro executores isolados por projeto | Um enxame autônomo ou uma terceira IA planejadora |

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
git clone https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator.git duo-orchestrator
cd duo-orchestrator
npm ci          # instala as dependências de desenvolvimento
npm run build   # compila explicitamente, mesmo se prepare foi bloqueado
npm link        # coloca o comando duo no PATH
duo --version
```

Para atualizar depois, rode estes comandos na pasta clonada da instalação do duo (também no Windows):

```bash
git pull
npm ci
npm run build
npm link
duo --version
```

Versões recentes do npm podem bloquear scripts automáticos de instalação, incluindo `prepare` em alguns modos de instalação. Rode `npm run build` explicitamente após `git pull`; `npm link` liga globalmente o pacote local e o comando `duo`. Mantenha as proteções de scripts do npm ativadas ([npm link](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-link.md), [aprovação de scripts do npm](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-approve-scripts.md)). Para rodar os testes offline (nenhum modelo é invocado): `npm test`.

**Opção 2 — pacote pronto da release (sem compilar):**

Estes downloads continuam na **v0.3.1**, a última versão publicada. Ainda não há download publicado da v0.4.0.

```bash
npm install -g https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator/releases/download/v0.3.1/duo-orchestrator-0.3.1.tgz
duo --version
```

Ou baixe com o GitHub CLI e instale o arquivo local:

```bash
gh release download v0.3.1 -R vitorvnascimento/ClaudeGPT-Duo-Orchestrator -p "*.tgz"
npm install -g ./duo-orchestrator-0.3.1.tgz
```

Sem `npm link` ou instalação global, use `node /caminho/duo-orchestrator/dist/src/cli/main.js` no lugar de `duo`. **Remover:** `npm uninstall -g duo-orchestrator` (ou `npm unlink -g duo-orchestrator`).

### Atualizações

O `duo` avisa quando sai uma versão nova: no máximo uma vez por dia, em segundo plano, ele consulta a última release pública deste repositório no GitHub e, se houver versão mais nova, mostra no terminal (stderr, sem atrapalhar saídas `--json`):

```text
duo: nova versão 0.3.1 disponível (instalada: 0.3.0). Novidades: https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator/releases/tag/v0.3.1
     Atualize com: duo update --apply   (desligar aviso: DUO_NO_UPDATE_CHECK=1)
```

- `duo update` consulta na hora; `duo update --apply` instala a nova versão (`npm install -g` do `.tgz` oficial da release).
- A consulta é anônima: não envia token, login, e-mail nem variáveis de ambiente, e só aceita uma release estável deste repositório com o `.tgz` esperado. Nada é instalado sem você pedir.
- Não consulta dentro dos executores, em CI, no sandbox do Codex nem com `DUO_NO_UPDATE_CHECK=1`.
- Só o mantenedor publica releases; o repositório é público para leitura e uso.

> `npm install -g github:vitorvnascimento/ClaudeGPT-Duo-Orchestrator` **não** é recomendado: instalar direto do GitHub depende da preparação automática de um pacote que precisa compilar. Use a compilação explícita acima ou o pacote da release publicada.

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

### Quando o Claude está sem cota

Abra o Codex como cérebro e delegue trabalho independente a outro modelo do Codex. Mescle este campo na **raiz do `.duo/config.json` do projeto de trabalho**, ao lado de `limits` e `routing`:

```json
{ "quotaPreference": "preserve-claude" }
```

Em cada pedido de delegação, use `"brain": "codex"`, `"brainModel": "gpt-6-astra"` (substitua pelo modelo real do cérebro), `"executor": "codex"` e um `"model": "gpt-6.1-sol"` explicitamente diferente, disponível na sua conta. `quotaPreference` pertence à config do projeto, não a `routing`, `billing` ou ao pedido. Delegar ao próprio modelo do cérebro é recusado. O cérebro é fixo no run: continue um run Codex existente ou crie um novo run Codex com um primeiro pedido sem `runId`; não transforme um run Claude em run Codex. O exemplo paralelo abaixo usa essa configuração e `adaptive: false` para manter a escolha explícita do executor, sem fallback automático de cota.

Dicas:
- No Codex com muitas skills instaladas, ele pode não achar a skill sozinho ("Exceeded skills context budget"). Invoque `$duo-delegate` explicitamente.
- Não edite os arquivos do escopo durante execução in-place. Em worktrees, mudanças em arquivos tocados pelo patch invalidam a base; nos demais arquivos do escopo, geram aviso.
- Em páginas HTML abertas direto do disco no Safari, imagens em pastas acima da página não carregam. Deixe o HTML na raiz e as imagens em subpastas.

## Windows

O usuário relatou uma rodada offline com **646 pass, 0 fail e 12 skip (658 no total)**. É um relato anterior, não uma nova execução nem uma validação E2E real no Windows.

Na instalação por clone, use `npm link` e rode `npm run build` explicitamente após cada `git pull`, seguindo os comandos de atualização acima: versões recentes do npm podem bloquear `prepare`. Edite **o `.duo/config.json` do projeto de trabalho**, não a config da instalação do duo, para definir os caminhos dos executores.

A ponte executa processos **sem shell**. Para shims `.cmd` gerados pelo npm com um único alvo permitido e existente no diretório `node_modules` ao lado do shim, a ponte lê o shim e executa o alvo diretamente: `.js`/`.cjs`/`.mjs` pelo executável Node.js atual, ou `.exe` diretamente. Shims desconhecidos ou ambíguos, com alvo fora desse diretório ou não permitido, continuam recusados. Nesses casos, configure como fallback o `.exe` oficial (o instalador nativo do Claude Code gera `claude.exe`) ou um comando explícito `["node", "<script.js>"]` em `.duo/config.json`:

```json
{ "executors": { "claude": { "command": ["C:\\Users\\voce\\.local\\bin\\claude.exe"] },
                 "codex":  { "command": ["node", "C:\\caminho\\para\\@openai\\codex\\bin\\codex.js"] } } }
```

As worktrees compartilham o diretório `node_modules` existente por **junction de diretório** (`limits.worktreeLinks` tem padrão `["node_modules"]`), normalmente sem administrador ou Modo de Desenvolvedor. Symlinks comuns, inclusive links de arquivos, ainda podem exigir administrador ou Modo de Desenvolvedor; testes que precisam deles podem ser pulados quando indisponíveis. O suporte a junctions não torna symlinks arbitrários válidos no escopo. Prepare as dependências antes de iniciar os executores; falhas nos links são registradas como limitações. O encerramento de processos usa `taskkill /T /F`.

## Comandos

| Comando | O que faz |
| --- | --- |
| `duo doctor [--json]` | Diagnóstico sem inferência: versões, flags suportadas (lidas do `--help`), método de autenticação pelo status oficial, conflitos de cobrança, hooks/MCP, outros coordenadores. |
| `duo init [--brain claude\|codex] [--apply] [--overwrite]` | Config e skills do projeto com preview/diff e backup. |
| `duo delegate --request <arquivo> [--no-adaptive]` | Executa um pedido do cérebro (formato em `schemas/delegation-request.schema.json`). Imprime um JSON final; `--no-adaptive` desliga a seleção adaptativa desta execução. |
| `duo delegate --resume <taskId> [--timeout-sec N]` | Retoma uma task `blocked` (timeout, interrupção, cota, login…), reutilizando a sessão nativa; `--timeout-sec` dá mais tempo à retomada. |
| `duo models [--refresh] [--json]` | Modelos disponíveis nas contas conectadas (Claude e Codex), com nível, esforços, uso extra, origem, recomendado/legado do fornecedor, sucessor e aposentadoria, ferramentas (ex.: geração de imagem) e a fonte usada. Sem inferência; cache de 6 h por versão das CLIs (1 h se alguma fonte estiver degradada). |
| `duo recommend [--request <pedido.json>] [--kind …] [--needs image_generation] [--paths …] [--risk …] [--brain …] [--brain-model …]` | Recomendação determinística por evidência, capacidade e disponibilidade. A saída inclui `tier`, `effort` e `selection`, além do executor/modelo, ou indica fazer você mesmo. `--request` fornece objetivo, escopo e aceite reais. |
| `duo status [--run-id <id>] [--json]` | Runs, tasks e vagas ocupadas pelos executores. Detecta interrupções (ponte morta) e marca como `blocked`. |
| `duo report [--run-id] [--json]` | Relatório determinístico com a origem de cada número. |
| `duo cancel --run-id <id>` | Encerra ponte e executor (árvore de processos) e marca `cancelled`. |
| `duo apply --task-id <id>` | Integra o patch de uma task `worktree`, só se HEAD e os arquivos tocados pelo patch não mudaram. |
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

Os pisos são aplicados ao modelo efetivo, inclusive escolhas explícitas, configuração do executor e retomadas: risco alto ou sensível exige `deep`; `light` só vale para risco baixo, poucos arquivos, sem diretório no escopo e com comandos de aceite. A confirmação é obrigatória antes de cada execução, escalada, fallback e retomada: piso `deep` exige catálogo fresco, modelo confirmado pelo fornecedor e esforço explícito `high` ou superior anunciado nesse catálogo. Modelo incompatível, nível presumido, catálogo stale/ausente ou suporte de esforço desconhecido bloqueiam antes de executar; atualize com `duo models --refresh`. Toda escolha automática, inclusive a reserva configurada ou o padrão da CLI, precisa confirmar uso extra, include/exclude e capacidades; o catálogo stale nunca relaxa esses filtros. A inspeção de sensibilidade percorre todos os caminhos autorizados, inclusive ignorados; inspeção incompleta exige `deep`. Se o executor informar um modelo nativo inferior ou não confirmável em `deep`, a task fica `failed`, sem aceite, integração ou escalada automática; no Claude, a ponte interrompe ao receber o init incompatível. Capacidade (inclusive geração de imagem) e nível precisam ser satisfeitos juntos. Um downgrade só ocorre com evidência suficiente e sucesso igual ou superior a `routing.adaptive.downgradeMinSuccess`, respeitando os pisos. Falha de verificação escala `light → standard → deep`; `maxAttempts` conta a primeira tentativa, e `deep` pode usar `xhigh` quando suportado. `model` explícito não troca; `effort` explícito permanece, e sem ele a escalada só aumenta o esforço quando houver suporte.

Cada tentativa em `worktree` recebe um worktree novo e mantém o anterior para inspeção. Em `in-place`, só há nova tentativa se o executor não deixou alterações. Falhas de infraestrutura não escalam. Uso extra só entra com `billing.acknowledgeUnverifiableExtraUsage.<provider>: true` e o modelo incluído em `routing.include`. Na fase 3, cota esgotada pode trocar o executor/modelo por um equivalente de nível igual ou superior, refazendo todos os gates; nunca reduz o nível.

`request.json` conserva o pedido original; `invocation.json` registra comando/argumentos resolvidos e `selection.origin` distingue escolhas explícitas das automáticas. Retomadas mantêm escolhas automáticas elegíveis para escalada, o contador da cadeia mesmo antes da base e o esforço mínimo já alcançado. Fallback procura um destino que sustente esse esforço ou bloqueia. A cadeia compartilha o hash do pedido original; repetir `taskKey` no mesmo run reutiliza o sucesso final, sem ser ocultado por um ancestral bloqueado.

Exemplo validado com as CLIs reais (E2E A1): pedido de arte ao `codex` com `model: "gpt-6-astra"` gerou `assets/mascot.png` (PNG 1254×1254), verificado pela ponte.

### Cota e continuidade (fase 3)

`duo quota refresh` força uma descoberta pelo catálogo e consulta `account/rateLimits/read` na mesma sessão do app-server do Codex. Não usa API própria, não consome créditos e não invoca modelos. O Claude fornece `rate_limit_event` ao executar; sem porcentagem nativa, o uso restante é desconhecido. `duo quota set --provider claude --used-percent 92 --resets-at <ISO8601>` registra uma observação manual. `duo quota show` mantém o formato anterior e acrescenta `state` com status, fonte, uso, reset e modelos afetados, além de `remainingPercent` (null quando desconhecido). `duo recommend` mostra a saúde de cota.

`.duo/quota-state.json` guarda somente `status`, `usedPercent`, `resetsAt`, `observedAt`, `source` e `affectedModels`, sob `claude`/`codex` (uma conta ativa por CLI). E-mail, ID de conta, plano, créditos e tokens não são guardados. Estado passa a `unknown` após o reset, ou após 6 h sem reset. Não há estimativa inventada de quanto resta quando a CLI não fornece porcentagem.

Com uso ≥ `routing.adaptive.quotaWarnPercent` (90 por padrão), candidatos daquela conta perdem 0,15 no score para tarefas `light`/`standard`; `deep` não recebe essa penalidade. Cota esgotada bloqueia a conta, ou somente os modelos explicitamente identificados por um mapeamento inequívoco do catálogo. A porcentagem observada é o maior uso entre as janelas; o reset de limites bloqueantes é o último reset conhecido. Se faltar reset de algum limite bloqueante, o reset é desconhecido.

Se a cota acabar durante uma task adaptativa, a ponte tenta primeiro outros modelos do mesmo fornecedor quando o limite for específico, depois o outro fornecedor, sempre no nível da tentativa ou acima. Cada fallback conta em `maxAttempts` e nos limites de política do run, mantém a task original retomável e registra a cadeia em `selection.fallbacks`. O prompt da ponte é neutro; sandbox e permissões continuam próprios de cada executor. `model` explícito pode ser substituído **somente neste fallback de cota**; `effort` explícito continua sujeito ao suporte do destino. Sem equivalente, com trabalho alterado in-place ou se o destino for o próprio cérebro/modelo, retorna `blocked`. `adaptive: false` continua registrando cota, sem fallback automático.

Para um proxy local que usa sua assinatura, habilite explicitamente `billing.allowLoopbackProxy: true` (padrão `false`). A exceção aceita somente HTTP/HTTPS em `127.0.0.1`, `localhost` ou `[::1]` nas settings/config do cliente. A ponte valida a configuração efetiva após a sobreposição usuário/projeto/local do Claude e global/projeto do Codex. No Codex exige também `requires_openai_auth = true`, sem chaves de credencial no provedor combinado; formas TOML de roteamento que não podem ser verificadas bloqueiam. `ANTHROPIC_BASE_URL` do ambiente do processo continua removido. `duo doctor` mostra a autorização ou a dica para habilitar a opção. O proxy local pode ver o tráfego e o token de sessão; veja [SECURITY.md](SECURITY.md).

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
2. **Política** (`economico` por padrão): motivo da delegação compatível com a política, até **8 invocações por run** (incluindo retentativas) e preferência de cota.
3. **Escopo**: só caminhos relativos, sem `..`, sem symlinks, fora da lista de negação (`.env`, chaves, `.git`, `.duo`…).
4. **Compatibilidade**: flags obrigatórias precisam aparecer no `--help` da versão instalada.
5. **Autenticação**: variáveis de API/gateway são removidas do ambiente do executor, configurações como `apiKeyHelper` ou provedores customizados bloqueiam a execução (exceto proxy loopback explicitamente autorizado), e o método efetivo precisa ser confirmado como assinatura pelo status oficial.
6. **Slots**: até quatro executores em worktrees; qualquer tarefa in-place é exclusiva.
7. **Execução**: prompt pela stdin, argumentos separados, sem shell, com timeout, limite de saída e encerramento da árvore de processos.
8. **Verificação independente**: arquivos realmente alterados (por hash), violações de escopo, diff apenas do delta do executor, divergência entre o que o executor declarou e o que fez, base alterada e comandos de aceite executados pela ponte.

Um "completed" do modelo com teste falhando vira `failed`. Nada é revertido automaticamente: a ponte nunca usa `reset --hard`, `clean` ou `stash`.

## Executores paralelos

Um cérebro pode executar **até quatro executores independentes em worktrees separadas no mesmo run existente**. Use `isolation: "worktree"`, o mesmo `runId` e um `taskKey` diferente em cada pedido paralelo. Separe os arquivos graváveis e forneça contexto suficiente para cada executor terminar sem depender do patch de outro.

Os padrões no `.duo/config.json` do projeto de trabalho são:

```json
{
  "limits": {
    "maxConcurrentExecutors": 4,
    "maxDelegationsPerRun": 8,
    "worktreeLinks": ["node_modules"]
  }
}
```

Por exemplo, parta de um **run existente com cérebro Codex** e de um repositório Git com pelo menos um commit. Se ainda não houver run, envie um primeiro pedido sem `runId`, espere o resultado e copie o `runId` retornado. Não dispare quatro pedidos sem `runId`: isso criaria runs separados.

Prepare `.duo/requests/a.json` assim, substituindo `run-existing-id` pelo ID real e `brainModel` pelo modelo que executa o cérebro:

```json
{
  "version": 1,
  "runId": "run-existing-id",
  "taskKey": "docs-install",
  "brain": "codex",
  "brainModel": "gpt-6-astra",
  "executor": "codex",
  "model": "gpt-6.1-sol",
  "adaptive": false,
  "kind": "implement",
  "isolation": "worktree",
  "objective": "Documentar a instalação do projeto em docs/install.md; alterar somente esse arquivo.",
  "reason": "clear_benefit",
  "rationale": "Documentação independente com um arquivo gravável separado.",
  "scope": { "allowedPaths": ["docs/install.md"] },
  "acceptance": { "criteria": ["Instruções de instalação corretas; somente docs/install.md alterado"], "commands": [] }
}
```

Prepare os outros três pedidos com o **mesmo `runId`, cérebro e modelos**, adaptando `objective`, `scope.allowedPaths` e `acceptance.criteria` ao arquivo de cada um:

| Pedido | `taskKey` único | Único arquivo gravável / assunto |
| --- | --- | --- |
| `a.json` | `docs-install` | `docs/install.md` — instalação |
| `b.json` | `docs-usage` | `docs/usage.md` — uso no dia a dia |
| `c.json` | `docs-troubleshooting` | `docs/troubleshooting.md` — solução de problemas |
| `d.json` | `docs-faq` | `docs/faq.md` — perguntas frequentes |

Dispare a partir da pasta do projeto do cérebro (exemplo para shell POSIX; no Windows, rode um comando `delegate` por terminal em quatro terminais, sem o `&` final nem `wait`, e espere os quatro comandos terminarem):

```sh
duo delegate --request .duo/requests/a.json > .duo/a-result.json &
duo delegate --request .duo/requests/b.json > .duo/b-result.json &
duo delegate --request .duo/requests/c.json > .duo/c-result.json &
duo delegate --request .duo/requests/d.json > .duo/d-result.json &
duo status
duo status --json
wait
```

`duo status` mostra as vagas ocupadas; `duo status --json` as expõe em `slots[]`. Com apenas executores em worktrees ativos, as vagas livres são `limits.maxConcurrentExecutors - slots.length`, **no projeto inteiro**, não por run. O limite aceita 1..4 (padrão 4), sem fila: um quinto executor é bloqueado enquanto as quatro vagas estiverem ocupadas. Espere uma vaga antes de enviar mais trabalho. O padrão de **8 delegações por run inclui retentativas**, não são oito por executor. Se o run tinha apenas uma invocação anterior, essas quatro execuções iniciais levam a contagem a cinco, restando três para novas invocações, incluindo retentativas.

Quando os quatro terminarem, inspecione cada resultado e patch. Aplique só as tarefas com `state: "succeeded"` aprovadas pelo cérebro; substitua os marcadores abaixo pelo `taskId` de cada resultado. Execute **um `duo apply` por vez** e depois valide o resultado combinado. Mantenha HEAD inalterado até aplicar todos os patches pretendidos; commitar entre os applies invalida a base dos patches restantes.

```sh
duo apply --task-id TASK_ID_FROM_A_RESULT
duo apply --task-id TASK_ID_FROM_B_RESULT
duo apply --task-id TASK_ID_FROM_C_RESULT
duo apply --task-id TASK_ID_FROM_D_RESULT
```

Qualquer tarefa in-place é exclusiva e bloqueia novas admissões e `duo apply`. Um pedido in-place que chega enquanto worktrees estão ativas é convertido em worktree; o isolamento fica fixo na cadeia, inclusive em retomadas e retentativas adaptativas. Sem commit Git, a execução paralela é bloqueada.

Cada worktree começa com HEAD mais as alterações rastreadas e não rastreadas não ignoradas do cérebro, excluindo caminhos negados e `.duo/`. `limits.maxSnapshotBytes` limita esse snapshot. O commit local do snapshot fica destacado e nunca recebe push; o patch contém apenas as mudanças posteriores do executor. Links de dependências compartilhadas ficam fora do patch e das raízes de escrita do executor. Instale dependências fora dessas execuções.

O cérebro aplica os patches aprovados um por vez, na ordem escolhida. HEAD diferente ou mudança/criação em arquivo tocado pelo patch impede a integração; mudanças em outros arquivos do escopo geram aviso. Apply rejeitado exige uma tarefa nova sobre a base atual. Nada é mesclado ou commitado automaticamente. `duo status` mostra os slots ativos; `lock.json` permanece como espelho de compatibilidade enquanto houver slots ocupados. Cada dono de slot renova o espelho a cada 5 segundos e para o timer no release. Após a morte do dono espelhado, um duo antigo pode recuperá-lo na janela residual de até 5 segundos (maior se o event loop ou o guard estiver ocupado); evite misturar versões durante execuções paralelas. Links herdados negados por `scope.deny` são omitidos em silêncio; links negados configurados explicitamente continuam sendo erro.

## Estado local

```text
.duo/
  config.json
  runs/<runId>/run.json
  runs/<runId>/tasks/<taskId>/{task.json, request.json, prompt.txt, invocation.json, events.jsonl, stderr.txt, changes.diff|changes.patch, snapshot/}
  telemetry.jsonl   quota.json   quota-state.json   lock.json   locks/   handoffs/   backups/   worktrees/
```

Todo arquivo persistido passa por redação de segredos. O texto de raciocínio (`reasoning` do Codex e `thinking` do Claude) não é gravado.

## Estado da validação

| Item | Situação |
| --- | --- |
| Release pública | **v0.3.1**, último pacote publicado; os links de download acima apontam para ele |
| v0.4.0 | **Publicada (07/11/2026)**; gate no macOS: qualidade 100/100, E2E real 17/17 |
| Suíte offline integrada no macOS | **672/672 passaram, 0 falhas**, em 5 de novembro de 2026; Q9 **3/3** confirma apenas essa verificação offline |
| `duo doctor` real histórico | Claude 2.1.114 e Codex 0.157.1 autenticados por assinatura, com todas as flags obrigatórias presentes; não é uma checagem atual de compatibilidade |
| Bateria E2E real histórica da v0.3.1 ([docs/e2e-real.md](docs/e2e-real.md)) | **16/16** numa execução completa do zero com Opus 5.5 (antes, 13/13 e 11/11): revisão read-only nos dois sentidos, aceite impossível, tentação fora do escopo, timeout + retomada (Codex e Claude), cancelamento, worktree + apply, recursão bloqueada, roteamento por evidência nos dois sentidos, **arte real com GPT-6-Astra** e **tarefas com modelos diferentes por parte** (Opus 5.5 no código + GPT-6-Astra na arte), com Claude ou Codex como cérebro; não é validação da v0.4.0 |
| Cérebro nativo usando a skill, histórico | **Validado em modo headless**: `claude -p "/duo-delegate …"` → Codex e `codex exec "$duo-delegate …"` → Claude, ambos `succeeded`; também coberto pelo gate da v0.4.0 (T10, T11, Q7) |
| Cenários históricos da v0.3.1 de cota esgotada/violação de escopo com executor real | **Não exercitados naquela validação**: os executores reais respeitaram o escopo e não houve cota esgotada; os dois casos tinham cobertura offline |
| Extensões do VS Code (painel interativo) | **Não exercitado**: os cérebros rodaram pelas CLIs em modo headless; as skills e os comandos são os mesmos, mas as aprovações interativas não foram testadas |
| Windows | Rodada offline relatada pelo usuário: **646 pass, 0 fail, 12 skip (658 no total)**; E2E real não executado lá |
| Linux | **Não testado** |

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
- O aceite roda na própria worktree. `limits.worktreeLinks` tem padrão `["node_modules"]`; dependências ausentes ou links indisponíveis podem exigir preparação local. No Windows, diretórios usam junctions; falhas são registradas como limitações.
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

Painel próprio no VS Code, adaptador opcional para o Codex App Server (sessões, aprovações, limites) após validar maturidade, recomendação de cérebro antes de começar. Nada disso deve introduzir login próprio de assinatura.
