import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LineSplitter } from "../src/adapters/process.js";

const IS_WINDOWS = process.platform === "win32";
const moduleUrl = new URL("../src/adapters/process.js", import.meta.url).href;

function groupExists(pid: number): boolean {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `PGID inválido: ${pid}`);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function isolated(body: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "duo-hardening-"));
  const pidFile = join(directory, "pids");
  const host = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { runProcess, runQuick } from ${JSON.stringify(moduleUrl)};
    const recordPid = (pid) => appendFileSync(${JSON.stringify(pidFile)}, pid + '\\n');
    const options = {
      command: process.execPath, cwd: process.cwd(), env: process.env,
      timeoutMs: 2000, killGraceMs: 80, maxOutputBytes: 1024,
      onSpawn: recordPid,
    };
    ${body}
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  host.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  host.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<number | null>((resolve, reject) => {
    host.once("error", reject);
    host.once("close", resolve);
  });
  const watchdog = setTimeout(() => {
    if (host.pid !== undefined && groupExists(host.pid)) process.kill(-host.pid, "SIGKILL");
  }, 5000);
  try {
    assert.equal(await closed, 0, `${stderr}\n${stdout}`);
  } finally {
    clearTimeout(watchdog);
    let pids: number[] = [];
    try {
      pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (host.pid !== undefined) pids.push(host.pid);
    try {
      for (const pid of pids) {
        if (groupExists(pid)) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        }
      }
      await closed.catch(() => {});
      const deadline = Date.now() + 1500;
      while (pids.some(groupExists) && Date.now() < deadline) await delay(10);
      assert.deepEqual(pids.filter(groupExists), [], "nenhum grupo sintético pode sobreviver ao teste");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

it("runQuick: limita timeout com TERM ignorado e descendente segurando pipes", { skip: IS_WINDOWS }, async () => {
  await isolated(`
    for (const descendant of [false, true]) {
      const started = Date.now();
      const result = runQuick('/bin/sh', ['-c',
        'trap "" TERM; printf "%s\\\\n" "$$"; ' +
        (descendant ? '(sleep 1.2) & ' : '') + 'sleep 0.8'
      ], { timeoutMs: 150 });
      const pid = Number(result.stdout.trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 0, JSON.stringify(result));
      recordPid(pid);
      assert.equal(result.ok, false);
      assert.match(result.error, /ETIMEDOUT/);
      assert.ok(Date.now() - started < 450, 'timeout deve ser limitado, sem esperar o trap');
      if (descendant) {
        const deadline = Date.now() + 1000;
        let alive = true;
        while (alive && Date.now() < deadline) {
          try { process.kill(-pid, 0); } catch (error) {
            if (error.code === 'ESRCH') alive = false;
            else if (error.code !== 'EPERM') throw error;
          }
          if (alive) await delay(10);
        }
        assert.equal(alive, false, 'o descendente também deve ser encerrado');
      }
    }
  `);
});

it("runProcess: rejeita erro original de callback após close e suprime callbacks seguintes", { skip: IS_WINDOWS }, async () => {
  await isolated(`
    for (const phase of ['spawn', 'line', 'end', 'undefined']) {
      const original = phase === 'undefined' ? undefined : Object.assign(new Error('disco cheio'), { code: 'ENOSPC' });
      let pid;
      let calls = 0;
      let rejected = false;
      const fail = () => { calls++; throw original; };
      try {
        await runProcess({
          ...options,
          args: ['-e', phase === 'end' ? "process.stdout.write('tail')" :
            "process.on('SIGTERM', () => {}); process.stdout.write('first\\\\nsecond\\\\n'); setInterval(() => {}, 1000)"],
          onSpawn: (value) => { pid = value; recordPid(value); if (phase === 'spawn') fail(); },
          onLine: fail,
        });
      } catch (error) {
        rejected = true;
        assert.equal(error, original);
      }
      assert.equal(rejected, true, 'runProcess deve rejeitar');
      assert.equal(calls, 1, 'somente a primeira falha deve ser chamada');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'rejeição somente após o filho fechar');
    }
  `);
});

it("runProcess: a primeira causa vence durante a grace", { skip: IS_WINDOWS }, async () => {
  await isolated(`
    for (const cause of ['output', 'cancel', 'timeout']) {
      const controller = new AbortController();
      const result = await runProcess({
        ...options, timeoutMs: 250, killGraceMs: 400, maxOutputBytes: 16,
        signal: controller.signal,
        args: ['-e',
          "process.on('SIGTERM', () => { process.stdout.write('x'.repeat(100)); }); " +
          "process.stdout.write('ready\\\\n'); " +
          ${JSON.stringify("setInterval(() => {}, 1000);")} +
          (cause === 'timeout' ? '' : "setTimeout(() => process.stdout.write('x'.repeat(100)), 30);")
        ],
        onLine: (line) => {
          if (line !== 'ready') return;
          if (cause === 'cancel') controller.abort();
          if (cause === 'output') setTimeout(() => controller.abort(), 100);
        },
      });
      assert.equal(result.outputLimitExceeded, cause === 'output');
      assert.equal(result.cancelled, cause === 'cancel');
      assert.equal(result.timedOut, cause === 'timeout');
    }
  `);
});

it("TailBuffer: preserva exatamente os últimos 65536 bytes de stderr", { skip: IS_WINDOWS }, async () => {
  await isolated(`
    const result = await runProcess({
      ...options,
      args: ['-e', "process.stderr.write('a'.repeat(60000), () => setTimeout(() => process.stderr.write('b'.repeat(40000)), 100));"],
    });
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.byteLength(result.stderrTail), 65536);
    assert.equal(result.stderrTail, 'a'.repeat(25536) + 'b'.repeat(40000));
  `);
});

it("LineSplitter: CRLF no limite independe da fragmentação", () => {
  for (const line of ["abcd", "éé"]) {
    const bytes = Buffer.from(`${line}\r\n`);
    for (let boundary = 0; boundary <= bytes.length; boundary++) {
      const lines: string[] = [];
      const splitter = new LineSplitter((value) => lines.push(value), 4);
      splitter.push(bytes.subarray(0, boundary));
      splitter.push(bytes.subarray(boundary));
      splitter.end();
      assert.deepEqual(lines, [line], `fragmentação em ${boundary}`);
      assert.equal(splitter.oversizeLines, 0);
    }
  }
  for (const bytes of [Buffer.from("abcde\r\n"), Buffer.from("abcd\rx\n")]) {
    const lines: string[] = [];
    const splitter = new LineSplitter((value) => lines.push(value), 4);
    for (const byte of bytes) splitter.push(Buffer.from([byte]));
    splitter.end();
    assert.deepEqual(lines, []);
    assert.equal(splitter.oversizeLines, 1);
  }
});
