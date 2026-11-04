# Parallel Executors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let up to 4 executors run at once in one project, each verified exactly, with parallel work isolated in worktrees that include the brain's uncommitted state and integrated one by one with `duo apply`.

**Architecture:** A slot registry (`src/state/slots.ts`) replaces the single `ExecutorLock` and decides isolation at admission under an `O_EXCL` guard. Worktrees start from HEAD plus a "snapshot commit" of the uncommitted tree (`src/git.ts`), so patches and staleness are measured against the snapshot. `duo apply` runs under the same guard and checks drift only on the files a patch touches.

**Tech Stack:** TypeScript (tsc), Node `>=22.12`, `node:test`, git CLI. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-parallel-executors-design.md`

## Global Constraints

- No runtime dependencies; Node `>=22.12`; build with `npm run build`, test with `npm test`, types with `npm run typecheck`.
- `limits.maxConcurrentExecutors`: integer 1..4, default 4. `limits.maxDelegationsPerRun` default 8 (was 2). `limits.worktreeLinks` default `["node_modules"]`.
- Single in-place task behaves exactly as today. In-place tasks are exclusive (block new tasks and `duo apply` while running).
- Isolation is fixed per chain (first attempt decides; `--resume` and adaptive retries reuse it).
- Never copy uncommitted files matching `cfg.scope.deny` or under `.duo/` into a worktree. Never push or branch the snapshot commit.
- While any slot is held, keep the legacy `.duo/lock.json` with `"slots": true`; a `lock.json` without that marker and with a live pid = an older duo holding the project exclusively.
- User-facing messages and code comments in Portuguese, matching existing ones. Repo docs bilingual: English first, Portuguese below.
- Windows: directory links use `symlinkSync(target, path, "junction")`; on failure, add a limitation and continue without the link.
- Inside the Codex sandbox run tests with `env -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED npm test`.

## Review Focus

1. A `duo delegate` process killed with SIGKILL mid-run → its slot and the legacy mirror are reclaimed by the next admission (pid dead). Test in Task 2.
2. The brain edits a file after dispatching a worktree task, and the task's patch touches that same file → `duo apply` rejects with the file listed; a file the patch does not touch is only a warning. Test in Task 5.
3. A project that is not a git repo, or has no commit, while another executor is active → the new task is blocked with "execução paralela requer um repositório git com ao menos um commit", never run in-place. Test in Task 3.
4. A large untracked, non-ignored directory (e.g. build output) → snapshot copy obeys `limits.maxSnapshotBytes`; over the limit the task is blocked with the offending size, nothing half-copied is executed. Test in Task 4.
5. Two `duo delegate` processes admitted at the same instant with `maxConcurrentExecutors: 1` → exactly one runs. Test in Task 2.

---

### Task 1: Config limits

**Files:**
- Modify: `src/config.ts` (type at ~L20-30, `DEFAULT_CONFIG` ~L84-95, validation ~L177)
- Test: `tests/config-limits.test.ts`

**Interfaces:**
- Produces: `DuoConfig["limits"]` with `maxConcurrentExecutors: number` (1..4), `maxDelegationsPerRun` default `8`, `worktreeLinks: string[]`.

- [ ] **Step 1: Write failing tests** in `tests/config-limits.test.ts`:
  - `"maxConcurrentExecutors aceita 1..4 e recusa 0, 5 e 2.5"` → `loadConfig` succeeds for 1 and 4; throws `ConfigError` matching `/maxConcurrentExecutors/` for 0, 5, 2.5.
  - `"padrões: 4 executores simultâneos, 8 delegações por run, links node_modules"` → `DEFAULT_CONFIG.limits` deepEquals the three values.
  - `"worktreeLinks recusa caminho absoluto, com .. ou negado"` → `/abs`, `../x`, `.env` (matches default deny) each produce a `ConfigError` matching `/worktreeLinks/`.
- [ ] **Step 2:** `npm test` → the three tests FAIL.
- [ ] **Step 3:** Implement: type `maxConcurrentExecutors: number`; validation `Number.isInteger(v) && v >= 1 && v <= 4` with message `limits.maxConcurrentExecutors (inteiro de 1 a 4)`; `worktreeLinks` validation (array of relative POSIX paths, no `..`, not matching `scope.deny` via the existing `isDenied`).
- [ ] **Step 4:** `npm test` → PASS (fix any existing test asserting the old defaults).
- [ ] **Step 5:** Commit `feat(config): até 4 executores simultâneos, 8 delegações por run, worktreeLinks`.

### Task 2: Slot registry and admission guard

**Files:**
- Create: `src/state/slots.ts`
- Modify: `src/state/store.ts` (remove `ExecutorLock`, keep `LockInfo` export or move it), `tests/fixtures/fake-common.mjs` (`removeLock` also removes `.duo/locks/`)
- Test: `tests/slots.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Isolation = "in-place" | "worktree";
  export type SlotInfo = { slot: number; pid: number; taskId: string; runId: string; nonce: string; startedAt: string; isolation: Isolation; kind: TaskKind };
  export type AdmitRequest = { taskId: string; runId: string; kind: TaskKind; requested: Isolation; fixed: Isolation | null; gitReady: boolean };
  export type AdmitResult = { ok: true; isolation: Isolation; forced: boolean } | { ok: false; reason: string };
  export function withAdmission<T>(projectRoot: string, fn: () => T): T;      // O_EXCL .duo/locks/admission.lock, stale pid cleanup, retry ≤ 5 s
  export function activeSlots(projectRoot: string): SlotInfo[];               // live slots + legacy holder (slot -1, isolation "in-place")
  export class ExecutorSlots {
    constructor(projectRoot: string, max: number);
    admit(req: AdmitRequest): AdmitResult;  // runs inside withAdmission
    intact(): boolean;                       // own slot file still has our nonce
    release(): void;                         // under withAdmission; rewrites/removes legacy mirror
  }
  ```
- Admission rules (in order): any active in-place → block `outro executor in-place está ativo (...); aguarde ele terminar`; active count ≥ max → block `limite de N executores simultâneos atingido (...)`; `fixed === "in-place"` and others active → block; `requested`/`fixed` in-place and none active → in-place; otherwise worktree, `forced = requested === "in-place"`; worktree needed but `!gitReady` → block `execução paralela requer um repositório git com ao menos um commit`.

- [ ] **Step 1: Write failing tests** in `tests/slots.test.ts`:
  - `"admite até max e bloqueia o seguinte"` (max 2, two worktree admits ok, third `ok:false` matching `/limite de 2/`).
  - `"in-place ativo bloqueia qualquer nova admissão"`.
  - `"pedido in-place com outro ativo vira worktree forçado"` → `{ ok: true, isolation: "worktree", forced: true }`.
  - `"cadeia fixa in-place com outro ativo é bloqueada"`.
  - `"slot de pid morto é recuperado"` (write slot file with a dead pid, admit succeeds) — Review Focus 1.
  - `"lock.json legado sem marcador e pid vivo conta como in-place exclusivo"`; `"espelho legado existe enquanto há slot e some com o último release"`.
  - `"sem git com commit e outro ativo: bloqueia"` — Review Focus 3 (unit level).
  - `"corrida: 6 processos admitindo ao mesmo tempo com max 1 → exatamente 1 ok"` (spawn `node` children importing `dist/src/state/slots.js`, each prints its result) — Review Focus 5.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement `src/state/slots.ts`; reuse the existing `isPidAlive` and `writeJsonAtomic`. Remove `ExecutorLock`; update `removeLock()` in the fixture.
- [ ] **Step 4:** `npm test` → slot tests PASS (delegate tests may fail until Task 3).
- [ ] **Step 5:** Commit `feat(state): slots de executor com admissão atômica e espelho do lock legado`.

### Task 3: Delegate uses slots and fixes isolation per chain

**Files:**
- Modify: `src/orchestration/delegate.ts` (~L550-570 acquisition; `ExecCtx.lock` type ~L662; `decide` message ~L1132; prior-attempt reuse ~L381-383)
- Test: `tests/delegate.test.ts`

**Interfaces:**
- Consumes: `ExecutorSlots`, `AdmitRequest`, `AdmitResult` (Task 2).
- Produces: `task.isolation` set to the admitted isolation before `execute`; when `forced`, push limitation `isolamento trocado para worktree: outro executor está ativo; integre com duo apply` and a run decision of kind `"note"`.

- [ ] **Step 1: Write failing tests** in `tests/delegate.test.ts` (adapt the existing "lock mantido por outro processo" and "remove o lock" tests to slots):
  - `"com outro executor ativo, pedido in-place roda em worktree forçado"` (pre-write a worktree slot held by `process.pid`; task succeeds, `t.worktree` set, limitation present, project file unchanged until apply).
  - `"in-place ativo bloqueia segundo executor"` (exit code 3, no exec call).
  - `"retomada de cadeia in-place com outro ativo é bloqueada"`.
  - `"sem commit e outro ativo: bloqueado, nunca in-place"` — Review Focus 3.
  - `"executor que remove o próprio slot → failed"` (existing scenario, message still matches `/lock|slot/`).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Replace `ExecutorLock` with `ExecutorSlots(projectRoot, cfg.limits.maxConcurrentExecutors)`; `fixed` = prior attempt's `task.isolation` when resuming/retrying, else `null`; `gitReady` = `headCommit(projectRoot) !== null`. Keep the `finally { release() }`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(delegate): executores em paralelo via slots; isolamento fixo por cadeia`.

### Task 4: Snapshot worktree, links, and worktree verification

**Files:**
- Modify: `src/git.ts` (`worktreeAdd`, `worktreePatch`), `src/orchestration/delegate.ts` (`execute` ~L680-715, `verify` ~L1058-1090), `src/state/types.ts` (`base` gains `snapshot: string | null`)
- Test: `tests/delegate.test.ts`, `tests/unit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function worktreeSnapshot(root: string, wt: string, opts: { deny: string[]; maxBytes: number }): { ok: true; snapshot: string | null; copiedBytes: number } | { ok: false; error: string };
  export function linkIntoWorktree(root: string, wt: string, rels: string[]): { linked: string[]; failed: string[] };
  export function worktreePatch(wt: string, base: string, exclude?: string[]): { ok: boolean; patch: string; files: string[]; error?: string }; // exclude → ":(exclude)<rel>" pathspecs
  ```
- Snapshot algorithm: in `wt`, `git apply --binary` the output of `git -C root diff HEAD --binary` minus denied/`.duo/` paths (pathspec excludes); copy `git -C root ls-files --others --exclude-standard -z` files not denied and not under `.duo/`, summing sizes against `maxBytes` before copying; if anything changed, `git -c user.name=duo -c user.email=duo@localhost -c commit.gpgsign=false commit --no-verify -q -m "duo: snapshot"` and return its sha, else `snapshot: null`.
- Delegate: remove the two "isolation=worktree requer…" dirty-scope blocks (keep "requer ao menos um commit"); after `worktreeAdd`, call `worktreeSnapshot` then `linkIntoWorktree(cfg.limits.worktreeLinks)`; `task.base.snapshot`; every `worktreePatch` call uses `task.base.snapshot ?? task.base.head` and excludes linked paths. `verify` worktree branch: `staleBase = headCommit(root) !== base.head || changed.some(rel => hashPath(join(root, rel)) !== base.hashes[rel])`; other in-scope drift → limitation `o projeto mudou fora do patch desde o snapshot: …`. `base.hashes` must cover the patch files: capture scope hashes from the project tree at snapshot time (existing `captureState`).

- [ ] **Step 1: Write failing tests:**
  - unit `"worktreeSnapshot leva modificação rastreada e arquivo novo; ignora .gitignore, negados e .duo/"` (asserts on file presence/content inside wt and on `snapshot` sha being a commit whose parent is HEAD).
  - unit `"worktreeSnapshot acima de maxBytes falha sem copiar"` — Review Focus 4.
  - unit `"worktreePatch exclui links"` (node_modules symlink not in `files`).
  - delegate `"worktree com escopo sujo agora roda e o patch contém só o trabalho do executor"`.
  - delegate `"leitura em worktree que altera arquivo → violação"`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement per Interfaces.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(worktree): base com trabalho não commitado, links de dependências e patch exato`.

### Task 5: Parallel-safe `duo apply`

**Files:**
- Modify: `src/orchestration/control.ts` (`applyTask` ~L82-125)
- Test: `tests/delegate.test.ts` (or a new `tests/apply.test.ts`)

**Interfaces:**
- Consumes: `withAdmission`, `activeSlots` (Task 2); `task.base.hashes`, `task.verification.filesChangedActual`.
- Produces: `applyTask` result message unchanged in shape; adds warning text when other in-scope files drifted.

- [ ] **Step 1: Write failing tests:**
  - `"dois patches com escopo src/ que tocam arquivos diferentes aplicam em sequência"`.
  - `"patch que toca arquivo alterado depois do snapshot é rejeitado com o arquivo listado"`; `"alteração em outro arquivo do escopo só gera aviso"` — Review Focus 2.
  - `"apply recusado enquanto executor in-place está ativo"`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Wrap the body in `withAdmission`; refuse when `activeSlots(root).some(s => s.isolation === "in-place")` with `um executor in-place está ativo; aplique depois que ele terminar`; drift = patch files (`filesChangedActual`) whose project hash ≠ `base.hashes[rel]`, plus created files that now exist; collect other drifted scope files as a warning appended to the success message.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(apply): integração de patches paralelos com checagem de deriva só nos arquivos do patch`.

### Task 6: Atomic quota and capacity updates

**Files:**
- Modify: `src/state/store.ts` (add helper), `src/telemetry/report.ts` (`setQuota`), `src/orchestration/capacity.ts` (`recordCapacity`)
- Test: `tests/quota.test.ts`

**Interfaces:**
- Produces: `export function updateJsonLocked<T>(path: string, change: (value: T | null) => T): T;` — `O_EXCL` `<path>.lock` with stale-pid cleanup, retry ≤ 2 s, then read → `change` → `writeJsonAtomic` → unlock.

- [ ] **Step 1: Write failing test** `"8 processos gravando cota e capacidade ao mesmo tempo não perdem entradas"` (spawn children each recording a distinct provider/model key; final files contain all 8).
- [ ] **Step 2:** `npm test` → FAIL (lost updates).
- [ ] **Step 3:** Implement helper; use it in `setQuota` and `recordCapacity`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `fix(state): cota e capacidade com atualização atômica entre processos`.

### Task 7: Status, brain docs, changelog

**Files:**
- Modify: `src/cli/main.ts` (`status` case ~L287-310), `skills/shared/decision-guide.md`, `skills/shared/request-format.md`, `README.md` (EN + PT sections, `.duo/` tree adds `locks/`), `docs/decisoes.md` (EN + PT), `CHANGELOG.md` (Unreleased)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `activeSlots` (Task 2).
- Produces: `duo status --json` adds `slots: SlotInfo[]`; text output adds one line per slot: `executor ativo: <taskId> <executor?>/<kind> <isolation> pid <pid> desde <startedAt>`.

- [ ] **Step 1: Write failing test** `"status --json lista slots ativos"`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement status; write docs: how to dispatch several `duo delegate` in background with `isolation: "worktree"` and a shared `runId`; limit 4; results are patches applied one at a time with `duo apply` in the brain's order; rejected apply ⇒ re-run on the new base; in-place is exclusive; `maxDelegationsPerRun` (default 8) bounds parallel dispatches.
- [ ] **Step 4:** `npm test` and `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `docs: execução paralela de executores (até 4) e status dos slots`.
