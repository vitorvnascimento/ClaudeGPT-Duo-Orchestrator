// Prompt compacto do executor: só o necessário para a subtarefa. Nunca inclui histórico nem o repositório.
import { isWriteKind, type Task } from "../state/types.js";

export type PromptExtras = {
  dirtyInScope: string[];
  resume: { alreadyModified: string[] } | null;
  worktree: boolean;
  interfaces?: string;
  decisions?: string[];
  notes?: string;
};

export function buildExecutorPrompt(task: Task, extras: PromptExtras): string {
  const writes = isWriteKind(task.kind);
  const lines: string[] = [];
  lines.push("# duo-orchestrator — bounded executor task");
  lines.push("");
  lines.push("You are the EXECUTOR (delegation depth = 1). You must NOT delegate, call other AI CLIs (claude, codex), run `duo`, or invoke skills/orchestrators.");
  lines.push(`Task: ${task.taskId} | kind: ${task.kind} | brain: ${task.brain}`);
  lines.push("");
  lines.push("## Objective");
  lines.push(task.objective);
  lines.push("");
  lines.push(writes ? "## Authorized paths (modify ONLY these)" : "## Paths to inspect (READ-ONLY task: do not modify any file)");
  for (const p of task.scope) lines.push(`- ${p}`);
  if (task.constraints.length) {
    lines.push("");
    lines.push("## Constraints");
    for (const c of task.constraints) lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push("## Base state");
  lines.push(`- git HEAD: ${task.base?.head ?? "(no commits)"}`);
  if (extras.worktree) lines.push("- You are in a disposable git worktree created from HEAD.");
  if (extras.dirtyInScope.length) {
    lines.push(`- Pre-existing uncommitted user changes in scope (preserve them, build on top): ${extras.dirtyInScope.join(", ")}`);
  }
  if (extras.resume) {
    lines.push("");
    lines.push("## RESUME");
    lines.push("A previous attempt of this task was interrupted. Inspect the current file state and continue from it.");
    lines.push(`Files already modified since the base: ${extras.resume.alreadyModified.length ? extras.resume.alreadyModified.join(", ") : "(none detected)"}`);
    lines.push("Do NOT re-apply changes that are already present.");
  }
  if (extras.interfaces) {
    lines.push("");
    lines.push("## Interfaces / context");
    lines.push(extras.interfaces);
  }
  if (extras.decisions?.length) {
    lines.push("");
    lines.push("## Decisions already made (do not revisit)");
    for (const d of extras.decisions) lines.push(`- ${d}`);
  }
  if (extras.notes) {
    lines.push("");
    lines.push("## Notes");
    lines.push(extras.notes);
  }
  if (task.needs.includes("image_generation")) {
    lines.push("");
    lines.push("## Image generation");
    lines.push("Use your image generation tool to create the requested image. Save the final image file(s) (PNG, JPEG or WebP) INSIDE the authorized paths above, with the exact file name requested; copy the file there if the tool saved it elsewhere.");
    lines.push("List the saved file paths in filesChanged. The bridge verifies that a valid image file exists in scope.");
  }
  lines.push("");
  lines.push("## Acceptance criteria");
  for (const c of task.acceptanceCriteria) lines.push(`- ${c}`);
  if (task.acceptanceCommands.length) {
    lines.push("");
    lines.push("The bridge will independently run these commands after you finish (your claims are not trusted without them):");
    for (const c of task.acceptanceCommands) lines.push(`- ${c.name}: ${c.argv.join(" ")}`);
    lines.push("If you run them yourself, use exactly the command above from the working directory (no pipes, `;`, `&&` or absolute paths); running any other program is denied, but reading files is allowed (see Rules).");
    lines.push('If the requested change is done but you could not run a command, still return status "completed" and mention it in limitations: the bridge runs the checks anyway.');
  }
  lines.push("");
  lines.push("## Rules");
  lines.push("- Never read or print .env files, credential files, or secret values (API keys, tokens, passwords, private keys).");
  lines.push("- Source code under the authorized paths is always readable and editable, even when its name or path suggests auth, token or security logic: that is the task, not a secret.");
  lines.push("- You may read any file inside the authorized paths and the tests that exercise them, using the read tools you have (a shell command like cat or sed on those files is allowed for READING); only the acceptance command restriction above limits running programs.");
  lines.push("- Do not run git commit, push, reset, clean, stash or checkout; do not delete user files outside the task.");
  lines.push("- If you cannot finish within the authorized paths, stop and return status \"blocked\" with blockedReason.");
  lines.push("- Report only tests you actually ran, with their real exit codes.");
  lines.push("");
  lines.push("## Output");
  lines.push("Return ONLY a JSON object matching the provided schema: status, summary, filesChanged, testsRun, limitations, blockedReason.");
  return `${lines.join("\n")}\n`;
}
