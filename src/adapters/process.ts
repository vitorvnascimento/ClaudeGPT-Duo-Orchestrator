// Execução de processos sem shell: argumentos separados, prompt por stdin,
// limites de saída, timeout e encerramento da árvore de processos.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const IS_WINDOWS = process.platform === "win32";
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
/** Espera máxima por um "close" que não vem: depois do SIGKILL (processo preso no kernel) ou com o grupo já vazio (pipes herdados de fora do grupo). */
const KILL_SETTLE_MS = 2000;

/** Divide um stream em linhas completas, tolerando fragmentação e UTF-8 partido entre chunks. */
export class LineSplitter {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private discarding = false;
  oversizeLines = 0;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineBytes = 8 * 1024 * 1024,
    private readonly onOversize?: () => void,
  ) {}

  private dropOversize(): void {
    this.oversizeLines++;
    this.onOversize?.();
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let start = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
      const piece = text.slice(start, i);
      start = i + 1;
      if (this.discarding) {
        this.discarding = false;
        this.pending = "";
        continue;
      }
      const line = (this.pending + piece).replace(/\r$/, "");
      this.pending = "";
      if (Buffer.byteLength(line) > this.maxLineBytes) this.dropOversize();
      else if (line.trim()) this.onLine(line);
    }
    if (!this.discarding) {
      this.pending += text.slice(start);
      if (Buffer.byteLength(this.pending.replace(/\r$/, "")) > this.maxLineBytes) {
        this.dropOversize();
        this.discarding = true;
        this.pending = "";
      }
    }
  }

  /** Emite a última linha sem quebra final (stream possivelmente incompleto). */
  end(): void {
    const rest = (this.discarding ? "" : this.pending + this.decoder.end()).replace(/\r$/, "");
    this.pending = "";
    if (Buffer.byteLength(rest) > this.maxLineBytes) this.dropOversize();
    else if (rest.trim()) this.onLine(rest);
  }
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.limit) {
      const first = this.chunks[0] as Buffer;
      const excess = this.size - this.limit;
      if (first.length <= excess) this.size -= (this.chunks.shift() as Buffer).length;
      else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }
  toString(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.limit)).toString("utf8");
  }
}

export type RunOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxLineBytes?: number;
  onLine?: (line: string) => void;
  /** Uma linha acima de maxLineBytes foi descartada sem passar por onLine. */
  onOversizeLine?: () => void;
  onSpawn?: (pid: number) => void;
  signal?: AbortSignal;
  /** Primeiro sinal no encerramento. Claude Code encerra o turno de forma limpa com SIGINT. */
  firstSignal?: NodeJS.Signals;
  killGraceMs?: number;
};

export type RunResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
  stdoutHead: string;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  oversizeLines: number;
  durationMs: number;
};

const live = new Map<ChildProcess, { killTimer?: NodeJS.Timeout; watchTimer?: NodeJS.Timeout; onEmpty?: () => void }>();

function forgetTree(child: ChildProcess): void {
  const state = live.get(child);
  clearTimeout(state?.killTimer);
  clearInterval(state?.watchTimer);
  live.delete(child);
  state?.onEmpty?.();
}

function groupIsAlive(child: ChildProcess): boolean {
  if (!live.has(child)) return false;
  // Spawn que falhou (ENOENT, EACCES, cwd inválido) nunca criou grupo: nada a vigiar.
  if (child.pid === undefined) {
    forgetTree(child);
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      forgetTree(child);
      return false;
    }
    return true;
  }
}

function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (!live.has(child) || child.pid === undefined) return;
  if (IS_WINDOWS && (child.exitCode !== null || child.signalCode !== null)) return;
  if (!IS_WINDOWS && !groupIsAlive(child)) return;
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-child.pid, sig);
    }
  } catch (error) {
    if (!IS_WINDOWS && (error as NodeJS.ErrnoException).code === "ESRCH") {
      forgetTree(child);
      return;
    }
    try {
      child.kill(sig);
    } catch {
      /* processo já terminou */
    }
  }
}

/** Encerra a árvore de um PID registrado em estado (usado por `duo cancel` a partir de outro processo). */
export function killPidTree(pid: number, sig: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    if (IS_WINDOWS) {
      const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return r.status === 0;
    }
    try {
      process.kill(-pid, sig);
    } catch {
      process.kill(pid, sig);
    }
    return true;
  } catch {
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Nenhum executor pode sobreviver à ponte: ao sair, a árvore de cada filho vivo é encerrada.
process.on("exit", () => {
  for (const child of live.keys()) signalTree(child, "SIGKILL");
});

export function runProcess(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        windowsHide: true,
        detached: !IS_WINDOWS,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve(emptyResult(started, { spawnError: (e as Error).message }));
      return;
    }
    // Grupo visto vazio: com o "close" já recebido, devolve; sem ele, o trabalho acabou (o timeout não vale mais),
    // mas os pipes podem estar herdados: dá um tempo para drenarem e os solta.
    live.set(child, {
      onEmpty: () => {
        if (closed) settle(closed.code, closed.sig);
        else {
          clearTimeout(timer);
          clearTimeout(releaseTimer);
          releaseTimer = setTimeout(releasePipes, KILL_SETTLE_MS);
        }
      },
    });

    const head: Buffer[] = [];
    let headSize = 0;
    const tail = new TailBuffer(TAIL_BYTES);
    const errTail = new TailBuffer(STDERR_TAIL_BYTES);
    let stdoutBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let outputLimitExceeded = false;
    let spawnError: string | undefined;
    let stopping = false;
    let callbackFailed = false;
    let callbackCausedStop = false;
    let callbackError: unknown;
    const callCallback = <Value>(callback: ((value: Value) => void) | undefined, value: Value): void => {
      if (callbackFailed || !callback) return;
      try {
        callback(value);
      } catch (error) {
        callbackFailed = true;
        if (!stopping) {
          callbackCausedStop = true;
          callbackError = error;
          stop();
        }
      }
    };
    const splitter = new LineSplitter(
      (line) => callCallback(opts.onLine, line),
      opts.maxLineBytes,
      () => callCallback(opts.onOversizeLine, undefined),
    );

    let closed: { code: number | null; sig: NodeJS.Signals | null } | null = null;
    let settled = false;
    // Espera pelos pipes herdados; cancelada ao devolver, para não segurar o event loop depois de um "close" normal.
    let releaseTimer: NodeJS.Timeout | undefined;
    let splitterEnded = false;
    const endSplitter = (): void => {
      if (splitterEnded || outputLimitExceeded) return;
      splitterEnded = true;
      splitter.end();
    };
    const settle = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(releaseTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (!closed) {
        // Devolvendo sem "close" (líder preso ou pipes herdados): nada deste filho pode segurar o event loop.
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      if (callbackCausedStop) {
        reject(callbackError);
        return;
      }
      resolve({
        exitCode: code,
        signal: sig,
        timedOut,
        cancelled,
        outputLimitExceeded,
        ...(spawnError ? { spawnError } : {}),
        stdoutHead: Buffer.concat(head).toString("utf8"),
        stdoutTail: tail.toString(),
        stderrTail: errTail.toString(),
        stdoutBytes,
        oversizeLines: splitter.oversizeLines,
        durationMs: Date.now() - started,
      });
    };
    // Um processo fora do grupo (ex.: daemon com setsid) pode herdar stdout/stderr e adiar o "close" para sempre.
    // A ponte solta os pipes; se nem assim o "close" vier (líder preso no kernel), devolve o resultado do mesmo jeito.
    const releasePipes = (): void => {
      if (closed || settled) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        if (closed) return;
        endSplitter();
        settle(child.exitCode, child.signalCode);
      }, KILL_SETTLE_MS);
    };

    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      const state = live.get(child);
      if (!state) return;
      signalTree(child, opts.firstSignal ?? "SIGTERM");
      if (!live.has(child)) return;
      state.killTimer = setTimeout(() => {
        signalTree(child, "SIGKILL");
        if (IS_WINDOWS) forgetTree(child);
        else if (live.has(child)) {
          state.killTimer = setTimeout(() => {
            forgetTree(child);
            releasePipes();
          }, KILL_SETTLE_MS);
        }
      }, opts.killGraceMs ?? 5000).unref();
    };

    const onLeaderEnd = (): void => {
      if (IS_WINDOWS) return;
      // Mesmo sem encerramento em curso, descendentes podem seguir no grupo segurando os pipes:
      // o registro só é esquecido quando o grupo é observado vazio, para que timeout/cancelamento ainda o alcancem.
      if (!groupIsAlive(child)) return;
      const state = live.get(child);
      if (state && !state.watchTimer) {
        state.watchTimer = setInterval(() => { groupIsAlive(child); }, 50).unref();
      }
    };

    const timer = setTimeout(() => {
      if (stopping) return;
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      if (stopping) return;
      cancelled = true;
      stop();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("spawn", () => {
      if (child.pid !== undefined) callCallback(opts.onSpawn, child.pid);
    });
    child.on("error", (e) => {
      spawnError = e.message;
    });
    child.stdout?.on("data", (b: Buffer) => {
      stdoutBytes += b.length;
      if (stdoutBytes > opts.maxOutputBytes) {
        if (!stopping) {
          outputLimitExceeded = true;
          stop();
        }
        return;
      }
      if (headSize < HEAD_BYTES) {
        const slice = b.subarray(0, HEAD_BYTES - headSize);
        head.push(slice);
        headSize += slice.length;
      }
      tail.push(b);
      splitter.push(b);
    });
    child.stderr?.on("data", (b: Buffer) => errTail.push(b));

    child.stdin?.on("error", () => {
      /* o processo pode fechar stdin antes de lermos tudo; o resultado é validado depois */
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin, "utf8");
    else child.stdin?.end();

    child.on("exit", onLeaderEnd);
    child.on("close", (code, sig) => {
      closed = { code, sig };
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      endSplitter();
      if (IS_WINDOWS) {
        forgetTree(child);
        settle(code, sig);
        return;
      }
      const state = live.get(child);
      if (!state) {
        settle(code, sig);
        return;
      }
      onLeaderEnd();
      if (live.has(child)) {
        stop();
        state.watchTimer?.ref();
        state.killTimer?.ref();
      }
    });
  });
}

function emptyResult(started: number, extra: Partial<RunResult>): RunResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    stdoutHead: "",
    stdoutTail: "",
    stderrTail: "",
    stdoutBytes: 0,
    oversizeLines: 0,
    durationMs: Date.now() - started,
    ...extra,
  };
}

/** Execução curta e síncrona para diagnósticos; timeout usa SIGKILL e limpa o grupo POSIX, inclusive pipes herdados. */
export function runQuick(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { ok: boolean; code: number | null; stdout: string; stderr: string; error?: string } {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: false,
    windowsHide: true,
    ...(IS_WINDOWS ? {} : { detached: true }),
    timeout: opts.timeoutMs ?? 15000,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!IS_WINDOWS && r.error && r.pid > 0) {
    try {
      process.kill(-r.pid, "SIGKILL");
    } catch {}
  }
  return {
    ok: r.status === 0 && !r.error,
    code: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ...(r.error ? { error: r.error.message } : {}),
  };
}
