// Evidência pós-execução registrada pelo próprio Codex no arquivo de sessão (rollout) da thread:
// modelo efetivo, provedor, IDs de resposta do servidor e ferramentas chamadas. O `codex exec --json`
// não informa o modelo; o rollout sim. Formato não contratual: tudo aqui é best-effort e validado.
// Só metadados são extraídos; o conteúdo da conversa nunca é copiado.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import * as zlib from "node:zlib";
import { join } from "node:path";

export type CodexRolloutEvidence = {
  source: "codex-rollout";
  file: string;
  threadId: string;
  model: string | null;
  modelProvider: string | null;
  originator: string | null;
  cliVersion: string | null;
  cwd: string | null;
  sandbox: string | null;
  effort: string | null;
  /** IDs de resposta distintos emitidos pelo servidor (ex.: resp_…); prova de chamadas reais ao provedor. */
  responseIds: number;
  /** Nomes de ferramentas chamadas (sem argumentos). */
  tools: string[];
  /** Imagens que a ferramenta de imagem do Codex gerou nesta thread. */
  generatedImages: { file: string; sha256: string }[];
};

const THREAD_ID = /^[0-9a-f-]{16,64}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Busca o rollout desde o início original, incluindo datas locais/UTC na fronteira. */
export function findRollout(codexHome: string, threadId: string, startedAtMs: number): string | null {
  if (!THREAD_ID.test(threadId) || !Number.isFinite(startedAtMs) || !Number.isFinite(new Date(startedAtMs).getTime())) return null;
  const days = new Set<string>();
  // Keep the first day even for long-lived sessions, and bound filesystem probes.
  const last = Date.now() + 2 * DAY_MS;
  for (let day = -1; day < 3660; day++) {
    const t = startedAtMs + day * DAY_MS;
    if (t > last) break;
    const d = new Date(t);
    // O Codex usa a data local no caminho; UTC cobre fusos em que a data difere.
    days.add([d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("/"));
    days.add([d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join("/"));
  }
  for (const day of days) {
    const dir = join(codexHome, "sessions", ...day.split("/"));
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => f.startsWith("rollout-"));
    const hit = files.find(f => f.endsWith(`-${threadId}.jsonl`)) ?? files.find(f => f.endsWith(`-${threadId}.jsonl.zst`));
    if (hit) return join(dir, hit);
  }
  return null;
}

export class RolloutReadError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/**
 * Divide um arquivo zstd nos seus frames (RFC 8878), conferindo que cada frame termina dentro do arquivo
 * (blocos completos, último bloco marcado, checksum presente). Frames "skippable" são pulados.
 * Arquivo vazio, magic desconhecido ou frame truncado: rollout_zstd_invalid.
 */
export function zstdFrames(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let pos = 0;
  const need = (n: number) => { if (pos + n > data.length) throw new RolloutReadError("rollout_zstd_invalid"); };
  if (!data.length) throw new RolloutReadError("rollout_zstd_invalid");
  while (pos < data.length) {
    need(4);
    const magic = data.readUInt32LE(pos);
    if ((magic & 0xfffffff0) === 0x184d2a50) { // skippable frame
      need(8);
      const size = data.readUInt32LE(pos + 4);
      pos += 8; need(size); pos += size;
      continue;
    }
    if (magic !== 0xfd2fb528) throw new RolloutReadError("rollout_zstd_invalid");
    const start = pos;
    pos += 4; need(1);
    const fhd = data[pos]!; pos += 1;
    const fcsFlag = fhd >> 6, singleSegment = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if ((fhd >> 3) & 1) throw new RolloutReadError("rollout_zstd_invalid"); // bit reservado
    const header = (singleSegment ? 0 : 1) + [0, 1, 2, 4][dictFlag]! + [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]!;
    need(header); pos += header;
    for (;;) {
      need(3);
      const bh = data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16);
      pos += 3;
      const last = bh & 1, type = (bh >> 1) & 3, size = bh >>> 3;
      if (type === 3) throw new RolloutReadError("rollout_zstd_invalid");
      const body = type === 1 ? 1 : size; // RLE: um byte repetido `size` vezes
      need(body); pos += body;
      if (last) break;
    }
    if (checksum) { need(4); pos += 4; }
    if (frames.length >= 100_000) throw new RolloutReadError("rollout_zstd_invalid"); // teto antes de reter a vista
    frames.push(data.subarray(start, pos));
  }
  if (!frames.length) throw new RolloutReadError("rollout_zstd_invalid");
  return frames;
}

/** Bound both the file read and the decompressor output, including archives with no declared content size. */
export function readBoundedRollout(file: string): string {
  const limit = 64 * 1024 * 1024;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RolloutReadError("rollout_missing");
    if (stat.size > limit) throw new RolloutReadError("rollout_size_limit_exceeded");
    const data = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const n = readSync(fd, data, offset, data.length - offset, null);
      if (!n) throw new RolloutReadError("rollout_missing");
      offset += n;
    }
    if (fstatSync(fd).size !== stat.size) throw new RolloutReadError("rollout_changed_during_read");
    if (!file.endsWith(".zst")) return data.toString("utf8");
    if (typeof zlib.zstdDecompressSync !== "function") throw new RolloutReadError("rollout_zstd_unavailable");
    // O decodificador do Node para no primeiro frame e devolve vazio num frame truncado, sem erro:
    // percorre os frames e decodifica um a um, exigindo que cada um esteja completo.
    // Cópia para um buffer só: as partes do Node guardam alocações maiores que o texto (16 KiB por frame pequeno).
    let buf = Buffer.allocUnsafe(Math.min(limit, 1024 * 1024)), total = 0;
    for (const frame of zstdFrames(data)) {
      let part: Buffer;
      try { part = zlib.zstdDecompressSync(frame, { maxOutputLength: limit - total }); }
      catch (error) {
        throw new RolloutReadError((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
          ? "rollout_size_limit_exceeded" : "rollout_zstd_invalid");
      }
      if (total + part.length > limit) throw new RolloutReadError("rollout_size_limit_exceeded");
      if (total + part.length > buf.length) {
        const grown = Buffer.allocUnsafe(Math.min(limit, Math.max(buf.length * 2, total + part.length)));
        buf.copy(grown, 0, 0, total);
        buf = grown;
      }
      part.copy(buf, total);
      total += part.length;
    }
    return buf.toString("utf8", 0, total);
  } finally { closeSync(fd); }
}

export function readRolloutEvidence(file: string, threadId: string, codexHome: string, bounded = false): CodexRolloutEvidence | null {
  let text: string;
  try {
    text = bounded || file.endsWith(".zst") ? readBoundedRollout(file) : readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const ev: CodexRolloutEvidence = {
    source: "codex-rollout",
    file,
    threadId,
    model: null,
    modelProvider: null,
    originator: null,
    cliVersion: null,
    cwd: null,
    sandbox: null,
    effort: null,
    responseIds: 0,
    tools: [],
    generatedImages: [],
  };
  const responses = new Set<string>();
  const tools = new Set<string>();
  let sessionOk = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; payload?: Record<string, unknown> };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec.payload ?? {};
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    if (rec.type === "session_meta") {
      if (p.id !== threadId) return null; // arquivo de outra sessão: não é evidência
      sessionOk = true;
      ev.originator = str(p.originator);
      ev.cliVersion = str(p.cli_version);
      ev.modelProvider = str(p.model_provider);
      ev.cwd = str(p.cwd);
    } else if (rec.type === "turn_context") {
      ev.model = str(p.model) ?? ev.model;
      ev.effort = str(p.effort) ?? ev.effort;
      const sb = p.sandbox_policy as { type?: unknown } | string | undefined;
      ev.sandbox = str(typeof sb === "object" && sb ? sb.type : sb) ?? ev.sandbox;
    } else if (rec.type === "token_usage_record") {
      const id = str(p.response_id);
      if (id) responses.add(id);
    } else if (rec.type === "response_item") {
      if (p.type === "function_call" && str(p.name)) tools.add(String(p.name));
      if (p.type === "custom_tool_call") {
        const input = typeof p.input === "string" ? p.input : "";
        for (const m of input.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g)) tools.add(m[1] as string);
        if (!input && str(p.name)) tools.add(String(p.name));
      }
      if (p.type === "image_generation_call") tools.add("image_generation");
    }
  }
  if (!sessionOk) return null;
  ev.responseIds = responses.size;
  ev.tools = [...tools].sort();
  const imgDir = join(codexHome, "generated_images", threadId);
  if (existsSync(imgDir)) {
    for (const f of readdirSync(imgDir).sort()) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(f)) ev.generatedImages.push({ file: join(imgDir, f), sha256: sha256File(join(imgDir, f)) });
    }
  }
  return ev;
}

export function collectCodexEvidence(codexHome: string, threadId: string | null, startedAtMs: number): CodexRolloutEvidence | null {
  if (!threadId) return null;
  const file = findRollout(codexHome, threadId, startedAtMs);
  return file ? readRolloutEvidence(file, threadId, codexHome) : null;
}
