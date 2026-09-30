import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

const previousExitHandlers = new Set(process.listeners("exit"));
const { runProcess } = await import("../src/adapters/process.js");
const exitHandler = process.listeners("exit").find((handler) => !previousExitHandlers.has(handler));
assert.ok(exitHandler);

const IS_WINDOWS = process.platform === "win32";
const KILL_GRACE_MS = 80;

function groupExists(pgid: number, kill = process.kill): boolean {
  try {
    kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function waitForEmptyGroup(pgid: number, kill = process.kill): Promise<void> {
  const deadline = Date.now() + 1000;
  let exists = groupExists(pgid, kill);
  while (exists && Date.now() < deadline) {
    await delay(10);
    exists = groupExists(pgid, kill);
  }
  assert.equal(exists, false, `grupo ${pgid} sobreviveu ao SIGKILL`);
}

describe("encerramento de grupos POSIX", { skip: IS_WINDOWS }, () => {
  for (const mode of ["normal", "SIGTERM", "vigilância"] as const) {
    it(`${mode}: esquece grupo vazio e não sinaliza PGID reutilizado`, { timeout: 5000 }, async (context) => {
      const realKill = process.kill.bind(process);
      let pgid: number | undefined;
      let groupEmpty = false;
      let observedEmpty = false;
      let reused = false;
      const lateCalls: Array<Parameters<typeof process.kill>[1]> = [];
      const killSpy = context.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => {
        if (pgid !== undefined && args[0] === -pgid) {
          if (reused) {
            lateCalls.push(args[1]);
            return true;
          }
          try {
            return realKill(...args);
          } catch (error) {
            if (args[1] === 0 && (error as NodeJS.ErrnoException).code === "ESRCH") {
              observedEmpty = true;
              reused = true;
            }
            throw error;
          }
        }
        return realKill(...args);
      });
      const controller = new AbortController();
      const pending = runProcess({
        command: "/bin/sh",
        args: ["-c", mode === "normal" ? "exit 0" : mode === "SIGTERM"
          ? "printf 'ready\\n'; exec sleep 30"
          : "(trap \"\" TERM; printf 'ready\\n'; exec > /dev/null 2>&1; sleep 30) & wait"],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 10_000,
        killGraceMs: 300,
        maxOutputBytes: 1024,
        signal: controller.signal,
        onSpawn: (pid) => { pgid = pid; },
        onLine: (line) => { if (line === "ready") controller.abort(); },
      });
      const watchdog = setTimeout(() => {
        controller.abort();
        if (!groupEmpty && pgid !== undefined && groupExists(pgid, realKill)) realKill(-pgid, "SIGKILL");
      }, 1500);
      try {
        const result = await pending;
        assert.equal(result.cancelled, mode !== "normal");
        assert.ok(pgid !== undefined);
        assert.equal(groupExists(pgid, realKill), false, "Promise só termina com o grupo vazio");
        await waitForEmptyGroup(pgid, realKill);
        groupEmpty = true;
        if (mode !== "normal") {
          const deadline = Date.now() + 1000;
          while (!observedEmpty && Date.now() < deadline) await delay(10);
          assert.ok(observedEmpty, "adaptador deve observar ESRCH e encerrar a vigilância");
        }
        reused = true;
        const probe = killSpy.mock;
        const callsBeforeExit = probe.callCount();
        exitHandler(0);
        assert.equal(probe.callCount(), callsBeforeExit, "grupo terminado deve sair de live");
        await delay(400);
        exitHandler(0);
        assert.deepEqual(lateCalls, [], "nenhuma sondagem ou sinal após esquecer o PGID");
      } finally {
        clearTimeout(watchdog);
        controller.abort();
        if (!groupEmpty && pgid !== undefined && groupExists(pgid, realKill)) realKill(-pgid, "SIGKILL");
        await pending;
      }
    });
  }

  it("close normal: encerra descendente com pipes redirecionados sem marcar flags", { timeout: 5000 }, async () => {
    let pgid: number | undefined;
    const pending = runProcess({
      command: process.execPath,
      args: ["-e", `
        const { spawn } = require('node:child_process');
        const descendant = spawn(process.execPath, ['-e',
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        descendant.stdout.once('data', () => process.exit(0));
      `],
      cwd: process.cwd(), env: process.env, timeoutMs: 2000,
      killGraceMs: KILL_GRACE_MS, maxOutputBytes: 1024,
      onSpawn: (pid) => { pgid = pid; },
    });
    try {
      const result = await pending;
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
      assert.equal(result.outputLimitExceeded, false);
      assert.ok(pgid !== undefined);
      assert.equal(groupExists(pgid), false, "grupo deve estar vazio no retorno normal");
    } finally {
      if (pgid !== undefined && groupExists(pgid)) process.kill(-pgid, "SIGKILL");
      if (pgid !== undefined) await waitForEmptyGroup(pgid);
    }
  });

  it("timeout: alcança descendente depois que o líder saiu sozinho", { timeout: 5000 }, async () => {
    let pgid: number | undefined;
    const started = Date.now();
    const pending = runProcess({
      command: "/bin/sh",
      args: ["-c", `(trap "" TERM; sleep 30) & exit 0`],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 250,
      killGraceMs: KILL_GRACE_MS,
      maxOutputBytes: 1024,
      onSpawn: (pid) => { pgid = pid; },
    });
    try {
      const result = await pending;
      assert.equal(result.timedOut, true);
      assert.ok(Date.now() - started < 1500, "runProcess ficou pendurado no descendente");
      assert.ok(pgid !== undefined);
      await waitForEmptyGroup(pgid);
    } finally {
      if (pgid !== undefined && groupExists(pgid)) process.kill(-pgid, "SIGKILL");
    }
  });

  for (const reason of ["timeout", "cancelamento"] as const) {
    for (const closeOutput of [false, true]) {
      it(`${reason}: elimina descendente que ignora TERM${closeOutput ? " e fecha os pipes" : ""}`, { timeout: 5000 }, async () => {
        let pgid: number | undefined;
        let groupEmpty = false;
        let ready = false;
        const controller = new AbortController();
        const pending = runProcess({
          command: "/bin/sh",
          args: ["-c", `(trap "" TERM; printf 'ready\\n'; ${closeOutput ? "exec > /dev/null 2>&1; " : ""}sleep 30) & wait`],
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: reason === "timeout" ? 250 : 10_000,
          killGraceMs: KILL_GRACE_MS,
          maxOutputBytes: 1024,
          signal: controller.signal,
          onSpawn: (pid) => { pgid = pid; },
          onLine: (line) => {
            if (line !== "ready") return;
            ready = true;
            if (reason === "cancelamento") controller.abort();
          },
        });
        let watchdog: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              watchdog = setTimeout(() => reject(new Error("runProcess não encerrou o grupo")), 1500);
            }),
          ]);
          assert.ok(ready, "descendente deve instalar o trap antes do encerramento");
          assert.equal(result.timedOut, reason === "timeout");
          assert.equal(result.cancelled, reason === "cancelamento");
          assert.equal(result.signal, "SIGTERM", "líder deve sair antes do SIGKILL");
          assert.ok(pgid !== undefined);
          assert.equal(groupExists(pgid), false, "grupo deve estar vazio antes do retorno");
          await waitForEmptyGroup(pgid);
          groupEmpty = true;
        } finally {
          clearTimeout(watchdog);
          controller.abort();
          if (!groupEmpty && pgid !== undefined && groupExists(pgid)) process.kill(-pgid, "SIGKILL");
          await pending;
        }
      });
    }
  }

  for (const closeOutput of [false, true]) {
    it(`exit: elimina grupo cujo líder já saiu${closeOutput ? " e fechou os pipes" : ""}`, { timeout: 5000 }, async () => {
      const moduleUrl = new URL("../src/adapters/process.js", import.meta.url).href;
      const script = `(trap "" TERM; printf 'ready\\n'; ${closeOutput ? "exec > /dev/null 2>&1; " : ""}sleep 30) & wait`;
      const host = spawn(process.execPath, ["--input-type=module", "-e", `
        import { runProcess } from ${JSON.stringify(moduleUrl)};
        const controller = new AbortController();
        await runProcess({
          command: '/bin/sh', args: ['-c', ${JSON.stringify(script)}],
          cwd: process.cwd(), env: process.env, timeoutMs: 10000,
          killGraceMs: 10000, maxOutputBytes: 1024, signal: controller.signal,
          onSpawn: (pid) => console.log(pid),
          onLine: (line) => {
            if (line !== 'ready') return;
            controller.abort();
            setTimeout(() => process.exit(0), 50);
          },
        });
        process.exit(0);
      `], { stdio: ["ignore", "pipe", "pipe"] });
      let pgid: number | undefined;
      let groupEmpty = false;
      let output = "";
      let stderr = "";
      host.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) pgid = Number(output.trim());
      });
      host.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const closed = once(host, "close");
      const watchdog = setTimeout(() => host.kill("SIGKILL"), 2000);
      try {
        const [code, signal] = await closed;
        assert.equal(code, 0, stderr);
        assert.equal(signal, null);
        assert.ok(pgid !== undefined && Number.isSafeInteger(pgid) && pgid > 0);
        await waitForEmptyGroup(pgid);
        groupEmpty = true;
      } finally {
        clearTimeout(watchdog);
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
        if (!groupEmpty && pgid !== undefined && Number.isSafeInteger(pgid) && pgid > 0 && groupExists(pgid)) {
          process.kill(-pgid, "SIGKILL");
        }
        await closed;
      }
    });
  }
});
