// Antes de persistir eventos: remove raciocínio interno (reasoning/thinking) e aplica redação de segredos.
import type { Provider } from "../config.js";
import { redact } from "../redact.js";

const isThinking = (block: unknown): boolean =>
  typeof block === "object" && block !== null && ["thinking", "redacted_thinking"].includes(String((block as { type?: unknown }).type));


export function sanitizeEventLine(provider: Provider, line: string, redactor = redact): string {
  // O redator vê sempre a linha inteira (estado do stream correto), mas o raciocínio é identificado no evento ORIGINAL:
  // a redação pode trocar campos como `type` por "<redacted>" (bloco PEM aberto num evento anterior) e esconder a
  // classificação. Na dúvida (estrutura redigida não confere), o evento vira só um marcador fixo.
  const out = redactor(line);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return out.slice(0, 2000);
  }
  let ev: Record<string, unknown> | undefined;
  try {
    ev = JSON.parse(out) as Record<string, unknown>;
  } catch {
    ev = undefined;
  }
  if (provider === "codex") {
    const item = raw.item as Record<string, unknown> | undefined;
    if (item?.type === "reasoning") {
      const id = (ev?.item as Record<string, unknown> | undefined)?.id;
      return JSON.stringify({ ...(typeof ev?.type === "string" ? { type: ev.type } : {}), item: { ...(typeof id === "string" ? { id } : {}), type: "reasoning", omitted: true } });
    }
  } else {
    if (raw.type === "stream_event") {
      const inner = raw.event as { delta?: { type?: string } } | undefined;
      if (inner?.delta?.type === "thinking_delta" || inner?.delta?.type === "signature_delta") return JSON.stringify({ type: "stream_event", omitted: "thinking" });
    }
    const content = (raw.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content) && content.some(isThinking)) {
      const msg = ev?.message as Record<string, unknown> | undefined;
      const safe = msg?.content;
      if (!ev || !msg || !Array.isArray(safe) || safe.length !== content.length) return JSON.stringify({ omitted: "thinking" });
      const stripped = safe.map((block, i) => (isThinking(content[i]) ? { type: (content[i] as { type: string }).type, omitted: true } : block));
      return JSON.stringify({ ...ev, message: { ...msg, content: stripped } });
    }
  }
  return ev ? JSON.stringify(ev) : out.slice(0, 2000);
}
