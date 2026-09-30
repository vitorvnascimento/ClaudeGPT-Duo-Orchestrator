import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, mock } from "node:test";
import { Store, readVersioned, updateVersioned, writeJsonAtomic } from "../src/state/store.js";
import type { Chain, ChainAttempt, Run } from "../src/state/types.js";

const nativeFs = (fs as unknown as { default: typeof fs }).default;
const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of [...children]) await reap(child);
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "duo-store-cas-"));
  roots.push(root);
  return root;
}

function iso(): string {
  return new Date().toISOString();
}

function makeRun(runId = "run-cas-test01"): Run {
  const now = iso();
  return {
    runId,
    brain: "claude",
    policy: "equilibrado",
    createdAt: now,
    updatedAt: now,
    cancelled: false,
    invocations: 0,
    taskIds: [],
    decisions: [],
    nextStep: null,
  };
}

function makeChain(runId: string, chainId = "task-cas-chain01"): Chain {
  return {
    version: 1,
    chainId,
    runId,
    taskKey: "cas-test",
    requestHash: "cas-test-hash",
    originalRequestPath: "/tmp/request.json",
    floorTier: "light",
    minTier: "light",
    minEffort: null,
    origin: { model: "auto", effort: "auto" },
    attempts: [],
    status: "blocked",
    latestTaskId: chainId,
    updatedAt: iso(),
    owner: null,
  };
}

function seedLegacy(): { store: Store; run: Run; chain: Chain; root: string } {
  const root = freshRoot();
  const store = new Store(root);
  const run = makeRun();
  const chain = makeChain(run.runId);
  writeJsonAtomic(join(store.runDir(run.runId), "run.json"), run);
  writeJsonAtomic(store.chainPath(run.runId, chain.chainId), chain);
  return { store, run, chain, root };
}

function revisionDirectory(store: Store, kind: "run" | "chain", runId: string, chainId?: string): string {
  return kind === "run"
    ? join(store.runDir(runId), "run.d")
    : join(store.runDir(runId), "chains", `${chainId}.d`);
}

function revisions(directory: string): string[] {
  return readdirSync(directory).filter((name) => /^\d{12}\.json$/.test(name)).sort();
}

function revisionNumber(name: string): number {
  return Number(name.slice(0, -5));
}

function revisionName(revision: number): string {
  return `${String(revision).padStart(12, "0")}.json`;
}

function attempt(taskId: string, number: number, tier: ChainAttempt["tier"] = "standard"): ChainAttempt {
  return {
    taskId,
    attempt: number,
    executor: "codex",
    model: "gpt-6-astra",
    effort: tier === "deep" ? "high" : "medium",
    tier,
    reason: "escalation",
    state: "blocked",
  };
}

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "close").catch(() => undefined);
  }
  children.delete(child);
}

type WorkerResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

async function worker(script: string, args: string[], timeoutMs = 20_000): Promise<WorkerResult> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      closed,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`worker timeout: ${stderr}`)), timeoutMs); }),
    ]);
    return { ...result, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    await reap(child);
  }
}

it("CAS: escolhe a maior revisão publicada, ignora temporários e migra o legado rev 0", () => {
  const { store, run, chain } = seedLegacy();

  store.updateRun(run.runId, (fresh) => {
    fresh.invocations++;
    fresh.taskIds.push("task-cas-run01");
  });
  const runDir = revisionDirectory(store, "run", run.runId);
  const runFiles = revisions(runDir);
  assert.equal(runFiles.length, 1, "primeira escrita migra o legado para rev 1");
  for (const name of runFiles) assert.equal(typeof JSON.parse(readFileSync(join(runDir, name), "utf8")).rev, "number");

  const currentRun = store.loadRun(run.runId)!;
  const winnerRevision = Math.max(...runFiles.map(revisionNumber)) + 5;
  writeFileSync(join(runDir, revisionName(winnerRevision)), JSON.stringify({ ...currentRun, rev: winnerRevision, invocations: 77 }));
  writeFileSync(join(runDir, `${revisionName(winnerRevision + 1)}.tmp`), JSON.stringify({ ...currentRun, rev: winnerRevision + 1, invocations: 999 }));
  // Temporários são ignorados: vence a maior revisão publicada.
  assert.equal(store.loadRun(run.runId)!.invocations, 77);

  // Revisão publicada com conteúdo corrompido nunca é pulada em favor de um estado anterior: erro explícito.
  writeFileSync(join(runDir, revisionName(winnerRevision + 2)), "{invalid");
  assert.throws(() => store.loadRun(run.runId), SyntaxError);
  writeFileSync(join(runDir, revisionName(winnerRevision + 2)), JSON.stringify({ ...currentRun, invocations: 888 }));
  assert.throws(() => store.loadRun(run.runId), /revisão de estado inconsistente/);
  assert.throws(() => store.updateRun(run.runId, (r) => { r.invocations++; }), /revisão de estado inconsistente/);
  rmSync(join(runDir, revisionName(winnerRevision + 2)));
  assert.equal(store.loadRun(run.runId)!.invocations, 77);

  store.updateChain(run.runId, chain.chainId, (fresh) => {
    fresh.attempts.push(attempt("task-cas-chain02", 1, "deep"));
    fresh.floorTier = "deep";
  });
  const chainDir = revisionDirectory(store, "chain", run.runId, chain.chainId);
  const chainFiles = revisions(chainDir);
  assert.ok(chainFiles.length >= 1, "Chain deve migrar para uma revisão");
  assert.ok(chainFiles.every((name) => typeof JSON.parse(readFileSync(join(chainDir, name), "utf8")).rev === "number"));
  assert.equal(store.loadChain(run.runId, chain.chainId)!.attempts.length, 1);

  const legacyRoot = freshRoot();
  const legacyStore = new Store(legacyRoot);
  const legacyRun = makeRun("run-legacy01");
  const legacyChain = makeChain(legacyRun.runId, "task-legacy01");
  writeJsonAtomic(join(legacyStore.runDir(legacyRun.runId), "run.json"), legacyRun);
  writeJsonAtomic(legacyStore.chainPath(legacyRun.runId, legacyChain.chainId), legacyChain);
  assert.deepEqual({ ...legacyStore.loadRun(legacyRun.runId), runId: legacyRun.runId, invocations: 0 }, { ...legacyRun, rev: 0 });
  assert.equal(legacyStore.loadChain(legacyRun.runId, legacyChain.chainId)?.chainId, legacyChain.chainId);

  const versionedPath = join(store.runDir(run.runId), "probe.json");
  assert.equal(readVersioned<{ rev?: number; count: number }>(versionedPath), null);
  updateVersioned<{ rev?: number; count: number }>(versionedPath, (value) => ({ count: (value?.count ?? 0) + 1 }));
  assert.equal(readVersioned<{ rev?: number; count: number }>(versionedPath)?.count, 1);
});

it("CAS: diretório de revisões JSON sem marcas auxiliares continua legível e atualizável", () => {
  const { store, run } = seedLegacy();
  const directory = revisionDirectory(store, "run", run.runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, revisionName(7)), JSON.stringify({ ...run, rev: 7, taskIds: ["task-sem-marca"], invocations: 1, cancelled: true }));
  assert.equal(store.loadRun(run.runId)!.invocations, 1);
  const updated = store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push("task-apos-migracao"); });
  assert.equal(updated.rev, 8);
  assert.equal(updated.invocations, 2);
  assert.equal(updated.cancelled, true);
  assert.deepEqual(updated.taskIds, ["task-sem-marca", "task-apos-migracao"]);
});

it("CAS: replay determinístico após revisão obsoleta preserva tentativa, piso e owner", () => {
  const { store, run, chain } = seedLegacy();
  let callbacks = 0;
  let injected = false;
  const concurrent = attempt("task-cas-concurrent", 1, "deep");
  const owner = { pid: 2147483647, nonce: "owner-preserved" };
  const originalLink = nativeFs.linkSync;
  mock.method(nativeFs, "linkSync", ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!injected) {
      injected = true;
      const directory = revisionDirectory(store, "chain", run.runId, chain.chainId);
      mkdirSync(directory, { recursive: true });
      const current = Math.max(0, ...revisions(directory).map(revisionNumber));
      const fresh = { ...chain, rev: current + 1, attempts: [concurrent], floorTier: "deep" as const, minTier: "deep" as const, owner };
      writeFileSync(join(directory, revisionName(current + 1)), JSON.stringify(fresh));
      const error = new Error("CAS stale");
      Object.assign(error, { code: "EEXIST" });
      throw error;
    }
    return originalLink(source, destination);
  }) as typeof nativeFs.linkSync);
  syncBuiltinESMExports();

  try {
    const own = attempt("task-cas-replayed", 2, "standard");
    const result = store.updateChain(run.runId, chain.chainId, (fresh) => {
      callbacks++;
      if (!fresh.attempts.some((entry) => entry.taskId === own.taskId)) fresh.attempts.push(own);
      fresh.minTier = "standard";
      if (!fresh.owner) fresh.owner = { pid: process.pid, nonce: "local" };
    });
    assert.ok(callbacks >= 2, `callback não foi refeito após CAS obsoleto: ${callbacks}`);
    assert.deepEqual(result.owner, owner);
    assert.equal(result.minTier, "deep");
    assert.deepEqual(result.attempts.map((entry) => entry.taskId).sort(), [concurrent.taskId, own.taskId].sort());
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it("rodada 4 achado 1: dois recuperadores e novo escritor não apagam reserva nem snapshot vivo", () => {
  const { store, run, chain } = seedLegacy();
  const path = store.chainPath(run.runId, chain.chainId);
  writeJsonAtomic(path, { ...chain, owner: { pid: 2147483647, nonce: "dead" } });
  const link = nativeFs.linkSync;
  const alive = { pid: process.pid, nonce: "writer-c", since: iso() };
  let active = "a", scheduled = false, removed = false;
  const update = (id: string) => {
    const prior = active; active = id;
    try {
      store.updateChain(run.runId, chain.chainId, (fresh) => {
        if (id === "c") fresh.owner = alive;
        fresh.attempts.push(attempt(`task-recuperador-${id}`, fresh.attempts.length + 1, id === "c" ? "deep" : "standard"));
        fresh.minTier = id === "c" ? "deep" : "standard";
        fresh.minEffort = id === "c" ? "high" : "medium";
      });
    } finally { active = prior; }
  };
  // CAS: a mesma ordem de snapshots A -> B -> C; cada perdedor deve reler.
  mock.method(nativeFs, "linkSync", ((source: fs.PathLike, target: fs.PathLike) => {
    if (active === "a" && !scheduled) { scheduled = true; update("b"); }
    else if (active === "b" && !removed) { removed = true; update("c"); }
    return link(source, target);
  }) as typeof nativeFs.linkSync);
  syncBuiltinESMExports();
  update("a");
  const final = store.loadChain(run.runId, chain.chainId)!;
  assert.equal(scheduled && removed, true, "interleaving completo");
  assert.deepEqual(final.attempts.map((a) => a.taskId).sort(), ["task-recuperador-a", "task-recuperador-b", "task-recuperador-c"]);
  assert.equal(final.minTier, "deep");
  assert.equal(final.minEffort, "high");
  assert.deepEqual(final.owner, alive);
});

it("CAS: dois recuperadores de owner morto não perdem escritor mais novo, attempts ou minTier", async () => {
  const { store, run, chain } = seedLegacy();
  const seeded = {
    ...chain,
    floorTier: "deep" as const,
    minTier: "deep" as const,
    attempts: [attempt("task-cas-seeded", 1, "deep")],
    owner: { pid: 2147483647, nonce: "dead-owner" },
  };
  writeJsonAtomic(store.chainPath(run.runId, chain.chainId), seeded);
  const script = `
    import { Store } from ${JSON.stringify(new URL("../src/state/store.js", import.meta.url).href)};
    const [root, runId, chainId, worker] = process.argv.slice(1);
    const store = new Store(root);
    store.updateChain(runId, chainId, (fresh) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, worker === 'new' ? 8 : 3);
      const taskId = 'task-cas-recover-' + worker;
      if (!fresh.attempts.some((entry) => entry.taskId === taskId)) {
        fresh.attempts.push({ taskId, attempt: fresh.attempts.length + 1, executor: 'codex', model: 'gpt-6-astra', effort: worker === 'new' ? 'high' : 'medium', tier: worker === 'new' ? 'deep' : 'standard', reason: worker === 'new' ? 'escalation' : 'resume', state: 'blocked' });
      }
      if (worker === 'new') { fresh.minTier = 'deep'; fresh.owner = { pid: process.pid, nonce: 'new-owner' }; }
      else if (fresh.owner?.pid === 2147483647) fresh.owner = null;
    });
  `;
  const results = await Promise.all(["recover-a", "recover-b", "new"].map((workerId) => worker(script, [store.projectRoot, run.runId, chain.chainId, workerId])));
  for (const result of results) assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const fresh = store.loadChain(run.runId, chain.chainId)!;
  assert.deepEqual(new Set(fresh.attempts.map((entry) => entry.taskId)), new Set(["task-cas-seeded", "task-cas-recover-recover-a", "task-cas-recover-recover-b", "task-cas-recover-new"]));
  assert.equal(fresh.attempts.length, 4);
  assert.equal(fresh.minTier, "deep");
});

it("CAS: N processos reais preservam attempts, taskIds, pisos, invocações e cancelled", async () => {
  const { store, run, chain } = seedLegacy();
  const script = `
    import { Store } from ${JSON.stringify(new URL("../src/state/store.js", import.meta.url).href)};
    const [root, runId, chainId, worker] = process.argv.slice(1);
    const store = new Store(root);
    for (let i = 0; i < 10; i++) {
      const taskId = 'task-cas-' + worker + '-' + String(i).padStart(2, '0');
      store.updateChain(runId, chainId, (fresh) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        if (!fresh.attempts.some((entry) => entry.taskId === taskId)) {
          fresh.attempts.push({ taskId, attempt: fresh.attempts.length + 1, executor: 'codex', model: 'gpt-6-astra', effort: worker === 'a' ? 'high' : 'medium', tier: worker === 'a' ? 'deep' : 'standard', reason: 'escalation', state: 'blocked' });
        }
        fresh.latestTaskId = taskId;
      });
      store.updateRun(runId, (fresh) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        if (!fresh.taskIds.includes(taskId)) { fresh.taskIds.push(taskId); fresh.invocations++; }
        if (worker === 'a') fresh.cancelled = true;
      });
    }
  `;
  try {
    const results = await Promise.all(["a", "b", "c", "d"].map((workerId) => worker(script, [store.projectRoot, run.runId, chain.chainId, workerId])));
    for (const result of results) assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    for (const child of [...children]) await reap(child);
  }
  const freshChain = store.loadChain(run.runId, chain.chainId)!;
  const freshRun = store.loadRun(run.runId)!;
  assert.equal(freshChain.attempts.length, 40);
  assert.equal(new Set(freshChain.attempts.map((entry) => entry.taskId)).size, 40);
  assert.deepEqual(freshChain.attempts.map((entry) => entry.attempt).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(freshChain.minTier, "deep");
  assert.equal(freshRun.taskIds.length, 40);
  assert.equal(new Set(freshRun.taskIds).size, 40);
  assert.equal(freshRun.invocations, 40);
  assert.equal(freshRun.cancelled, true);
});

it("CAS: SIGKILL após fsync do temporário deixa o próximo escritor avançar", async () => {
  const { store, run } = seedLegacy();
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { Store } from ${JSON.stringify(new URL("../src/state/store.js", import.meta.url).href)};
    const [root, runId] = process.argv.slice(1);
    const original = fs.linkSync;
    const fsync = fs.fsyncSync;
    let synced = false;
    fs.fsyncSync = (fd) => { fsync(fd); synced = true; };
    fs.linkSync = (source, destination) => {
      assert.equal(synced, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')).taskIds, ['task-crash-before-link']);
      process.kill(process.pid, 'SIGKILL');
      return original(source, destination);
    };
    syncBuiltinESMExports();
    new Store(root).updateRun(runId, (fresh) => { fresh.invocations++; fresh.taskIds.push('task-crash-before-link'); });
  `;
  const crashed = await worker(script, [store.projectRoot, run.runId]);
  assert.equal(crashed.signal, "SIGKILL", `${crashed.stderr}\n${crashed.stdout}`);
  const runDir = revisionDirectory(store, "run", run.runId);
  const orphan = readdirSync(runDir).find((name) => name.endsWith(".tmp"))!;
  assert.ok(orphan, "SIGKILL deixa um temporário completo antes da publicação");
  assert.deepEqual(revisions(runDir), []);
  assert.equal(JSON.parse(readFileSync(join(runDir, orphan), "utf8")).rev, 1);
  assert.deepEqual(store.loadRun(run.runId), { ...run, rev: 0 }, "leitor ignora o temporário órfão");
  const after = store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push("task-after-crash"); });
  assert.equal(after.invocations, 1);
  assert.deepEqual(after.taskIds, ["task-after-crash"]);
  assert.deepEqual(store.loadRun(run.runId), after);
  const next = store.updateRun(run.runId, (fresh) => { fresh.invocations++; });
  assert.equal(next.rev, 2);
  assert.equal(next.invocations, 2);
  assert.ok(existsSync(join(runDir, orphan)), "o órfão continua ignorado após novas publicações");
});

it("CAS: retry 50 atravessa conflitos EEXIST e publica a revisão útil", () => {
  const { store, run } = seedLegacy();
  const originalLink = nativeFs.linkSync;
  let links = 0;
  mock.method(nativeFs, "linkSync", ((source: fs.PathLike, destination: fs.PathLike) => {
    links++;
    if (links <= 49) {
      const error = new Error("stale publication");
      Object.assign(error, { code: "EEXIST" });
      throw error;
    }
    return originalLink(source, destination);
  }) as typeof nativeFs.linkSync);
  syncBuiltinESMExports();
  try {
    const updated = store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push("task-cas-after-50-retries"); });
    assert.equal(links, 50);
    assert.equal(updated.invocations, 1);
    assert.deepEqual(updated.taskIds, ["task-cas-after-50-retries"]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it("CAS: timeout de worker mata e recolhe filho mesmo quando a execução falha", async () => {
  await assert.rejects(worker("setInterval(() => {}, 1000);", [], 100), /worker timeout/);
  assert.equal(children.size, 0);
});
for (const kind of ["run", "chain"] as const) it(`CAS: escritor pausado após ler r recebe EEXIST após 25 revisões e preserva o head (${kind})`, () => {
  const { store, run, chain } = seedLegacy();
  if (kind === "run") store.updateRun(run.runId, () => {});
  else store.updateChain(run.runId, chain.chainId, () => {});
  const directory = revisionDirectory(store, kind, run.runId, chain.chainId);
  const link = nativeFs.linkSync;
  let paused = false, collisions = 0;
  const snapshots = new Map<string, string>();
  const seen: number[] = [];
  mock.method(nativeFs, "linkSync", ((source: fs.PathLike, target: fs.PathLike) => {
    if (!paused) {
      paused = true;
      assert.equal(String(target), join(directory, revisionName(2)), "o escritor já leu r = 1");
      for (let i = 0; i < 25; i++) {
        if (kind === "run") store.updateRun(run.runId, (fresh) => {
          fresh.invocations++;
          fresh.cancelled = true;
          fresh.taskIds.push(`task-interleave-${i}`);
        });
        else store.updateChain(run.runId, chain.chainId, (fresh) => {
          fresh.attempts.push(attempt(`task-interleave-${i}`, i + 1, i === 0 ? "deep" : "standard"));
        });
      }
      for (const name of revisions(directory)) snapshots.set(name, readFileSync(join(directory, name), "utf8"));
    }
    try { return link(source, target); }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "EEXIST", "a publicação antiga colide com uma revisão real");
      collisions++;
      throw error;
    }
  }) as typeof nativeFs.linkSync);
  syncBuiltinESMExports();
  if (kind === "run") {
    const updated = store.updateRun(run.runId, (fresh) => {
      seen.push(fresh.rev!);
      fresh.invocations++;
      fresh.cancelled = false;
      fresh.taskIds.push("task-paused-writer");
    });
    assert.equal(updated.invocations, 26);
    assert.equal(updated.cancelled, true);
    assert.deepEqual(new Set(updated.taskIds), new Set([...Array.from({ length: 25 }, (_, i) => `task-interleave-${i}`), "task-paused-writer"]));
  } else {
    const updated = store.updateChain(run.runId, chain.chainId, (fresh) => {
      seen.push(fresh.rev!);
      fresh.attempts.push(attempt("task-paused-writer", fresh.attempts.length + 1));
      fresh.minTier = "standard";
    });
    assert.equal(updated.minTier, "deep");
    assert.equal(updated.minEffort, "high");
    assert.equal(updated.attempts.length, 26);
    assert.deepEqual(new Set(updated.attempts.map((a) => a.taskId)), new Set([...Array.from({ length: 25 }, (_, i) => `task-interleave-${i}`), "task-paused-writer"]));
    assert.deepEqual(updated.attempts.map((a) => a.attempt), Array.from({ length: 26 }, (_, i) => i + 1));
  }
  assert.equal(paused, true);
  assert.equal(collisions, 1);
  assert.deepEqual(seen, [1, 26], "o callback repete sobre o head real");
  assert.equal(revisions(directory).length, 27);
  for (const [name, content] of snapshots) assert.equal(readFileSync(join(directory, name), "utf8"), content, `revisão ${name} não foi sobrescrita`);
});

for (const code of ["EPERM", "ENOTSUP", "EXDEV"] as const) {
  for (const kind of ["run", "chain"] as const) it(`CAS: link ${code} exige hard links e não publica revisão (${kind})`, () => {
    const { store, run, chain } = seedLegacy();
    const path = kind === "run" ? join(store.runDir(run.runId), "run.json") : store.chainPath(run.runId, chain.chainId);
    const before = readVersioned(path);
    let links = 0;
    mock.method(nativeFs, "linkSync", (() => {
      links++;
      throw Object.assign(new Error("link unavailable"), { code });
    }) as typeof nativeFs.linkSync);
    syncBuiltinESMExports();
    const update = () => kind === "run"
      ? store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.cancelled = true; })
      : store.updateChain(run.runId, chain.chainId, (fresh) => { fresh.minTier = "deep"; fresh.attempts.push(attempt("task-link-failed", 1)); });
    assert.throws(update, new RegExp(`sistema de arquivos .*não suporta hard links \\(link: ${code}\\)`));
    assert.equal(links, 1);
    const directory = revisionDirectory(store, kind, run.runId, chain.chainId);
    assert.deepEqual(readdirSync(directory), [], "sem revisão nem publicação alternativa");
    assert.deepEqual(readVersioned(path), before);
  });
}

for (const failure of ["EIO", "EACCES", "ENOENT", "JSON inválido", "rev divergente"] as const) {
  for (const kind of ["run", "chain"] as const) it(`rodada 5 achado 1: ${failure} ao ler o head propaga sem recuo nem publicação (${kind})`, () => {
    const { store, run, chain } = seedLegacy();
    store.updateRun(run.runId, () => {});
    store.updateRun(run.runId, (fresh) => { fresh.cancelled = true; fresh.invocations = 7; fresh.taskIds.push("task-preserved"); });
    store.updateChain(run.runId, chain.chainId, () => {});
    store.updateChain(run.runId, chain.chainId, (fresh) => {
      fresh.attempts.push({ ...attempt("task-preserved", 1, "deep"), invocations: 7 });
      fresh.status = "cancelled";
    });
    const path = kind === "run" ? join(store.runDir(run.runId), "run.json") : store.chainPath(run.runId, chain.chainId);
    const directory = revisionDirectory(store, kind, run.runId, chain.chainId);
    const before = readVersioned<Run | Chain>(path)!;
    const files = revisions(directory);
    const snapshots = files.map((name) => readFileSync(join(directory, name), "utf8"));
    const head = join(directory, files.at(-1)!);
    const read = nativeFs.readFileSync;
    const injected = Object.assign(new Error(`${failure}: head indisponível`), { code: failure });
    const reads: string[] = [];
    mock.method(nativeFs, "readFileSync", ((...args: Parameters<typeof nativeFs.readFileSync>) => {
      reads.push(String(args[0]));
      if (String(args[0]) === head) {
        if (failure === "JSON inválido") return "{invalid";
        if (failure === "rev divergente") return JSON.stringify({ ...before, rev: before.rev! - 1 });
        throw injected;
      }
      return read(...args);
    }) as typeof nativeFs.readFileSync);
    syncBuiltinESMExports();
    const expected = failure === "JSON inválido" ? SyntaxError
      : failure === "rev divergente" ? /revisão de estado inconsistente/
      : (error: unknown) => error === injected;
    let callbacks = 0;
    const load = () => kind === "run" ? store.loadRun(run.runId) : store.loadChain(run.runId, chain.chainId);
    const update = () => kind === "run"
      ? store.updateRun(run.runId, (fresh) => { callbacks++; fresh.cancelled = false; fresh.invocations = 0; fresh.taskIds = []; })
      : store.updateChain(run.runId, chain.chainId, (fresh) => { callbacks++; fresh.status = "blocked"; fresh.minTier = "light"; fresh.attempts = []; });
    assert.throws(load, expected);
    assert.throws(update, expected);
    assert.equal(callbacks, 0, "não altera estado sem ler o head");
    assert.ok(reads.length >= 2);
    assert.ok(reads.every((file) => file === head), "não lê revisão anterior nem legado");
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(revisions(directory), files, "nenhuma revisão nova");
    assert.deepEqual(files.map((name) => readFileSync(join(directory, name), "utf8")), snapshots);
    assert.deepEqual(load(), before, "cancelamento, invocações, tasks, attempts e pisos preservados");
  });
}

for (const kind of ["run", "chain"] as const) it(`CAS: 35 atualizações retêm todas as revisões e o legado migrado (${kind})`, () => {
  const { store, run, chain } = seedLegacy();
  const path = kind === "run" ? join(store.runDir(run.runId), "run.json") : store.chainPath(run.runId, chain.chainId);
  const legacy = readFileSync(path, "utf8");
  const owner = { pid: process.pid, nonce: "retained-owner" };
  if (kind === "run") store.updateRun(run.runId, () => {});
  else store.updateChain(run.runId, chain.chainId, () => {});
  const directory = revisionDirectory(store, kind, run.runId, chain.chainId);
  const migrated = readFileSync(join(directory, revisionName(1)), "utf8");
  for (let i = 0; i < 35; i++) {
    if (kind === "run") store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push(`task-retained-${i}`); });
    else store.updateChain(run.runId, chain.chainId, (fresh) => {
      fresh.attempts.push(attempt(`task-retained-${i}`, i + 1, i === 0 ? "deep" : "standard"));
      fresh.owner = owner;
    });
  }
  const files = revisions(directory);
  assert.deepEqual(files, Array.from({ length: 36 }, (_, i) => revisionName(i + 1)), "N atualizações + revisão do legado migrado");
  for (let i = 0; i < files.length; i++) {
    const saved = JSON.parse(readFileSync(join(directory, files[i]!), "utf8")) as Run & Chain;
    assert.equal(saved.rev, i + 1);
    if (kind === "run") { assert.equal(saved.invocations, i); assert.equal(saved.taskIds.length, i); }
    else assert.equal(saved.attempts.length, i);
  }
  assert.equal(readFileSync(path, "utf8"), legacy);
  assert.equal(readFileSync(join(directory, revisionName(1)), "utf8"), migrated);
  if (kind === "chain") {
    const saved = store.loadChain(run.runId, chain.chainId)!;
    assert.equal(saved.minTier, "deep");
    assert.deepEqual(saved.owner, owner);
  }
});

for (const kind of ["run", "chain"] as const) it(`rodada 5 achado 2: leitura concorrente vê head ainda presente e nunca registro inexistente (${kind})`, () => {
  const { store, run, chain } = seedLegacy();
  const path = kind === "run" ? join(store.runDir(run.runId), "run.json") : store.chainPath(run.runId, chain.chainId);
  if (kind === "run") store.updateRun(run.runId, (fresh) => { fresh.taskIds.push("task-reader-before"); });
  else store.updateChain(run.runId, chain.chainId, (fresh) => { fresh.attempts.push(attempt("task-reader-before", 1)); });
  const before = readVersioned<Run | Chain>(path)!;
  const directory = revisionDirectory(store, kind, run.runId, chain.chainId);
  const head = join(directory, revisionName(before.rev!));
  const snapshot = readFileSync(head, "utf8");
  const read = nativeFs.readFileSync;
  let triggered = false;
  mock.method(nativeFs, "readFileSync", ((...args: Parameters<typeof nativeFs.readFileSync>) => {
    if (!triggered && String(args[0]) === head) {
      triggered = true;
      // O leitor já escolheu r; outros escritores publicam r+1..r+25 antes de ler r.
      for (let i = 0; i < 25; i++) {
        if (kind === "run") store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.cancelled = true; });
        else store.updateChain(run.runId, chain.chainId, (fresh) => { fresh.attempts.push(attempt(`task-reader-new-${i}`, i + 2, "deep")); });
      }
    }
    return read(...args);
  }) as typeof nativeFs.readFileSync);
  syncBuiltinESMExports();
  const seen = readVersioned<Run | Chain>(path);
  assert.equal(triggered, true);
  assert.deepEqual(seen, before, "o head escolhido continua legível após 25 publicações");
  assert.equal(readFileSync(head, "utf8"), snapshot);
  const current = readVersioned<Run | Chain>(path)!;
  assert.equal(current.rev, before.rev! + 25);
  if (kind === "run") { assert.equal((current as Run).cancelled, true); assert.equal((current as Run).invocations, 25); }
  else { assert.equal((current as Chain).minTier, "deep"); assert.equal((current as Chain).attempts.length, 26); }
});
