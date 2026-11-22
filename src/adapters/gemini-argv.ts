/**
 * Allowlist do argv passado ao agy (Antigravity CLI). Qualquer flag fora desta lista é recusada antes de invocar:
 * impede que um override de config ou um bug do adaptador ligue --dangerously-skip-permissions, agentes remotos etc.
 * O prompt vai por stdin; `-p=` (valor vazio) é a única forma aceita (verificado no agy 1.5.3: `-p` seguido de outra
 * flag consome essa flag como prompt).
 */

/** Id de modelo aceito do agy (e repassado em --model): minúsculas, dígitos, ponto e hífen, sem começar por hífen. */
export const AGY_MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
const VALUE_FLAGS: Record<string, ((v: string) => boolean) | null> = {
  "--input-format": (v) => v === "stream-json",
  "--output-format": (v) => v === "stream-json",
  "--model": (v) => AGY_MODEL_ID.test(v),
  "--settings": null,
  "--conversation": (v) => /^[A-Za-z0-9-]{1,80}$/.test(v),
  "--json-schema": null,
  "--mode": (v) => v === "accept-edits" || v === "plan",
};
const BOOL_FLAGS = new Set(["--disable-slash-commands"]);
export const GEMINI_ALLOWED_FLAGS: ReadonlySet<string> = new Set(["-p=", ...Object.keys(VALUE_FLAGS), ...BOOL_FLAGS]);

/** null = argv aceito; senão o motivo (português). */
export function validateGeminiArgv(args: readonly string[]): string | null {
  let prompts = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-p=") { prompts++; continue; }
    if (BOOL_FLAGS.has(a)) continue;
    if (Object.hasOwn(VALUE_FLAGS, a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) return `flag ${a} sem valor`;
      const check = VALUE_FLAGS[a];
      if (check && !check(v)) return `valor não permitido para ${a}: ${v}`;
      i++;
      continue;
    }
    return `flag não permitida no agy: ${a}`;
  }
  if (prompts !== 1) return "o argv do agy precisa de exatamente um -p= (prompt por stdin)";
  return null;
}
