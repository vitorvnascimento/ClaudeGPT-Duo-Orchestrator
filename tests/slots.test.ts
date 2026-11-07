import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs = require("node:fs");
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { activeSlots, ExecutorSlots, type AdmitRequest } from "../src/state/slots.js";
import { readJson, reclaimStale, renameWithRetry, withFileLock, writeJsonAtomic } from "../src/state/store.js";

const roots: string[] = [];
const owners: ExecutorSlots[] = [];
const slots = (p: string, max: number) => { const owner = new ExecutorSlots(p, max); owners.push(owner); return owner; };
const root = () => { const p = mkdtempSync(join(tmpdir(), "duo-slots-")); roots.push(p); return p; };
afterEach(() => { for (const owner of owners.splice(0)) owner.release(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const req = (patch: Partial<AdmitRequest> = {}): AdmitRequest => ({ taskId: "task-teste-000000", runId: "run-teste-000000", kind: "implement", requested: "worktree", fixed: null, gitReady: true, ...patch });

it("admite até max e bloqueia o seguinte", () => {
  const p = root();
  assert.equal(slots(p, 2).admit(req()).ok, true);
  assert.equal(slots(p, 2).admit(req()).ok, true);
  assert.match(JSON.stringify(slots(p, 2).admit(req())), /limite de 2/);
});
it("in-place ativo bloqueia qualquer nova admissão", () => {
  const p = root();
  slots(p, 4).admit(req({ requested: "in-place" }));
  for (const requested of ["worktree", "in-place"] as const) assert.match(JSON.stringify(slots(p, 4).admit(req({ requested }))), /in-place está ativo/);
});
it("pedido in-place com outro ativo vira worktree forçado", () => {
  const p = root(); slots(p, 4).admit(req());
  assert.deepEqual(slots(p, 4).admit(req({ requested: "in-place" })), { ok: true, isolation: "worktree", forced: true });
});
it("cadeia fixa in-place com outro ativo é bloqueada", () => {
  const p = root(); slots(p, 4).admit(req());
  assert.equal(slots(p, 4).admit(req({ fixed: "in-place" })).ok, false);
});
it("lock.json legado sem marcador e pid vivo conta como in-place exclusivo", () => {
  const p = root(); writeJsonAtomic(join(p, ".duo/lock.json"), { ...req(), pid: process.pid, nonce: "antigo", startedAt: "" });
  assert.equal(activeSlots(p)[0]?.slot, -1);
  assert.equal(slots(p, 4).admit(req()).ok, false);
});
it("espelho legado existe enquanto há slot e some com o último release", () => {
  const p = root(), a = slots(p, 4), b = slots(p, 4);
  a.admit(req()); b.admit(req());
  assert.equal(readJson<{ slots: boolean }>(join(p, ".duo/lock.json"))?.slots, true);
  a.release(); assert.equal(a.intact(), false); assert.equal(b.intact(), true);
  assert.ok(existsSync(join(p, ".duo/lock.json")));
  b.release(); assert.equal(existsSync(join(p, ".duo/lock.json")), false);
});
it("sem git com commit e outro ativo: bloqueia", () => {
  const p = root(); slots(p, 4).admit(req());
  assert.match(JSON.stringify(slots(p, 4).admit(req({ requested: "in-place", gitReady: false }))), /execução paralela requer um repositório git com ao menos um commit/);
});

const moduleUrl = new URL("../src/state/slots.js", import.meta.url).href;
function child(p: string, delayDeadGuard = false, max = 1) {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { ExecutorSlots } from ${JSON.stringify(moduleUrl)};
    const originalRead = fs.readFileSync;
    if (${delayDeadGuard}) {
      fs.readFileSync = function(path, ...args) {
        const value = originalRead.call(this, path, ...args);
        if (String(path).endsWith('admission.lock') && String(value).includes('morto'))
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        return value;
      };
      syncBuiltinESMExports();
    }
    const slots = new ExecutorSlots(${JSON.stringify(p)}, ${max});
    process.on('message', () => { try { process.send(slots.admit(${JSON.stringify(req())})); } catch (error) { process.send({ error: error.message }); } });
    process.send('ready');
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
}
it("slot de pid morto é recuperado após SIGKILL, junto com espelho legado", async () => {
  const p = root(), c = child(p);
  await once(c, "message"); const result = once(c, "message"); c.send("admit");
  assert.equal((await result)[0].ok, true);
  const exited = once(c, "exit"); c.kill("SIGKILL"); await exited;
  const next = slots(p, 1);
  assert.equal(next.admit(req()).ok, true);
  assert.equal(activeSlots(p).length, 1);
  assert.equal(readJson<{ pid: number }>(join(p, ".duo/lock.json"))?.pid, process.pid);
  next.release(); assert.equal(existsSync(join(p, ".duo/lock.json")), false);
});
it("corrida: 6 processos admitindo ao mesmo tempo com max 1 → exatamente 1 ok", async () => {
  const p = root(), children = Array.from({ length: 6 }, () => child(p));
  try {
    await Promise.all(children.map((c) => once(c, "message")));
    const replies = children.map((c) => once(c, "message"));
    children.forEach((c) => c.send("admit"));
    const results = await Promise.all(replies);
    assert.equal(results.filter(([r]) => r.ok).length, 1);
  } finally {
    await Promise.all(children.map(async (c) => { const exited = once(c, "exit"); c.kill(); await exited; }));
  }
});

it("recuperadores concorrentes do guard morto não removem a nova admissão", async () => {
  const p = root();
  writeJsonAtomic(join(p, ".duo/locks/admission.lock"), { pid: 2147483647, nonce: "morto" });
  const children = Array.from({ length: 6 }, () => child(p, true));
  try {
    await Promise.all(children.map((c) => once(c, "message")));
    const replies = children.map((c) => once(c, "message"));
    children.forEach((c) => c.send("admit"));
    const results = await Promise.all(replies);
    assert.equal(results.filter(([r]) => r.ok).length, 1);
    assert.ok(results.every(([r]) => !r.error), JSON.stringify(results));
  } finally {
    await Promise.all(children.map(async (c) => { const exited = once(c, "exit"); c.kill(); await exited; }));
  }
});


it("dois recuperadores do mesmo lock velho intercalados: só um entra na seção crítica", (t) => {
  const p = root(), path = join(p, "guard.lock");
  writeJsonAtomic(path, { pid: 2147483647, nonce: "velho" });
  const remove = fs.rmSync;
  let paused = false, entered = 0;
  // Pausa o recuperador dono do marcador logo antes de apagar o guard morto: o outro espera.
  t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (String(args[0]) === path && !paused) {
      paused = true;
      assert.ok(existsSync(`${path}.reclaim-velho`));
      assert.throws(() => withFileLock(path, 30, () => { entered++; }), /tempo esgotado/);
    }
    return remove(...args);
  });
  syncBuiltinESMExports();
  try {
    withFileLock(path, 200, () => { entered++; });
    assert.equal(paused, true);
    assert.equal(entered, 1);
    assert.deepEqual(readdirSync(p), ["guard.lock.reclaim-velho"], "só o marcador permanente da geração morta");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("lock vazio com mais de 10 s é recuperado por marcador de inode", (t) => {
  const p = root(), path = join(p, "guard.lock");
  writeFileSync(path, "");
  const old = new Date(Date.now() - 11_000); utimesSync(path, old, old);
  const inode = fs.statSync(path).ino, remove = fs.rmSync;
  let recovered = false;
  t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (String(args[0]) === path && !recovered) {
      recovered = true;
      assert.ok(readdirSync(p).some((n) => n.startsWith(`guard.lock.reclaim-ino-${inode}-`)));
    }
    return remove(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(withFileLock(path, 200, () => readJson<{ pid: number }>(path)?.pid), process.pid);
    assert.equal(recovered, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("lock vazio recente não é recuperado antes de 10 s", () => {
  const path = join(root(), "guard.lock"); writeFileSync(path, "");
  assert.throws(() => withFileLock(path, 20, () => assert.fail("entrou sem lock")), /tempo esgotado/);
  assert.ok(existsSync(path));
});

it("slot vazio ou ilegível com mais de 10 s não reduz a capacidade", () => {
  const p = root(); mkdirSync(join(p, ".duo/locks"), { recursive: true });
  for (const [i, contents] of ["", "{incompleto"].entries()) {
    const path = join(p, `.duo/locks/slot-${i}.json`); writeFileSync(path, contents);
    const old = new Date(Date.now() - 11_000); utimesSync(path, old, old);
  }
  assert.equal(slots(p, 2).admit(req()).ok, true);
  assert.equal(slots(p, 2).admit(req()).ok, true);
});

it("lock e slot são publicados completos por link exclusivo", (t) => {
  const p = root(), link = fs.linkSync, seen: string[] = [];
  t.mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
    const value = readJson<{ pid: number; nonce: string }>(String(args[0]));
    assert.equal(value?.pid, process.pid); assert.ok(value?.nonce);
    seen.push(String(args[1]));
    return link(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(slots(p, 1).admit(req()).ok, true);
    assert.ok(seen.some((path) => path.endsWith("admission.lock")));
    assert.ok(seen.some((path) => path.endsWith("slot-0.json")));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("lock.json legado criado entre a checagem e a criação do espelho recusa admissão", (t) => {
  const p = root(), path = join(p, ".duo/lock.json"), link = fs.linkSync;
  const legacy = { pid: process.pid, nonce: "legado", taskId: "task-legada-000000", runId: "run-legado-000000", startedAt: "" };
  t.mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
    if (String(args[1]) === path) writeFileSync(path, JSON.stringify(legacy), { flag: "wx" });
    return link(...args);
  });
  syncBuiltinESMExports();
  try {
    const owner = slots(p, 2);
    assert.match(JSON.stringify(owner.admit(req())), /in-place está ativo/);
    assert.equal(owner.intact(), false);
    assert.deepEqual(readJson(path), legacy);
    assert.equal(existsSync(join(p, ".duo/locks/slot-0.json")), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("espelho é regravado quando seu dono morre e outro slot continua vivo", async () => {
  const p = root(), c = child(p, false, 2), owner = slots(p, 2);
  try {
    await once(c, "message"); const admitted = once(c, "message"); c.send("admit");
    assert.equal((await admitted)[0].ok, true);
    assert.equal(owner.admit(req()).ok, true);
    const path = join(p, ".duo/lock.json");
    assert.equal(readJson<{ pid: number }>(path)?.pid, c.pid);
    const exited = once(c, "exit"); c.kill("SIGKILL"); await exited;
    const deadline = Date.now() + 7000;
    while (readJson<{ pid: number }>(path)?.pid !== process.pid && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(readJson<{ pid: number }>(path)?.pid, process.pid);
    owner.release();
    assert.equal(existsSync(path), false);
  } finally {
    if (c.exitCode === null && c.signalCode === null) { const exited = once(c, "exit"); c.kill(); await exited; }
  }
});

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;

it("lock.json legado de dono morto é recuperado na admissão, como no lock antigo", () => {
  const p = root(); writeJsonAtomic(join(p, ".duo/lock.json"), { ...req(), pid: deadPid(), nonce: "antigo", startedAt: "" });
  assert.equal(slots(p, 4).admit(req({ requested: "in-place" })).ok, true);
  assert.equal(readJson<{ slots?: boolean; pid: number }>(join(p, ".duo/lock.json"))?.slots, true);
});
it("lock.json legado vazio há mais de 10 s é recuperado; recente continua bloqueando", () => {
  const p = root(), legacy = join(p, ".duo/lock.json");
  mkdirSync(join(p, ".duo"), { recursive: true }); writeFileSync(legacy, "");
  assert.equal(slots(p, 4).admit(req()).ok, false);
  const old = new Date(Date.now() - 60_000); utimesSync(legacy, old, old);
  assert.equal(slots(p, 4).admit(req()).ok, true);
});
it("release não lança com o guard ocupado e libera a própria vaga", () => {
  const p = root(), owner = new ExecutorSlots(p, 1);
  assert.equal(owner.admit(req()).ok, true);
  writeJsonAtomic(join(p, ".duo/locks/admission.lock"), { pid: process.pid, nonce: "ocupado" });
  assert.doesNotThrow(() => owner.release());
  rmSync(join(p, ".duo/locks/admission.lock"), { force: true });
  assert.equal(activeSlots(p).length, 0);
});

it("recuperador vivo (mesmo pausado) mantém o marcador: outro processo não entra no guard", () => {
  const p = root(), lock = join(p, "guard.lock");
  writeJsonAtomic(lock, { pid: deadPid(), nonce: "morto" });
  writeJsonAtomic(`${lock}.reclaim-morto`, { pid: process.pid });
  assert.throws(() => withFileLock(lock, 300, () => "entrou"), /tempo esgotado/);
  assert.equal(readJson<{ nonce: string }>(lock)?.nonce, "morto");
});
it("marcador de recuperador morto é removido e o guard é recuperado", () => {
  const p = root(), lock = join(p, "guard.lock");
  writeJsonAtomic(lock, { pid: deadPid(), nonce: "morto" });
  writeJsonAtomic(`${lock}.reclaim-morto`, { pid: deadPid() });
  assert.equal(withFileLock(lock, 2000, () => "entrou"), "entrou");
});
it("recuperador atrasado não apaga o guard vivo publicado depois da recuperação", () => {
  const p = root(), lock = join(p, "guard.lock");
  // Outro recuperador já recuperou a geração "morto" e saiu; um processo vivo publicou o guard novo.
  writeJsonAtomic(`${lock}.reclaim-morto`, { pid: deadPid() });
  writeJsonAtomic(lock, { pid: process.pid, nonce: "vivo" });
  reclaimStale(lock, "morto");
  assert.equal(readJson<{ nonce: string }>(lock)?.nonce, "vivo");
  assert.ok(existsSync(`${lock}.reclaim-morto.1`), "abre o próximo nível só porque o dono anterior morreu");
});
it("com um recuperador vivo na geração, nenhum outro confere nem apaga o guard (sem marcador removível)", () => {
  const p = root(), lock = join(p, "guard.lock");
  writeJsonAtomic(lock, { pid: deadPid(), nonce: "morto" });
  writeJsonAtomic(`${lock}.reclaim-morto`, { pid: deadPid() });
  writeJsonAtomic(`${lock}.reclaim-morto.1`, { pid: process.pid });
  reclaimStale(lock, "morto");
  assert.equal(readJson<{ nonce: string }>(lock)?.nonce, "morto");
  assert.equal(existsSync(`${lock}.reclaim-morto.2`), false);
  assert.ok(existsSync(`${lock}.reclaim-morto`) && existsSync(`${lock}.reclaim-morto.1`), "marcadores nunca são apagados");
});
it("tentativa de recuperação que falhou no próprio processo não trava o lock", (t) => {
  const p = root(), path = join(p, "guard.lock");
  writeJsonAtomic(path, { pid: deadPid(), nonce: "morto" });
  const remove = fs.rmSync;
  let failed = false;
  t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (String(args[0]) === path && !failed) { failed = true; throw Object.assign(new Error("EPERM simulado"), { code: "EPERM" }); }
    return remove(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(withFileLock(path, 500, () => "entrou"), "entrou", "a falha transitória é tentada de novo no mesmo pedido");
    assert.equal(failed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
it("erro de leitura do guard não o trata como ilegível nem prende o marcador", (t) => {
  const p = root(), path = join(p, "guard.lock");
  writeJsonAtomic(path, { pid: process.pid, nonce: "vivo" });
  const old = new Date(Date.now() - 11_000); utimesSync(path, old, old);
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] === "number") throw Object.assign(new Error("EIO simulado"), { code: "EIO" });
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => withFileLock(path, 50, () => assert.fail("entrou com o dono vivo")), /tempo esgotado.*EIO simulado/);
    assert.equal(readJson<{ nonce: string }>(path)?.nonce, "vivo", "guard vivo continua no lugar");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
it("geração com muitas tentativas falhas continua recuperável depois (sem teto de níveis)", () => {
  const p = root(), lock = join(p, "guard.lock");
  writeJsonAtomic(lock, { pid: deadPid(), nonce: "morto" });
  const dead = deadPid();
  for (let i = 0; i < 40; i++) writeJsonAtomic(i ? `${lock}.reclaim-morto.${i}` : `${lock}.reclaim-morto`, { pid: dead });
  assert.equal(withFileLock(lock, 2000, () => "entrou"), "entrou");
});
it("renovação do espelho nunca sobrescreve lock.json legado vivo que apareceu depois", () => {
  const p = root(), path = join(p, ".duo/lock.json");
  const owner = slots(p, 4); assert.equal(owner.admit(req()).ok, true);
  const legacy = { pid: process.pid, nonce: "legado", taskId: "task-legada-000000", runId: "run-legado-000000", startedAt: "" };
  writeJsonAtomic(path, legacy);
  assert.match(JSON.stringify(slots(p, 4).admit(req())), /in-place está ativo/);
  owner.release();
  assert.deepEqual(readJson(path), legacy);
});
it("renovação com dono do espelho vivo nunca deixa lock.json ausente (sem rename)", (t) => {
  const p = root(), path = join(p, ".duo/lock.json"), rename = fs.renameSync;
  const owner = slots(p, 4); assert.equal(owner.admit(req()).ok, true);
  let renamedMirror = false;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[0]) === path) renamedMirror = true;
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    const second = slots(p, 4); assert.equal(second.admit(req()).ok, true);
    second.release();
    assert.equal(renamedMirror, false);
    assert.equal(readJson<{ slots?: boolean }>(path)?.slots, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
it("rename do espelho que falha nunca apaga o lock.json de origem", (t) => {
  const p = root(), path = join(p, ".duo/lock.json");
  writeJsonAtomic(path, { pid: process.pid, nonce: "legado-vivo", taskId: "task-legada-000000", runId: "run-legado-000000", startedAt: "" });
  t.mock.method(fs, "renameSync", () => { const e = new Error("falha simulada") as NodeJS.ErrnoException; e.code = "EXDEV"; throw e; });
  syncBuiltinESMExports();
  try { assert.throws(() => renameWithRetry(path, `${path}.troca-teste`)); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readJson<{ nonce: string }>(path)?.nonce, "legado-vivo");
});
