// Evidência pós-execução registrada pelo próprio Codex no arquivo de sessão (rollout) da thread:
// modelo efetivo, provedor, IDs de resposta do servidor e ferramentas chamadas. O `codex exec --json`
// não informa o modelo; o rollout sim. Formato não contratual: tudo aqui é best-effort e validado.
// Só metadados são extraídos; o conteúdo da conversa nunca é copiado.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** Procura `sessions/AAAA/MM/DD/rollout-*-<threadId>.jsonl` nos dias próximos ao início da tarefa. */
export function findRollout(codexHome: string, threadId: string, startedAtMs: number): string | null {
  if (!THREAD_ID.test(threadId)) return null;
  const days = new Set<string>();
  for (const t of [startedAtMs - DAY_MS, startedAtMs, Date.now(), Date.now() + DAY_MS]) {
    const d = new Date(t);
    // O Codex usa a data local no caminho; UTC cobre fusos em que a data difere.
    days.add([d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("/"));
    days.add([d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join("/"));
  }
  for (const day of days) {
    const dir = join(codexHome, "sessions", ...day.split("/"));
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.startsWith("rollout-") && f.endsWith(`-${threadId}.jsonl`));
    if (hit) return join(dir, hit);
  }
  return null;
}

export function readRolloutEvidence(file: string, threadId: string, codexHome: string): CodexRolloutEvidence | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
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
