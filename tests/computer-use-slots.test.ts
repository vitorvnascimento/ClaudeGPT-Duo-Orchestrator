import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { applyTask } from "../src/orchestration/control.js";
import { activeSlots, ExecutorSlots, type AdmitRequest } from "../src/state/slots.js";
import { readJson } from "../src/state/store.js";

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
