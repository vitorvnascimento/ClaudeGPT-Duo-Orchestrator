import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { isPidAlive } from "../src/adapters/process.js";
import { applyTask, cancelRun } from "../src/orchestration/control.js";
import { activeSlots, ExecutorSlots, inspectCodexProcesses, inspectSlots, recoverSlotsLocked, releaseOrphanSlot, withAdmission, type AdmitRequest, type SlotInfo } from "../src/state/slots.js";
import { processStartTime, startedAfterReservation } from "../src/state/process-identity.js";
import { readJson, writeJsonAtomic } from "../src/state/store.js";

const roots: string[] = [];
const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
const owners: ExecutorSlots[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "duo-exclusive-")); roots.push(p); return p; };
const owner = (p: string, max = 8) => { const s = new ExecutorSlots(p, max); owners.push(s); return s; };
const req = (patch: Partial<AdmitRequest> = {}): AdmitRequest => ({ taskId: "task-exclusive-000000", runId: "run-exclusive-000000", kind: "implement", requested: "worktree", fixed: null, gitReady: true, ...patch });
afterEach(() => { for (const s of owners.splice(0)) s.release(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

it("slot exclusivo worktree mantém isolamento, espelho e bloqueia todas as admissões até liberar", () => {
  const p = root(), exclusive = owner(p);
  assert.deepEqual(exclusive.admit(req({ exclusive: true })), { ok: true, isolation: "worktree", forced: false });
  assert.equal(activeSlots(p)[0]?.exclusive, true);
  assert.equal(readJson<{ slots: boolean; exclusive: boolean }>(join(p, ".duo/lock.json"))?.exclusive, true);
  assert.equal(readJson<{ slots: boolean }>(join(p, ".duo/lock.json"))?.slots, true);
  for (const requested of ["worktree", "in-place"] as const) {
    for (const isExclusive of [false, true]) {
      assert.match(JSON.stringify(owner(p).admit(req({ requested, exclusive: isExclusive }))), /exclusivo.*aguarde/);
    }
  }
  exclusive.release();
  assert.equal(owner(p).admit(req()).ok, true);
});

it("v0.4.0 refuses admission and apply for an active computer-use worktree reservation", () => {
  const p = root(), exclusive = owner(p);
  const locks = join(p, ".duo/locks");
  // Copied from d107cbe: activeSlots reads the raw slot using only the bridge PID.
  // Both v0.4.0 exclusion predicates ignore the newer exclusive and childPid fields.
  const legacyActive = () => readdirSync(locks).filter(name => /^slot-\d+\.json$/.test(name)).flatMap(name => {
    const s = readJson<{ pid: number; isolation: string }>(join(locks, name));
    return s && isPidAlive(s.pid) ? [s] : [];
  });
  const refusesAdmission = () => legacyActive().some((s) => s.isolation === "in-place");
  const refusesApply = () => legacyActive().some((slot) => slot.isolation === "in-place");
  assert.deepEqual(exclusive.admit(req({ exclusive: true })), { ok: true, isolation: "worktree", forced: false });
  assert.equal(refusesAdmission(), true);
  assert.equal(refusesApply(), true);
  assert.equal(readJson<{ isolation: string }>(join(p, ".duo/lock.json"))?.isolation, "in-place");
  exclusive.release();
  assert.equal(refusesAdmission(), false);
  assert.equal(refusesApply(), false);
});

it("registerChildPid publica o filho no slot sob o nonce do dono", () => {
  const p = root(), slots = owner(p);
  assert.equal(slots.admit(req({ exclusive: true })).ok, true);
  slots.registerChildPid(process.pid);
  const saved = readJson<{ childPid: number }>(join(p, ".duo/locks/slot-0.json"));
  assert.equal(saved?.childPid, process.pid);
});

it("registerChildPid recusa PID inválido e slot perdido", () => {
  const p = root(), slots = owner(p);
  assert.equal(slots.admit(req({ exclusive: true })).ok, true);
  assert.throws(() => slots.registerChildPid(0), /PID do filho inválido/);
  slots.release();
  assert.throws(() => slots.registerChildPid(process.pid), /slot sem dono local/);
});

it("exclusivo exige projeto livre mesmo com worktree antigo sem campo exclusive", () => {
  const p = root(), regular = owner(p);
  assert.equal(regular.admit(req()).ok, true);
  assert.equal(activeSlots(p)[0]?.exclusive, undefined);
  assert.equal(owner(p).admit(req({ taskId: "outra" })).ok, true);
  assert.match(JSON.stringify(owner(p).admit(req({ exclusive: true }))), /projeto livre.*aguarde/);
});

it("exclusivo in-place também exige projeto livre e bloqueia os demais", () => {
  const p = root(), exclusive = owner(p);
  assert.deepEqual(exclusive.admit(req({ requested: "in-place", exclusive: true })), { ok: true, isolation: "in-place", forced: false });
  assert.match(JSON.stringify(owner(p).admit(req())), /exclusivo.*aguarde/);
  exclusive.release();
  assert.equal(owner(p).admit(req({ exclusive: true, requested: "in-place" })).ok, true);
});

it("apply é recusado durante worktree exclusivo e volta a prosseguir após release", () => {
  const p = root(), exclusive = owner(p);
  assert.equal(exclusive.admit(req({ exclusive: true })).ok, true);
  assert.match(applyTask(p, "inexistente").message, /exclusivo.*aguarde/);
  exclusive.release();
  assert.match(applyTask(p, "inexistente").message, /task não encontrada/);
  assert.equal(owner(p).admit(req()).ok, true);
  assert.match(applyTask(p, "inexistente").message, /task não encontrada/);
});

it("registro exclusivo ilegível fecha activeSlots e apply até a limpeza", () => {
  const p = root(), path = join(p, ".duo/locks/slot-0.json");
  mkdirSync(join(p, ".duo/locks"), { recursive: true });
  writeFileSync(path, '{"exclusive":true');
  assert.equal(activeSlots(p).length, 1);
  assert.equal(activeSlots(p)[0]?.exclusive, true);
  assert.match(applyTask(p, "inexistente").message, /exclusivo.*aguarde/);
  assert.match(JSON.stringify(owner(p).admit(req())), /exclusivo.*aguarde/);
});

it("registro exclusivo válido porém malformado é removido só após dez segundos", () => {
  const p = root(), path = join(p, ".duo/locks/slot-0.json");
  writeJsonAtomic(path, { ...req(), slot: 0, isolation: "worktree", exclusive: true, pid: process.pid, nonce: "malformed-time", startedAt: "garbage" });
  assert.equal(activeSlots(p).length, 1);
  assert.match(JSON.stringify(owner(p).admit(req())), /exclusivo.*aguarde/);
  const stale = new Date(Date.now() - 11_000);
  utimesSync(path, stale, stale);
  assert.equal(owner(p).admit(req()).ok, true);
});

it("ponte morta em spawning continua fechada até a recuperação manual confirmada", { skip: process.platform === "win32" }, (t) => {
  const p = root(), bridge = deadPid();
  writeJsonAtomic(join(p, ".duo/locks/slot-0.json"), {
    ...req(), slot: 0, isolation: "in-place", exclusive: true, pid: bridge, nonce: "spawning-orphan",
    startedAt: new Date().toISOString(), phase: "spawning", spawnStartedAt: new Date().toISOString(),
    spawnCommand: "codex", spawnCwd: p, childPid: null,
  });
  writeJsonAtomic(auditPath(p), audit(bridge, null));
  assert.equal(activeSlots(p).length, 1);
  assert.equal(owner(p).admit(req()).ok, false);
  assert.match(applyTask(p, "missing").message, /exclusivo/);
  let listing = `1234 codex codex exec --cd ${p}\n`;
  t.mock.method(childProcess, "spawnSync", (() => ({ status: 0, stdout: listing })) as unknown as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    assert.equal(releaseOrphanSlot(p, "spawning-orphan", true).ok, false);
    assert.equal(activeSlots(p).length, 1);
    listing = "";
    assert.equal(releaseOrphanSlot(p, "spawning-orphan", true).ok, false);
    assert.equal(activeSlots(p).length, 1);
    listing = "1 launchd /sbin/launchd\n";
    assert.equal(releaseOrphanSlot(p, "spawning-orphan", false).ok, false);
    assert.equal(releaseOrphanSlot(p, "spawning-orphan", true).ok, true);
    assert.equal(activeSlots(p).length, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("probe de spawning cruza cwd e argv sem persistir ou comparar o projeto inteiro", { skip: process.platform === "win32" }, (t) => {
  const p = root(), cwd = join(p, "worktree with spaces");
  const slot: SlotInfo = {
    slot: 0, pid: deadPid(), taskId: "task-probe-000000", runId: "run-probe-000000", nonce: "probe",
    startedAt: new Date().toISOString(), isolation: "in-place", kind: "implement", exclusive: true,
    phase: "spawning", spawnStartedAt: new Date().toISOString(), spawnCommand: "codex", spawnCwd: cwd, childPid: null,
  };
  let argv = `123 /Applications/CLI Tools/codex codex exec --cd ${cwd}\n`;
  let currentDir = "/private/other";
  t.mock.method(childProcess, "spawnSync", ((command: string, args: string[]) => {
    if (command === "/bin/ps") {
      assert.deepEqual(args, ["-ww", "-axo", "pid=,comm=,args="]);
      return { status: 0, stdout: argv };
    }
    assert.equal(command, process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof");
    assert.deepEqual(args, ["-a", "-p", "123", "-d", "cwd", "-Fpn"]);
    return { status: 0, stdout: `p123\nfcwd\nn${currentDir}\n` };
  }) as unknown as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(inspectCodexProcesses(slot), { ok: true, pids: [123] });
    argv = "123 node node /Applications/CLI Tools/codex.js exec resume\n";
    assert.deepEqual(inspectCodexProcesses(slot), { ok: true, pids: [] });
    currentDir = cwd;
    assert.deepEqual(inspectCodexProcesses(slot), { ok: true, pids: [123] });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("probe de spawning falha fechado para ps vazio", (t) => {
  const p = root();
  const slot = {
    slot: 0, pid: deadPid(), taskId: "task-probe-000000", runId: "run-probe-000000", nonce: "probe",
    startedAt: new Date().toISOString(), isolation: "in-place" as const, kind: "implement" as const, exclusive: true,
    phase: "spawning" as const, spawnStartedAt: new Date().toISOString(), spawnCommand: "codex", spawnCwd: p, childPid: null,
  };
  t.mock.method(childProcess, "spawnSync", (() => ({ status: 0, stdout: "" })) as unknown as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try { assert.equal(inspectCodexProcesses(slot).ok, false); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("childPid malformado fecha a reserva e não permite remoção manual", () => {
  const p = root(), path = join(p, ".duo/locks/slot-0.json"), bridge = deadPid();
  writeJsonAtomic(path, { ...req(), slot: 0, isolation: "worktree", exclusive: true, pid: bridge, nonce: "malformed-child", startedAt: new Date().toISOString(), childPid: 0 });
  assert.equal(activeSlots(p).length, 1);
  assert.equal(releaseOrphanSlot(p, "malformed-child", true).ok, false);
  const stale = new Date(Date.now() - 11_000);
  utimesSync(path, stale, stale);
  assert.equal(owner(p).admit(req()).ok, true);
});

const auditPath = (p: string) => join(p, ".duo/runs", req().runId, "tasks", req().taskId, "task.json");
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;
function orphanSlot(p: string, bridge: number): void {
  writeJsonAtomic(join(p, ".duo/locks/slot-0.json"), { ...req(), slot: 0, isolation: "worktree", exclusive: true, pid: bridge, nonce: "orphan", startedAt: new Date().toISOString() });
}
function audit(bridge: number, child: number | null) {
  return { taskId: req().taskId, runId: req().runId, state: "running", pids: { bridge, child }, history: [],
    executor: "codex", kind: "implement", scope: [], acceptanceCriteria: [], tags: [], model: { requested: null }, invocations: 1 };
}

it("comparação de início é conservadora com segundos e timestamps inválidos", () => {
  const reservation = "2020-01-01T00:00:00.500Z";
  assert.equal(startedAfterReservation(reservation, Date.parse("2020-01-01T00:00:00Z")), false);
  assert.equal(startedAfterReservation(reservation, Date.parse("2020-01-01T00:00:01Z")), true);
  assert.equal(startedAfterReservation("0", Date.now()), false);
  assert.equal(startedAfterReservation(reservation, null), false);
});

it("lstart no macOS usa UTC, valida saída e trata falhas como desconhecidas", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  let stdout = "Wed Jan  1 00:00:02 2020\n";
  t.mock.method(childProcess, "spawnSync", ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    assert.equal(command, "/bin/ps");
    assert.deepEqual(args, ["-p", "123", "-o", "lstart="]);
    assert.equal(options.env.TZ, "UTC0");
    assert.equal(options.env.LC_ALL, "C");
    return { status: 0, stdout };
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    assert.equal(processStartTime(123), Date.parse("2020-01-01T00:00:02Z"));
    stdout = "garbage";
    assert.equal(processStartTime(123), null);
    stdout = "Wed Feb 31 00:00:02 2020";
    assert.equal(processStartTime(123), null);
    assert.equal(processStartTime(-1), null);
  } finally { t.mock.restoreAll(); Object.defineProperty(process, "platform", platform); syncBuiltinESMExports(); }
});

it("metadados nativos identificam o processo atual no macOS", { skip: process.platform !== "darwin" }, (t) => {
  const probe = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC0" } });
  if (probe.error || probe.status !== 0) { t.skip(`ps indisponível: ${(probe.error as NodeJS.ErrnoException | undefined)?.code ?? probe.status}`); return; }
  const started = processStartTime(process.pid);
  assert.notEqual(started, null, `saída nativa inesperada: ${JSON.stringify(probe.stdout)}`);
  assert.ok(started! <= Date.now());
});

for (const state of ["approved", "succeeded", "failed", "cancelled"]) {
  it(`crash da ponte em ${state} sem filho não bloqueia admissão ou apply`, () => {
    const p = root(), bridge = deadPid();
    orphanSlot(p, bridge);
    writeJsonAtomic(auditPath(p), { ...audit(bridge, null), state });
    assert.equal(activeSlots(p).length, 0);
    assert.match(applyTask(p, "inexistente").message, /task não encontrada/);
    assert.equal(owner(p).admit(req()).ok, true);
  });
}

for (const terminal of [false, true]) {
  it(`processo da ponte cai ${terminal ? "após salvar terminal" : "entre admit e execute"} sem release`, () => {
    const p = root(), slotModule = new URL("../src/state/slots.js", import.meta.url).href;
    const storeModule = new URL("../src/state/store.js", import.meta.url).href;
    const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { ExecutorSlots } from ${JSON.stringify(slotModule)};
      import { writeJsonAtomic } from ${JSON.stringify(storeModule)};
      const task = ${JSON.stringify(audit(0, null))};
      task.pids.bridge = process.pid; task.state = "approved";
      writeJsonAtomic(${JSON.stringify(auditPath(p))}, task);
      const slots = new ExecutorSlots(${JSON.stringify(p)}, 4);
      if (!slots.admit(${JSON.stringify(req({ exclusive: true }))}).ok) process.exit(1);
      if (${terminal}) { task.state = "succeeded"; writeJsonAtomic(${JSON.stringify(auditPath(p))}, task); }
      process.exit(23);
    `], { encoding: "utf8" });
    assert.equal(crash.status, 23, crash.stderr);
    assert.ok(readJson(join(p, ".duo/locks/slot-0.json")), "slot foi deixado pela ponte");
    assert.equal(activeSlots(p).length, 0);
    assert.match(applyTask(p, "inexistente").message, /task não encontrada/);
    assert.equal(owner(p).admit(req()).ok, true);
  });
}

it("retomada limpa reserva anterior antes de gravar nova ponte e aceita child nulo legado", () => {
  const p = root(), bridge = deadPid();
  orphanSlot(p, bridge);
  writeJsonAtomic(auditPath(p), { ...audit(bridge, deadPid()), state: "blocked" });
  let prepared = false;
  const resumed = owner(p);
  assert.equal(resumed.admit(req({ exclusive: true }), () => {
    assert.equal(activeSlots(p).length, 0);
    writeJsonAtomic(auditPath(p), { ...audit(process.pid, null), state: "approved" });
    prepared = true;
  }).ok, true);
  assert.equal(prepared, true);
  resumed.release();
  orphanSlot(p, bridge);
  writeJsonAtomic(auditPath(p), audit(bridge, null));
  assert.equal(owner(p).admit(req({ exclusive: true })).ok, true);
});

it("ponte morta mantém exclusividade enquanto filho auditado vive e libera após sua morte", async () => {
  const p = root(), bridge = deadPid();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    assert.ok(child.pid);
    orphanSlot(p, bridge);
    writeJsonAtomic(auditPath(p), audit(bridge, child.pid));
    assert.equal(activeSlots(p).length, 1);
    for (const exclusive of [false, true]) assert.match(JSON.stringify(owner(p).admit(req({ exclusive }))), /exclusivo.*aguarde/);
    assert.match(applyTask(p, "inexistente").message, /exclusivo.*aguarde/);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    assert.equal(activeSlots(p).length, 0);
    assert.match(applyTask(p, "inexistente").message, /task não encontrada/);
    assert.equal(owner(p).admit(req()).ok, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
});

it("legacy exclusive null PID needs a confirmed process scan after a bridge crash", { skip: process.platform === "win32" }, t => {
  const p = root(), bridge = deadPid();
  writeJsonAtomic(join(p, ".duo/locks/slot-0.json"), { ...req(), slot: 0, isolation: "in-place", exclusive: true, pid: bridge, nonce: "orphan", startedAt: new Date().toISOString(), childPid: null });
  writeJsonAtomic(auditPath(p), audit(bridge, null));
  assert.equal(activeSlots(p).length, 1);
  assert.match(applyTask(p, "missing").message, /exclusivo/);
  let listing = `123 codex codex exec --output-schema /data/${req().taskId}/schema.json\n`;
  t.mock.method(childProcess, "spawnSync", (() => ({ status: 0, stdout: listing })) as unknown as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    assert.equal(releaseOrphanSlot(p, "orphan", true).ok, false);
    listing = "1 launchd /sbin/launchd\n";
    assert.equal(releaseOrphanSlot(p, "orphan", true).ok, true);
    assert.equal(activeSlots(p).length, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("slot ordinário permanece ativo enquanto o filho auditado vive após a morte da ponte", async () => {
  const p = root(), bridge = deadPid();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    assert.ok(child.pid);
    writeJsonAtomic(join(p, ".duo/locks/slot-0.json"), { ...req(), slot: 0, isolation: "worktree", pid: bridge, nonce: "ordinary", startedAt: new Date().toISOString(), childPid: child.pid });
    assert.equal(activeSlots(p).length, 1);
    assert.match(JSON.stringify(owner(p, 1).admit(req({ taskId: "task-outra-000000" }))), /limite de 1/);
    assert.match(applyTask(p, "inexistente").message, /task não encontrada/);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    assert.equal(activeSlots(p).length, 0);
    assert.equal(owner(p, 1).admit(req()).ok, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
});

it("auditoria ausente, inválida ou divergente mantém reserva exclusiva fechada", () => {
  const p = root(), bridge = deadPid(), path = auditPath(p);
  orphanSlot(p, bridge);
  const invalid = [null, {}, { ...audit(bridge, deadPid()), taskId: "task-outra-000000" },
    { ...audit(bridge, deadPid()), runId: "run-outra-000000" }, { ...audit(bridge + 1, deadPid()) },
    { ...audit(bridge, deadPid()), state: "invalido" }, { ...audit(bridge, -1) }];
  for (const value of invalid) {
    if (value) writeJsonAtomic(path, value);
    assert.equal(activeSlots(p).length, 1);
    assert.match(JSON.stringify(owner(p).admit(req())), /exclusivo.*aguarde/);
    assert.match(applyTask(p, "inexistente").message, /exclusivo.*aguarde/);
  }
  writeFileSync(path, "{incompleto");
  assert.equal(activeSlots(p).length, 1);
  assert.equal(owner(p).admit(req()).ok, false);
  orphanSlot(p, bridge);
  writeJsonAtomic(join(p, ".duo/locks/slot-0.json"), { ...req(), runId: "../../fora", taskId: "../../fora", slot: 0, isolation: "worktree", exclusive: true, pid: bridge });
  assert.equal(activeSlots(p).length, 1);
  assert.equal(owner(p).admit(req()).ok, false);
});

it("cancelRun recupera reserva órfã registrando task cancelada e filho nulo", async () => {
  const p = root(), bridge = deadPid();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    assert.ok(child.pid);
    orphanSlot(p, bridge);
    writeJsonAtomic(auditPath(p), audit(bridge, child.pid));
    writeJsonAtomic(join(p, ".duo/runs", req().runId, "run.json"), { runId: req().runId, taskIds: [req().taskId], cancelled: false, invocations: 1, decisions: [], createdAt: "", updatedAt: "" });
    assert.equal(owner(p).admit(req()).ok, false);
    const exited = once(child, "exit");
    assert.equal((await cancelRun(p, req().runId, 0)).ok, true);
    await exited;
    const saved = readJson<{ state: string; pids: { child: number | null } }>(auditPath(p));
    assert.equal(saved?.state, "cancelled");
    assert.ok(saved?.pids.child === null || saved?.pids.child === child.pid);
    assert.equal(activeSlots(p).length, 0);
    assert.equal(owner(p).admit(req()).ok, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
});

it("recuperação explícita recusa auditoria ambígua e filho vivo ou inacessível", (t) => {
  const p = root(), bridge = deadPid(), kill = process.kill;
  const ambiguous = [
    { ...audit(bridge + 1, null), state: "succeeded" },
    audit(bridge, process.pid),
  ];
  for (const saved of ambiguous) {
    orphanSlot(p, bridge);
    writeJsonAtomic(auditPath(p), saved);
    assert.equal(activeSlots(p).length, 1);
    assert.equal(releaseOrphanSlot(p, "orphan", false).ok, false);
    assert.equal(releaseOrphanSlot(p, "nonce-antigo", true).ok, false);
    t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      assert.equal(signal, 0, "recuperação nunca encerra processos");
      if (pid === process.pid) throw Object.assign(new Error("synthetic EPERM"), { code: "EPERM" });
      return kill.call(process, pid, signal);
    });
    assert.equal(activeSlots(p).length, 1);
    assert.equal(releaseOrphanSlot(p, "orphan", true).ok, false);
    t.mock.restoreAll();
    assert.equal(activeSlots(p).length, 1);
  }
  writeJsonAtomic(auditPath(p), { ...audit(bridge, null), state: "succeeded" });
  assert.equal(releaseOrphanSlot(p, "orphan", true).ok, true);
  assert.equal(owner(p).admit(req()).ok, true);
});

it("slot legado pode liberar auditoria correspondente sem filho registrado", () => {
  const p = root(), bridge = deadPid();
  orphanSlot(p, bridge);
  writeJsonAtomic(auditPath(p), audit(bridge, null));
  assert.equal(releaseOrphanSlot(p, "orphan", true).ok, true);
  assert.equal(activeSlots(p).length, 0);
});

it("recuperação recusa filho auditado vivo mesmo com confirmação", () => {
  const p = root(), bridge = deadPid();
  orphanSlot(p, bridge);
  writeJsonAtomic(auditPath(p), audit(bridge, process.pid));
  assert.match(releaseOrphanSlot(p, "orphan", true).message, /filho auditado ainda ativo/);
  assert.equal(activeSlots(p).length, 1);
});

it("PID de ponte reutilizado não bloqueia com filho encerrado, mas ponte genuína bloqueia", (t) => {
  const p = root(), bridge = process.pid;
  const fakePs = (output: string) => {
    t.mock.method(childProcess, "spawnSync", (() => ({ status: 0, stdout: output, error: undefined })) as unknown as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
  };
  t.mock.method(process, "kill", ((pid: number, signal?: string | number) => {
    assert.equal(pid, bridge);
    assert.equal(signal, 0);
    return true;
  }) as typeof process.kill);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    orphanSlot(p, bridge);
    writeJsonAtomic(join(p, ".duo/locks/slot-0.json"), { ...req(), slot: 0, isolation: "worktree", exclusive: true, pid: bridge, nonce: "orphan", startedAt: "2020-01-01T00:00:00.500Z" });
    writeJsonAtomic(auditPath(p), { ...audit(bridge, null), state: "succeeded" });
    fakePs("Wed Jan  1 00:00:00 2020\n");
    assert.equal(activeSlots(p).length, 1, "mesmo segundo pode ser a ponte original");
    assert.equal(releaseOrphanSlot(p, "orphan", true).ok, false);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fakePs("Wed Jan  1 00:00:02 2020\n");
    assert.equal(activeSlots(p).length, 0);
    writeJsonAtomic(auditPath(p), audit(bridge, bridge));
    assert.equal(activeSlots(p).length, 1);
    assert.equal(releaseOrphanSlot(p, "orphan", true).ok, false);
    writeJsonAtomic(auditPath(p), { ...audit(bridge, null), state: "succeeded" });
    const replacement = owner(p);
    assert.equal(replacement.admit(req()).ok, true, "admissão recupera a vaga sem encerrar o PID reutilizado");
    assert.notEqual(readJson<{ nonce: string }>(join(p, ".duo/lock.json"))?.nonce, "orphan");
    replacement.release();
    writeJsonAtomic(join(p, ".duo/locks/slot-0.json"), { ...req(), slot: 0, isolation: "worktree", exclusive: true, pid: bridge, nonce: "orphan", startedAt: "2020-01-01T00:00:00.500Z" });
    assert.equal(releaseOrphanSlot(p, "orphan", true).ok, true);
    assert.equal(owner(p).admit(req()).ok, true);
  } finally { t.mock.restoreAll(); Object.defineProperty(process, "platform", platform); syncBuiltinESMExports(); }
});

it("recuperação recusa ponte viva ou inacessível mesmo com confirmação", (t) => {
  const p = root();
  orphanSlot(p, process.pid);
  assert.equal(releaseOrphanSlot(p, "orphan", true).ok, false);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("synthetic EPERM"), { code: "EPERM" }); });
  assert.equal(releaseOrphanSlot(p, "orphan", true).ok, false);
  assert.equal(activeSlots(p).length, 1);
});

it("cancelamento não libera a exclusividade se o executor resistir ao encerramento", { skip: process.platform === "win32" }, async (t) => {
  const p = root(), bridge = deadPid();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const kill = process.kill;
  try {
    assert.ok(child.pid);
    orphanSlot(p, bridge);
    writeJsonAtomic(auditPath(p), audit(bridge, child.pid));
    writeJsonAtomic(join(p, ".duo/runs", req().runId, "run.json"), { runId: req().runId, taskIds: [req().taskId], cancelled: false, invocations: 1, decisions: [], createdAt: "", updatedAt: "" });
    t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      if (Math.abs(pid) === child.pid && signal !== 0) throw new Error("synthetic kill failure");
      return kill.call(process, pid, signal);
    });
    await cancelRun(p, req().runId, 0);
    assert.equal(readJson<{ pids: { child: number } }>(auditPath(p))?.pids.child, child.pid);
    assert.equal(activeSlots(p).length, 1);
    assert.equal(owner(p).admit(req()).ok, false);
    assert.match(applyTask(p, "inexistente").message, /exclusivo/);
  } finally {
    t.mock.restoreAll();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
  assert.equal(activeSlots(p).length, 0);
  assert.equal(owner(p).admit(req()).ok, true);
});

it("admissões concorrentes nunca sobrepõem slot exclusivo e outros slots", async () => {
  const p = root(), moduleUrl = new URL("../src/state/slots.js", import.meta.url).href;
  const requests = Array.from({ length: 6 }, (_, i) => req({ taskId: `task-${i}`, exclusive: i === 0 }));
  const children = requests.map((request) => spawn(process.execPath, ["--input-type=module", "-e", `
    import { ExecutorSlots } from ${JSON.stringify(moduleUrl)};
    const slot = new ExecutorSlots(${JSON.stringify(p)}, 8);
    process.on('message', () => { try { process.send(slot.admit(${JSON.stringify(request)})); } catch (error) { process.send({ error: error.message }); } });
    process.send('ready');
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] }));
  try {
    await Promise.all(children.map((c) => once(c, "message")));
    const replies = children.map((c) => once(c, "message"));
    children.forEach((c) => c.send("admit"));
    const results = (await Promise.all(replies)).map(([result]) => result as { ok?: boolean; reason?: string; error?: string });
    assert.ok(results.every((result) => !result.error), JSON.stringify(results));
    assert.ok(results.some((result) => result.ok), JSON.stringify(results));
    if (results[0]!.ok) assert.equal(results.filter((result) => result.ok).length, 1);
    else assert.match(results[0]!.reason ?? "", /projeto livre.*aguarde/);
    const active = activeSlots(p);
    assert.equal(active.length, results.filter((result) => result.ok).length);
    assert.ok(!active.some((slot) => slot.exclusive) || active.length === 1);
  } finally {
    await Promise.all(children.map(async (c) => { if (c.exitCode === null && c.signalCode === null) { const exited = once(c, "exit"); c.kill(); await exited; } }));
  }
});

it("an explicit spawning phase survives the stale-file window even without process probe metadata", () => {
  const p = root(), bridge = deadPid(), at = new Date(Date.now() - 11_000);
  const file = join(p, ".duo/locks/slot-0.json");
  writeJsonAtomic(file, { ...req(), slot: 0, pid: bridge, nonce: "handoff", exclusive: true,
    isolation: "in-place", startedAt: at.toISOString(), spawnStartedAt: at.toISOString(), phase: "spawning", childPid: null });
  utimesSync(file, at, at);
  assert.equal(owner(p).admit(req()).ok, false);
  assert.match(applyTask(p, "missing").message, /exclusivo/);
  assert.equal(releaseOrphanSlot(p, "handoff", true).ok, false);
  assert.equal(activeSlots(p)[0]?.nonce, "handoff");
});

it("probe acha o executor pelo marcador da task mesmo com binário de outro nome", (t) => {
  const cwd = join(root(), ".duo/worktrees/task-probe-000000");
  const slot: SlotInfo = {
    slot: 0, pid: deadPid(), taskId: "task-probe-000000", runId: "run-probe-000000", nonce: "probe",
    startedAt: new Date().toISOString(), isolation: "in-place", kind: "implement", exclusive: true,
    phase: "spawning", spawnStartedAt: new Date().toISOString(), spawnCommand: "codex", spawnCwd: cwd, childPid: null,
  };
  t.mock.method(childProcess, "spawnSync", ((command: string) => {
    if (command === "/bin/ps") return { status: 0, stdout: `456 /opt/wrap/my-agent /opt/wrap/my-agent exec --cd ${cwd}\n` };
    return assert.fail("sem lsof: o marcador já prova o processo");
  }) as unknown as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try { assert.deepEqual(inspectCodexProcesses(slot), { ok: true, pids: [456] }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("slot que não pode ser lido (permissão) continua bloqueando, mesmo velho", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const p = root(), path = join(p, ".duo/locks/slot-0.json");
  writeJsonAtomic(path, { ...req(), slot: 0, isolation: "in-place", exclusive: true, pid: process.pid, nonce: "ilegivel", startedAt: new Date().toISOString() });
  const old = new Date(Date.now() - 60_000); utimesSync(path, old, old);
  chmodSync(path, 0o000);
  try {
    withAdmission(p, () => recoverSlotsLocked(p));
    assert.ok(existsSync(path), "erro de leitura não prova que o dono acabou");
  } finally { chmodSync(path, 0o600); }
});

it("doctor inspeciona sem recuperar quando não consegue pegar o lock", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const p = root(), locks = join(p, ".duo/locks");
  mkdirSync(locks, { recursive: true });
  chmodSync(locks, 0o500);
  try { assert.deepEqual(inspectSlots(p), []); }
  finally { chmodSync(locks, 0o700); }
});
