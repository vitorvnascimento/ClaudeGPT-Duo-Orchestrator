// Handoff determinístico para trocar o cérebro: gera um documento para o usuário abrir/colar
// na sessão nativa do outro cliente. Não transfere sessões nem troca a interface do VS Code.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../config.js";
import { dirtyPaths, headCommit } from "../git.js";
import { Store } from "../state/store.js";

export function writeHandoff(projectRoot: string, to: Provider, runId: string | undefined, next: string | undefined): { path: string; content: string } {
  const store = new Store(projectRoot);
  const runs = store.listRuns();
  const run = runId ? store.loadRun(runId) : runs[runs.length - 1] ?? null;
  const lines: string[] = [];
  lines.push(`# Handoff para ${to === "claude" ? "Claude Code" : "Codex"} (novo cérebro)`);
  lines.push("");
  lines.push(`Gerado em ${new Date().toISOString()} pela ponte duo (determinístico, sem IA).`);
  lines.push("Revise antes de usar. O novo cérebro assume a partir daqui; a sessão anterior não deve continuar editando.");
  lines.push("");
  lines.push("## Estado do repositório");
  lines.push(`- HEAD: ${headCommit(projectRoot) ?? "(sem commits)"}`);
  const dirty = dirtyPaths(projectRoot).filter((p) => !p.startsWith(".duo/"));
  lines.push(`- Alterações não commitadas: ${dirty.length ? dirty.join(", ") : "nenhuma"}`);
  if (run) {
    lines.push("");
    lines.push(`## Run anterior: ${run.runId} (cérebro: ${run.brain}, política: ${run.policy})`);
    for (const t of store.listTasks(run)) {
      lines.push(`- ${t.taskId} [${t.executor}/${t.kind}] **${t.state}** — ${t.objective.slice(0, 160)}`);
      if (t.outcome) lines.push(`  - resultado: ${t.outcome.slice(0, 240)}`);
      if (t.verification?.diffPath) lines.push(`  - diff: ${t.verification.diffPath}`);
      if (t.accepted) lines.push(`  - decisão: ${t.accepted.accepted ? "aceita" : "rejeitada"} — ${t.accepted.note}`);
    }
    if (run.decisions.length) {
      lines.push("");
      lines.push("## Decisões registradas");
      for (const d of run.decisions) lines.push(`- (${d.kind}) ${d.text}`);
    }
  }
  lines.push("");
  lines.push("## Próximo passo");
  lines.push(next ?? run?.nextStep ?? "(defina o próximo passo)");
  lines.push("");
  lines.push("## Como continuar");
  lines.push(
    to === "claude"
      ? "Abra o Claude Code (extensão ou terminal) neste projeto, cole este arquivo ou referencie-o com @, e invoque /duo-delegate se precisar delegar ao Codex."
      : "Abra o Codex (extensão ou terminal) neste projeto, referencie este arquivo e invoque $duo-delegate se precisar delegar ao Claude Code.",
  );
  lines.push("Um novo run é criado na primeira delegação do novo cérebro (o cérebro não muda dentro de um run).");
  const content = `${lines.join("\n")}\n`;
  const dir = join(store.base, "handoffs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-para-${to}.md`);
  writeFileSync(path, content);
  if (run && next) {
    store.updateRun(run.runId, (fresh) => { fresh.nextStep = next; });
  }
  return { path, content };
}
