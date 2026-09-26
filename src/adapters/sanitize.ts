// Antes de persistir eventos: remove raciocínio interno (reasoning/thinking) e aplica redação de segredos.
import type { Provider } from "../config.js";
import { redact } from "../redact.js";

function stripThinking(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) =>
    typeof block === "object" && block !== null && ["thinking", "redacted_thinking"].includes(String((block as { type?: unknown }).type))
      ? { type: (block as { type: string }).type, omitted: true }
      : block,
  );
}

export function sanitizeEventLine(provider: Provider, line: string): string {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return redact(line.slice(0, 2000));
  }
  if (provider === "codex") {
    const item = ev.item as Record<string, unknown> | undefined;
    if (item && item.type === "reasoning") ev = { ...ev, item: { id: item.id, type: "reasoning", omitted: true } };
  } else {
    const msg = ev.message as Record<string, unknown> | undefined;
    if (msg && Array.isArray(msg.content)) ev = { ...ev, message: { ...msg, content: stripThinking(msg.content) } };
    if (ev.type === "stream_event") {
      const inner = ev.event as { delta?: { type?: string } } | undefined;
      if (inner?.delta?.type === "thinking_delta" || inner?.delta?.type === "signature_delta") return JSON.stringify({ type: "stream_event", omitted: "thinking" });
    }
  }
  return redact(JSON.stringify(ev));
}
