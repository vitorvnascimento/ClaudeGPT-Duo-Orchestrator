import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { applyTask, cancelRun } from "../src/orchestration/control.js";
import { activeSlots, ExecutorSlots, type AdmitRequest } from "../src/state/slots.js";
import { readJson, writeJsonAtomic } from "../src/state/store.js";

const roots: string[] = [];
const owners: ExecutorSlots[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "duo-exclusive-")); roots.push(p); return p; };
const owner = (p: string) => { const s = new ExecutorSlots(p, 8); owners.push(s); return s; };
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

const auditPath = (p: string) => join(p, ".duo/runs", req().runId, "tasks", req().taskId, "task.json");
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;
function orphanSlot(p: string, bridge: number): void {
  writeJsonAtomic(join(p, ".duo/locks/slot-0.json"), { ...req(), slot: 0, isolation: "worktree", exclusive: true, pid: bridge, nonce: "orphan", startedAt: "" });
}
function audit(bridge: number, child: number | null) {
  return { taskId: req().taskId, runId: req().runId, state: "running", pids: { bridge, child }, history: [],
    executor: "codex", kind: "implement", scope: [], acceptanceCriteria: [], tags: [], model: { requested: null }, invocations: 1 };
}

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

it("auditoria ausente, inválida ou divergente mantém reserva exclusiva fechada", () => {
  const p = root(), bridge = deadPid(), path = auditPath(p);
  orphanSlot(p, bridge);
  const invalid = [null, {}, { ...audit(bridge, deadPid()), taskId: "task-outra-000000" },
    { ...audit(bridge, deadPid()), runId: "run-outra-000000" }, { ...audit(bridge + 1, deadPid()) },
    { ...audit(bridge, null) }, { ...audit(bridge, deadPid()), state: "invalido" }, { ...audit(bridge, -1) }];
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
