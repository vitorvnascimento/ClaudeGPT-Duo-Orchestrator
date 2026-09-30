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

function casMarks(directory: string): string[] {
  return readdirSync(directory).filter((name) => /^\d{12}\.cas$/.test(name)).sort();
}

function revisionNumber(name: string): number {
  return Number(name.slice(0, -5));
}

function revisionName(revision: number): string {
  return `${String(revision).padStart(12, "0")}.json`;
}

function casName(revision: number): string {
  return `${String(revision).padStart(12, "0")}.cas`;
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

it("CAS: escolhe a maior revisão publicada, ignora temporários, falha fechado em corrupção e cai no legado", () => {
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
  writeFileSync(join(runDir, casName(winnerRevision)), "");
  writeFileSync(join(runDir, revisionName(winnerRevision)), JSON.stringify({ ...currentRun, rev: winnerRevision, invocations: 77 }));
  writeFileSync(join(runDir, `${revisionName(winnerRevision + 1)}.tmp`), JSON.stringify({ ...currentRun, rev: winnerRevision + 1, invocations: 999 }));
  writeFileSync(join(runDir, casName(winnerRevision + 4)), "unexpected");
  // Marca sem snapshot (em voo/abortada) e temporário são ignorados: vence a maior revisão publicada.
  assert.equal(store.loadRun(run.runId)!.invocations, 77);

  // Revisão publicada com conteúdo corrompido nunca é pulada em favor de um estado anterior: erro explícito.
  writeFileSync(join(runDir, casName(winnerRevision + 2)), "");
  writeFileSync(join(runDir, revisionName(winnerRevision + 2)), "{invalid");
  assert.throws(() => store.loadRun(run.runId), SyntaxError);
  writeFileSync(join(runDir, revisionName(winnerRevision + 2)), JSON.stringify({ ...currentRun, invocations: 888 }));
  assert.throws(() => store.loadRun(run.runId), /revisão de estado inconsistente/);
  assert.throws(() => store.updateRun(run.runId, (r) => { r.invocations++; }), /revisão de estado inconsistente/);
  rmSync(join(runDir, revisionName(winnerRevision + 2)));
  rmSync(join(runDir, casName(winnerRevision + 2)));
  assert.equal(store.loadRun(run.runId)!.invocations, 77);

  rmSync(join(runDir, revisionName(winnerRevision)));
  assert.equal(store.loadRun(run.runId)!.invocations, 1, "snapshot ausente (podado) recua para a revisão anterior publicada");

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

it("CAS: corrida ABA do lock legado não apaga substituto; caminho morto no CAS", () => {
  const { store, run, chain } = seedLegacy();
  const lock = `${store.chainPath(run.runId, chain.chainId)}.lock`;
  const originalRead = nativeFs.readFileSync;
  let raced = false;
  mock.method(nativeFs, "readFileSync", ((...args: Parameters<typeof nativeFs.readFileSync>) => {
    const path = args[0];
    const content = originalRead(...args);
    if (!raced && String(path) === lock) {
      raced = true;
      nativeFs.rmSync(lock, { force: true });
      writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "replacement" }));
    }
    return content;
  }) as typeof nativeFs.readFileSync);
  syncBuiltinESMExports();

  try {
    store.updateChain(run.runId, chain.chainId, (fresh) => { fresh.minTier = "deep"; });
    if (raced) assert.equal(existsSync(lock), true, "o lock recriado não pode ser apagado pelo dono antigo");
    else assert.equal(existsSync(lock), false, "CAS não deve criar lock legado");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it("rodada 4 achado 1: dois recuperadores e novo escritor não apagam reserva nem snapshot vivo", () => {
  const { store, run, chain } = seedLegacy();
  const path = store.chainPath(run.runId, chain.chainId), lock = `${path}.lock`;
  writeJsonAtomic(path, { ...chain, owner: { pid: 2147483647, nonce: "dead" } });
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, nonce: "dead" }));
  const remove = nativeFs.rmSync, read = nativeFs.readFileSync, link = nativeFs.linkSync;
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
  // HEAD: A já comparou o nonce morto. B recupera, adquire e lê; o rm de A
  // ocorre nesse ponto, liberando C enquanto B ainda guarda o snapshot antigo.
  mock.method(nativeFs, "rmSync", ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target) === lock && active === "a" && !scheduled) {
      scheduled = true;
      update("b");
      return;
    }
    return remove(target, options);
  }) as typeof nativeFs.rmSync);
  mock.method(nativeFs, "readFileSync", ((...args: Parameters<typeof nativeFs.readFileSync>) => {
    const result = read(...args);
    if (String(args[0]) === path && active === "b" && !removed) {
      removed = true;
      remove(lock); // conclusão da operação rm de A suspensa acima
      update("c");
    }
    return result;
  }) as typeof nativeFs.readFileSync);
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

it("CAS: escritor pausado antes da marca relê após mais de 20 updates e não publica revisão antiga", () => {
  const { store, run } = seedLegacy();
  const originalOpen = nativeFs.openSync;
  let paused = false;
  let markerPath = "";
  mock.method(nativeFs, "openSync", ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(path, flags, mode);
    if (!paused && String(path).endsWith(".cas") && String(flags) === "wx") {
      paused = true;
      markerPath = String(path);
      for (let i = 0; i < 25; i++) {
        store.updateRun(run.runId, (fresh) => {
          fresh.invocations++;
          fresh.taskIds.push(`task-cas-interleave-${i}`);
        });
      }
    }
    return fd;
  }) as typeof nativeFs.openSync);
  syncBuiltinESMExports();

  let callbacks = 0;
  try {
    const result = store.updateRun(run.runId, (fresh) => {
      callbacks++;
      fresh.invocations++;
      fresh.taskIds.push("task-cas-paused-writer");
    });
    assert.equal(paused, true);
    assert.ok(callbacks >= 2, `publicação antiga não foi refeita: ${callbacks}`);
    assert.equal(result.invocations, 26);
    assert.equal(result.taskIds.length, 26);
    assert.equal(store.loadRun(run.runId)!.taskIds.includes("task-cas-paused-writer"), true);
    assert.equal(existsSync(markerPath), true, "marca reservada permanece para impedir publicação tardia");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it("CAS: marca criada e depois abortada sela destino vazio, que nunca é sobrescrito ou podado", () => {
  const { store, run } = seedLegacy();
  const originalOpen = nativeFs.openSync;
  let paused = false;
  let markerPath = "";
  mock.method(nativeFs, "openSync", ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(path, flags, mode);
    if (!paused && String(path).endsWith(".cas") && String(flags) === "wx") {
      paused = true;
      markerPath = String(path);
      for (let i = 0; i < 25; i++) {
        store.updateRun(run.runId, (fresh) => {
          fresh.invocations++;
          fresh.taskIds.push(`task-cas-abort-${i}`);
        });
      }
    }
    return fd;
  }) as typeof nativeFs.openSync);
  syncBuiltinESMExports();

  try {
    const result = store.updateRun(run.runId, (fresh) => {
      fresh.invocations++;
      fresh.taskIds.push("task-cas-original-after-abort");
    });
    const destination = markerPath.replace(/\.cas$/, ".json");
    assert.equal(result.invocations, 26);
    assert.equal(readFileSync(destination, "utf8"), "", "snapshot abortado deve continuar vazio");
    assert.equal(existsSync(markerPath), true, "marca abortada é permanente");
    assert.equal(store.loadRun(run.runId)!.taskIds.includes("task-cas-original-after-abort"), true);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
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
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { Store } from ${JSON.stringify(new URL("../src/state/store.js", import.meta.url).href)};
    const [root, runId] = process.argv.slice(1);
    const original = fs.linkSync;
    fs.linkSync = (source, destination) => { fs.statSync(source); process.kill(process.pid, 'SIGKILL'); return original(source, destination); };
    syncBuiltinESMExports();
    new Store(root).updateRun(runId, (fresh) => { fresh.invocations++; fresh.taskIds.push('task-crash-before-link'); });
  `;
  const crashed = await worker(script, [store.projectRoot, run.runId]);
  assert.equal(crashed.signal, "SIGKILL", `${crashed.stderr}\n${crashed.stdout}`);
  const after = store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push("task-after-crash"); });
  assert.equal(after.invocations, 1);
  assert.deepEqual(after.taskIds, ["task-after-crash"]);
  assert.doesNotThrow(() => store.loadRun(run.runId));
  const runDir = revisionDirectory(store, "run", run.runId);
  assert.ok(readdirSync(runDir).some((name) => name.includes("tmp")), "o temporário do processo morto deve ser observável para a poda");
});

it("CAS: SIGKILL após a marca e antes do snapshot sela o destino abortado", async () => {
  const { store, run } = seedLegacy();
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { Store } from ${JSON.stringify(new URL("../src/state/store.js", import.meta.url).href)};
    const [root, runId] = process.argv.slice(1);
    const original = fs.openSync;
    let killed = false;
    fs.openSync = (path, flags, mode) => {
      const fd = original(path, flags, mode);
      if (!killed && String(path).endsWith('.cas') && String(flags) === 'wx') {
        killed = true;
        process.kill(process.pid, 'SIGKILL');
      }
      return fd;
    };
    syncBuiltinESMExports();
    new Store(root).updateRun(runId, (fresh) => { fresh.invocations++; fresh.taskIds.push('task-crash-after-marker'); });
  `;
  const crashed = await worker(script, [store.projectRoot, run.runId]);
  assert.equal(crashed.signal, "SIGKILL", `${crashed.stderr}\n${crashed.stdout}`);
  const runDir = revisionDirectory(store, "run", run.runId);
  const marks = casMarks(runDir);
  assert.equal(marks.length, 1, "o processo morto deixa exatamente a reserva observável");
  const destination = join(runDir, marks[0]!.replace(/\.cas$/, ".json"));
  const after = store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push("task-after-marker-crash"); });
  assert.equal(after.invocations, 1);
  assert.deepEqual(after.taskIds, ["task-after-marker-crash"]);
  assert.equal(readFileSync(destination, "utf8"), "", "destino abortado é selado vazio");
  assert.equal(existsSync(join(runDir, marks[0]!)), true, "marca permanece após o aborto");
});

for (const code of ["EPERM", "ENOTSUP"] as const) it(`CAS: fallback open wx aceita ${code} e preserva a revisão`, () => {
  const { store, run } = seedLegacy();
  mock.method(nativeFs, "linkSync", (() => {
    const error = new Error("link unavailable");
    Object.assign(error, { code });
    throw error;
  }) as typeof nativeFs.linkSync);
  syncBuiltinESMExports();
  try {
    const updated = store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.cancelled = true; });
    assert.equal(updated.invocations, 1);
    assert.equal(updated.cancelled, true);
    assert.equal(store.loadRun(run.runId)!.cancelled, true);
    const directory = revisionDirectory(store, "run", run.runId);
    assert.ok(revisions(directory).length >= 1);
    const decisions = readdirSync(directory).filter((name) => name.endsWith(".wx.d"));
    assert.ok(decisions.some((name) => existsSync(join(directory, name, "commit"))), "fallback publica decisão commitável");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it("CAS: fallback pausado após open wx perde para aborto concorrente e refaz a publicação", () => {
  const { store, run } = seedLegacy();
  const originalOpen = nativeFs.openSync;
  let paused = false;
  let markerPath = "";
  mock.method(nativeFs, "linkSync", (() => {
    const error = new Error("link unavailable");
    Object.assign(error, { code: "EPERM" });
    throw error;
  }) as typeof nativeFs.linkSync);
  mock.method(nativeFs, "openSync", ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(path, flags, mode);
    const target = String(path);
    if (!paused && target.endsWith(".json") && String(flags) === "wx" && existsSync(`${target.slice(0, -5)}.wx`)) {
      paused = true;
      markerPath = `${target.slice(0, -5)}.wx`;
      store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push("task-cas-fallback-concurrent"); });
    }
    return fd;
  }) as typeof nativeFs.openSync);
  syncBuiltinESMExports();

  let callbacks = 0;
  try {
    const updated = store.updateRun(run.runId, (fresh) => { callbacks++; fresh.invocations++; fresh.taskIds.push("task-cas-fallback-original"); });
    const base = markerPath.replace(/\.wx$/, "");
    assert.equal(paused, true);
    assert.ok(callbacks >= 2, `fallback abortado não refez callback: ${callbacks}`);
    assert.equal(updated.invocations, 2);
    assert.deepEqual(new Set(updated.taskIds), new Set(["task-cas-fallback-concurrent", "task-cas-fallback-original"]));
    assert.equal(existsSync(`${base}.wx.d/abort`), true, "decisão abort é permanente");
    assert.equal(store.loadRun(run.runId)!.invocations, 2, "leitor ignora publicação tardia abortada e preserva ambos updates");
    assert.deepEqual(new Set(store.loadRun(run.runId)!.taskIds), new Set(["task-cas-fallback-concurrent", "task-cas-fallback-original"]));
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it("CAS: leitor que perde a maior revisão durante read recua para snapshot válido anterior", () => {
  const { store, run } = seedLegacy();
  store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push("task-cas-reader-1"); });
  store.updateRun(run.runId, (fresh) => { fresh.invocations++; fresh.taskIds.push("task-cas-reader-2"); });
  const directory = revisionDirectory(store, "run", run.runId);
  const latest = revisions(directory).at(-1)!;
  const latestPath = join(directory, latest);
  let removed = false;
  const originalRead = nativeFs.readFileSync;
  mock.method(nativeFs, "readFileSync", ((...args: Parameters<typeof nativeFs.readFileSync>) => {
    const path = args[0];
    if (!removed && String(path) === latestPath) {
      removed = true;
      nativeFs.rmSync(latestPath, { force: true });
    }
    return originalRead(...args);
  }) as typeof nativeFs.readFileSync);
  syncBuiltinESMExports();

  try {
    const loaded = store.loadRun(run.runId)!;
    assert.equal(removed, true);
    assert.equal(loaded.invocations, 1);
    assert.deepEqual(loaded.taskIds, ["task-cas-reader-1"]);
    assert.equal(existsSync(join(directory, latest.replace(/\.json$/, ".cas"))), true);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it("CAS: poda e migração mantêm entradas, piso e owner mesmo se uma revisão some", () => {
  const { store, run, chain } = seedLegacy();
  const owner = { pid: process.pid, nonce: "migration-owner" };
  for (let i = 0; i < 80; i++) {
    store.updateChain(run.runId, chain.chainId, (fresh) => {
      const taskId = `task-cas-poda-${String(i).padStart(2, "0")}`;
      fresh.attempts.push(attempt(taskId, fresh.attempts.length + 1, i % 2 ? "standard" : "deep"));
      fresh.floorTier = "deep";
      fresh.owner = owner;
    });
  }
  const directory = revisionDirectory(store, "chain", run.runId, chain.chainId);
  const files = revisions(directory);
  assert.ok(files.length >= 1);
  rmSync(join(directory, files.at(-1)!));
  const loaded = store.loadChain(run.runId, chain.chainId)!;
  assert.ok(loaded.attempts.length > 0, "revisão anterior deve continuar legível");
  assert.equal(loaded.minTier, "deep");
  assert.deepEqual(loaded.owner, owner);
  assert.equal(store.loadChain(run.runId, chain.chainId)!.attempts.every((entry) => entry.taskId.startsWith("task-cas-poda-")), true);
});

it("CAS: poda só remove snapshots válidos mais antigos que 20 e nunca remove marcas", () => {
  const { store, run } = seedLegacy();
  for (let i = 0; i < 35; i++) {
    store.updateRun(run.runId, (fresh) => {
      fresh.invocations++;
      fresh.taskIds.push(`task-cas-prune-${i}`);
    });
  }
  const directory = revisionDirectory(store, "run", run.runId);
  const marks = casMarks(directory);
  const latest = Math.max(...marks.map(revisionNumber));
  const snapshots = revisions(directory);
  const valid = snapshots.filter((name) => {
    try { return JSON.parse(readFileSync(join(directory, name), "utf8")).rev === revisionNumber(name); }
    catch { return false; }
  });
  assert.ok(marks.length >= 35);
  assert.ok(valid.every((name) => revisionNumber(name) >= latest - 20), `snapshot antigo não podado: ${valid.join(",")}`);
  assert.equal(existsSync(join(directory, casName(1))), true, "marca antiga permanece");
  assert.equal(store.loadRun(run.runId)!.invocations, 35);
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

it("rodada 5 achado 1: EIO ao ler a revisão confirmada nunca publica estado anterior (Run e Chain)", () => {
  const root = freshRoot();
  const store = new Store(root);
  const run = makeRun("run-cas-eio001");
  store.updateRun(run.runId, () => {}, run);
  store.updateRun(run.runId, (r) => { r.cancelled = true; r.invocations = 1; r.taskIds.push("task-a"); });
  const chain = makeChain(run.runId, "task-eio-chain1");
  writeJsonAtomic(store.chainPath(run.runId, chain.chainId), chain);
  store.updateChain(run.runId, chain.chainId, (c) => { c.minTier = "standard"; c.minEffort = "medium"; });
  store.updateChain(run.runId, chain.chainId, (c) => { c.minTier = "deep"; c.minEffort = "high"; });
  const runDir = revisionDirectory(store, "run", run.runId), chainDir = revisionDirectory(store, "chain", run.runId, chain.chainId);
  const runBefore = revisions(runDir), chainBefore = revisions(chainDir);
  const real = nativeFs.readFileSync;
  const heads = [join(runDir, runBefore.at(-1)!), join(chainDir, chainBefore.at(-1)!)];
  mock.method(nativeFs, "readFileSync", ((...args: Parameters<typeof nativeFs.readFileSync>) => {
    if (heads.includes(String(args[0]))) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    return real(...args);
  }) as typeof nativeFs.readFileSync);
  syncBuiltinESMExports();
  assert.throws(() => store.updateRun(run.runId, (r) => { r.taskIds.push("task-b"); }), /EIO/);
  assert.throws(() => store.updateChain(run.runId, chain.chainId, (c) => { c.updatedAt = iso(); }), /EIO/);
  assert.throws(() => readVersioned(join(store.runDir(run.runId), "run.json")), /EIO/);
  mock.restoreAll();
  syncBuiltinESMExports();
  assert.deepEqual(revisions(runDir), runBefore, "nenhuma revisão nova publicada a partir de estado antigo");
  assert.deepEqual(revisions(chainDir), chainBefore);
  const saved = store.loadRun(run.runId)!;
  assert.equal(saved.cancelled, true); assert.equal(saved.invocations, 1); assert.deepEqual(saved.taskIds, ["task-a"]);
  const c = readVersioned<Chain>(store.chainPath(run.runId, chain.chainId))!;
  assert.equal(c.minTier, "deep"); assert.equal(c.minEffort, "high");
});

it("rodada 5 achado 2: leitura atropelada pela poda relê o head novo em vez de declarar o registro inexistente", () => {
  const root = freshRoot();
  const store = new Store(root);
  const run = makeRun("run-cas-prune01");
  const path = join(store.runDir(run.runId), "run.json");
  for (let i = 0; i < 22; i++) store.updateRun(run.runId, (r) => { r.taskIds.push(`task-${i}`); }, run);
  rmSync(path, { force: true });
  const dir = revisionDirectory(store, "run", run.runId);
  const real = nativeFs.readFileSync;
  let triggered = false;
  mock.method(nativeFs, "readFileSync", ((...args: Parameters<typeof nativeFs.readFileSync>) => {
    if (!triggered && String(args[0]).startsWith(dir) && String(args[0]).endsWith(".json")) {
      triggered = true;
      // Outro processo publica 22 revisões e poda as antigas enquanto este leitor está no meio da leitura.
      mock.restoreAll();
      syncBuiltinESMExports();
      for (let i = 0; i < 22; i++) store.updateRun(run.runId, (r) => { r.cancelled = i === 21 ? true : r.cancelled; });
      for (const name of revisions(dir).slice(0, -21)) rmSync(join(dir, name), { force: true });
      mock.method(nativeFs, "readFileSync", ((...a: Parameters<typeof nativeFs.readFileSync>) => real(...a)) as typeof nativeFs.readFileSync);
      syncBuiltinESMExports();
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return real(...args);
  }) as typeof nativeFs.readFileSync);
  syncBuiltinESMExports();
  const seen = readVersioned<Run>(path);
  assert.ok(triggered);
  assert.ok(seen, "o Run não pode desaparecer durante a poda");
  assert.equal(seen.cancelled, true, "o leitor vê o cancelamento publicado");
  assert.equal(seen.taskIds.length, 22);
});
