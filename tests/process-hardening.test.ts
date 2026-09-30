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

it("runProcess: erro de callback espera descendente resistente com pipes redirecionados", { skip: IS_WINDOWS }, async () => {
  await isolated(`
    let pgid;
    const original = new Error('callback falhou');
    await assert.rejects(runProcess({
      ...options,
      args: ['-e', ${JSON.stringify(`
        const { spawn } = require('node:child_process');
        const descendant = spawn(process.execPath, ['-e',
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        descendant.stdout.once('data', () => console.log('ready'));
        setInterval(() => {}, 1000);
      `)}],
      onSpawn: (pid) => { pgid = pid; recordPid(pid); },
      onLine: () => { throw original; },
    }), (error) => error === original);
    assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' }, 'grupo vazio antes da rejeição');
  `);
});

it("runProcess: callback que lança durante grace preserva timeout/cancelamento/limite", { skip: IS_WINDOWS }, async () => {
  await isolated(`
    for (const cause of ['timeout', 'cancel', 'abort-throw', 'output']) {
      const controller = new AbortController();
      let calls = 0;
      const result = await runProcess({
        ...options, timeoutMs: 250, killGraceMs: 100,
        maxOutputBytes: cause === 'output' ? 16 : 1024,
        signal: controller.signal,
        args: ['-e',
          "process.on('SIGTERM', () => { process.stdout.write('during grace\\\\nsuppressed\\\\n'); }); " +
          "process.stdout.write('ready\\\\n'); " +
          (cause === 'output' ? "setTimeout(() => process.stdout.write('x'.repeat(32)), 20); " : '') +
          "setInterval(() => {}, 1000);"
        ],
        onLine: (line) => {
          calls++;
          if (line === 'ready') {
            if (cause === 'cancel' || cause === 'abort-throw') controller.abort();
            if (cause === 'abort-throw') throw new Error('after abort');
          } else throw new Error('during grace');
        },
      });
      assert.equal(result.timedOut, cause === 'timeout');
      assert.equal(result.cancelled, cause === 'cancel' || cause === 'abort-throw');
      assert.equal(result.outputLimitExceeded, cause === 'output');
      assert.equal(calls, cause === 'timeout' || cause === 'cancel' ? 2 : 1);
    }
  `);
});

for (const cause of ["saída normal", "timeout"] as const) {
  it(`runProcess: ${cause} não espera para sempre por pipes herdados de fora do grupo`, { skip: IS_WINDOWS }, async () => {
    await isolated(`
      const started = Date.now();
      const result = await runProcess({
        ...options, timeoutMs: 300,
        args: ['-e', ${JSON.stringify(`
          const { spawn } = require('node:child_process');
          const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
          console.log('escaped:' + escaped.pid);
          ${cause === "timeout" ? "setInterval(() => {}, 1000);" : "setTimeout(() => process.exit(0), 50);"}
        `)}],
        onLine: (line) => { if (line.startsWith('escaped:')) recordPid(Number(line.slice(8))); },
      });
      assert.equal(result.timedOut, ${cause === "timeout"});
      assert.ok(result.stdoutHead.includes('escaped:'));
      assert.ok(Date.now() - started < 3500, 'a ponte ficou presa nos pipes herdados');
    `);
  });
}

it("runProcess: saída normal não deixa timer segurando o event loop da ponte", { skip: IS_WINDOWS }, async () => {
  const started = Date.now();
  await isolated(`
    const result = await runProcess({ ...options, args: ['-e', 'process.exit(0)'] });
    assert.equal(result.exitCode, 0);
  `);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `a ponte levou ${elapsed} ms para sair depois de uma execução normal`);
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

it("LineSplitter: UTF-8 incompleto no EOF respeita o teto de bytes", () => {
  const lines: string[] = [];
  let dropped = 0;
  const splitter = new LineSplitter((line) => lines.push(line), 5, () => dropped++);
  splitter.push(Buffer.from([97, 97, 97, 97, 0xe2, 0x82]));
  splitter.end();
  assert.deepEqual(lines, []);
  assert.equal(dropped, 1);
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
    let dropped = 0;
    const splitter = new LineSplitter((value) => lines.push(value), 4, () => dropped++);
    for (const byte of bytes) splitter.push(Buffer.from([byte]));
    splitter.end();
    assert.deepEqual(lines, []);
    assert.equal(splitter.oversizeLines, 1);
    assert.equal(dropped, 1, "o descarte é avisado (o redator de stream precisa saber)");
  }
});
