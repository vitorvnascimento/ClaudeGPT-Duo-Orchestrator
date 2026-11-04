# Parallel executors (up to 4 per project) — design

Date: 2026-11-04. Status: approved direction by the owner; details below marked *(builder's call)* were decided by Claude, not by the owner.

## Intent

The owner has plenty of ChatGPT (Codex) quota but the duo runs **one executor at a time per project** (`ExecutorLock` in `src/state/store.ts`, `limits.maxConcurrentExecutors` hard-wired to `1` in `src/config.ts`). An orchestrating brain (usually Claude) wants to dispatch several specialised sub-agents at once — implementers, reviewers, testers, "developers" — whose role comes from the prompt, not from a fixed type. The duo must make **any mix** of up to 4 simultaneous executors safe: 4 writers, 4 readers, or mixed.

## Goals

1. Up to 4 executors (Codex or Claude) running at the same time in the same project, each started by a separate `duo delegate` call (the brain runs them as background processes).
2. Each executor's verification stays **exact**: what it changed, what it claimed, scope violations, acceptance results — never polluted by another executor or by the brain editing meanwhile.
3. Parallel executors see the brain's **uncommitted** work, without forcing a commit before dispatch.
4. Results are integrated one by one by the brain with `duo apply`; conflicts are detected, never silently merged.
5. A single executor behaves exactly as today (backward compatible).

## Non-goals

- No queue: the 5th request is blocked with a clear message; the brain retries later.
- No live sharing between parallel executors (one cannot see another's in-progress work).
- No automatic integration, no automatic conflict resolution, no auto-commit.
- No new budget mechanism. The owner decided (04/11/2026) to raise the default `limits.maxDelegationsPerRun` from **2 to 8** (4 in parallel plus one round of fixes). Parallel dispatches of one orchestration share the same `runId`, so the budget bounds them; the docs must say so.

## Anti-goals (would make this a failure even if it "works")

- An executor's verification reporting another executor's edits as its own (or as out-of-scope).
- A green acceptance run that tested a mix of several executors' half-done work.
- `duo apply` overwriting changes made by another executor or by the brain.
- Leaking files matching `scope.deny` (secrets) into executor copies.
- Losing or touching the user's uncommitted work.

## Design

### 1. Slots instead of a single lock

- `limits.maxConcurrentExecutors`: integer **1..4**; default **4** *(builder's call: single tasks behave as before, so the default only changes behaviour when the brain actually runs several)*. Values outside 1..4 are a config error.
- Replace the single `.duo/lock.json` by slot files `.duo/locks/slot-<n>.json`, n in `0..max-1`, each acquired atomically (`O_EXCL`), same `LockInfo` (+ `isolation`, `kind`), same stale-PID cleanup and nonce check (`intact()`). The 5th request is blocked: `limite de N executores simultâneos atingido (...ativos...)`.
- Keep reading a legacy `.duo/lock.json` held by a live PID (older duo running) as an occupied slot, so mixed versions don't run unsafely.

### 2. Isolation rule

All admission decisions happen under one short critical section *(builder's call: an `O_EXCL` guard file `.duo/locks/admission.lock` with stale-PID cleanup)*.

- **In-place tasks are exclusive** *(builder's call)*: an in-place task (any kind) starts only when no other executor is active, and while it runs every new task and every `duo apply` is blocked with a message telling the brain to wait. This keeps a single in-place task exactly as today: its whole-tree verification can never be polluted by a parallel apply.
- **Worktree tasks run in parallel**, up to the slot limit.
- A task that requested `in-place` while worktree tasks are active is **forced to `isolation=worktree`** (any kind: implement, test, asset, review, investigate). The decision and reason go to `task.limitations`/decisions so the brain knows a patch must be applied.
- Consequence for the brain (documented): to dispatch several tasks at once, request `isolation: "worktree"` on all of them; otherwise the first one runs in-place and holds the project.
- **Isolation is fixed per chain** *(builder's call)*: it is decided on the first attempt and reused by `--resume` and adaptive retries (they already reuse `base`/`worktree`). Resuming an in-place chain needs the project to be idle (otherwise blocked); a worktree chain stays a worktree.
- **Mixed versions** *(builder's call)*: while any slot is held, the new duo also keeps the legacy `.duo/lock.json` (marked `"slots": true`) with the pid of a live holder, rewritten on release while other slots remain and removed with the last one, so an older duo sees the project busy. A legacy `lock.json` without the marker and with a live pid counts as an occupied exclusive (in-place) holder.
### 3. Worktree that includes uncommitted work ("snapshot base")

Today `isolation=worktree` refuses a dirty scope. New behaviour (applies to every worktree task, single or parallel):

1. `git worktree add --detach <.duo/worktrees/<taskId>> HEAD` (as today).
2. Bring in the brain's uncommitted state of the **whole tree** (not only scope, so dependencies outside scope are current): tracked changes via `git diff HEAD --binary` applied in the worktree; untracked non-ignored files (`git ls-files --others --exclude-standard`) copied. Uncommitted files matching `scope.deny` and anything under `.duo/` are **never** copied. Committed denied files stay in the checkout, as in today's worktree mode *(builder's call: deny guards writing; in-place executors already read everything)*.
3. If anything was brought in, commit it inside the worktree with a fixed local identity (`-c user.name=duo -c user.email=duo@localhost`, `--no-verify`, no GPG) as the **snapshot commit**. Record `task.base.snapshot` (commit sha). `task.base.head` stays the project HEAD; `task.base.hashes` are taken from the project tree at snapshot time (so they reflect the dirty state).
4. The executor patch is diffed against the snapshot commit (not HEAD), so it contains only the executor's work.
5. The snapshot commit is never referenced by a branch and is never pushed; it lives as long as the worktree.

### 4. Shared dependencies

Worktrees have no `node_modules` (or venvs). New config `limits.worktreeLinks: string[]`, default `["node_modules"]` *(builder's call)*: each existing path is symlinked from the project into the worktree, is excluded from the patch (pathspec exclude), and is outside the executor's writable roots (the Codex sandbox keeps it read-only). Paths must be relative, inside the project, not denied.

### 5. Verification per isolation

- Worktree tasks (parallel or not): `changed` = executor patch vs snapshot (exact). `staleBase` = project HEAD changed **or** any file the patch touches changed in the project since the snapshot. Changes elsewhere in the project are a warning, not stale.
- Read-only tasks in a worktree: any change in their worktree is a violation (as today for read-only), measured in the worktree only.
- In-place tasks: unchanged.

### 6. `duo apply` for parallel patches

- Keep: only `succeeded`, not yet applied, HEAD must equal `task.base.head`.
- Apply runs under the admission lock (two applies never interleave between drift check and `git apply`) and is refused while an in-place executor is active.
- Change the drift check from "any file in scope changed since base" to "**any file the patch touches** (or creates) changed since base". This is what lets two tasks with overlapping wide scopes (e.g. both `src/`) be applied one after the other when they touch different files; overlapping files are rejected with the list. Report other in-scope drift as a warning in the message.
- After a successful apply, keep the worktree (as today) and print the removal command.

### 7. Shared state under concurrency

- `run.invocations`, run decisions, chains: already versioned CAS (`updateVersioned`) — verify every concurrent write path uses it.
- Quota and capacity files (`setQuota`, `recordCapacity`): make updates atomic read-modify-write (CAS or guarded write) so two executors finishing together don't lose an entry. (This was already listed as a pending improvement from the v0.3.0 review.)
- Telemetry JSONL appends: one `appendFileSync` per line (O_APPEND), no read-modify-write.

### 8. Brain-facing surface

- `duo status` shows active slots (task, executor, kind, isolation, pid, since).
- Brain instructions (`skills/shared/decision-guide.md`, `skills/shared/request-format.md`, README, `docs/decisoes.md`) explain: how to run several `duo delegate` in background, the 4-slot limit, that parallel tasks come back as patches to `duo apply` one at a time in the brain's chosen order, that a rejected apply means re-run on the new base, and that `maxDelegationsPerRun` also bounds parallelism.
- Repo texts are bilingual: English first, Portuguese below (existing convention). Code comments/messages follow the existing language (Portuguese).

## Constraints

- Node/TypeScript, no runtime dependencies (keep it that way).
- Windows support (v0.3.1): symlinks need admin there → on Windows use a junction for directories (`symlinkSync(target, path, "junction")`) and fall back to a warning if it fails.
- No regression: full suite (`npm test`, ~570 tests) and `npm run typecheck` must pass; Codex sandbox detects `CODEX_SANDBOX*`, so tests are run outside it for final validation.
- Security model unchanged: executor writable roots = scope entries inside its cwd; denied paths never reachable for writing.

## Left to the builder

File/module layout, exact names of new helpers, message wording (Portuguese, consistent with existing ones), test structure. New behaviour needs tests: slot limit and stale slots, admission race (two processes acquiring at once), forced worktree when another is active, block while in-place writer active, snapshot base with tracked/untracked/denied/ignored files, patch excludes linked paths, apply of two non-overlapping patches with overlapping scopes, apply rejection on overlapping files, concurrent quota/capacity updates, config validation 1..4.

---

## Português (resumo)

Até 4 executores simultâneos por projeto. Uma tarefa sozinha funciona como hoje. Quando já existe outro executor ativo, a nova tarefa roda obrigatoriamente numa worktree própria, criada a partir do HEAD mais o trabalho não commitado do cérebro (sem os arquivos negados nem `.duo/`). O resultado volta como patch, e o cérebro integra um por vez com `duo apply`, que passa a rejeitar só quando os arquivos tocados pelo patch mudaram. Enquanto uma tarefa de escrita roda in-place, novas tarefas esperam. `node_modules` entra na worktree por link, fora do patch e somente leitura. Quota e capacidade passam a ser gravadas de forma atômica. O 5º pedido é recusado, sem fila. O padrão de `maxDelegationsPerRun` sobe de 2 para 8 (decisão do Vitor, 04/11/2026); as tarefas em paralelo de uma orquestração usam o mesmo `runId`, então esse orçamento também as limita.
