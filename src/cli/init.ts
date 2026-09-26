// `duo init`: gera configuração e skills no escopo do projeto. Por padrão só mostra o plano (preview/diff);
// com --apply cria o que falta; arquivos existentes diferentes só são substituídos com --overwrite, após backup.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DEFAULT_CONFIG, type DuoConfig, type Provider } from "../config.js";
import { git } from "../git.js";
import { cliEntry, packageRoot } from "../paths.js";

export type PlannedFile = {
  rel: string;
  action: "create" | "unchanged" | "conflict" | "append";
  content: string;
  existing?: string;
};

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

/**
 * Comando gravado nas skills. Se `duo` no PATH aponta para esta mesma instalação (npm install -g / npm link),
 * grava só `duo`: as skills continuam valendo em outra máquina. Senão, o caminho absoluto desta instalação.
 */
export function duoCliCommand(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const entry = realpathSync(cliEntry());
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(dir, "duo");
      if (existsSync(candidate) && realpathSync(candidate) === entry) return "duo";
    }
  } catch {
    /* sem PATH legível: usa o caminho absoluto */
  }
  return `node "${cliEntry()}"`;
}

function suggestedConfig(projectRoot: string, brain: Provider): DuoConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.defaultBrain = brain;
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) cfg.acceptance.allowedCommands.push(["npm", "test"]);
  } catch {
    /* sem package.json */
  }
  return cfg;
}

export function planInit(projectRoot: string, brain: Provider): PlannedFile[] {
  const tpl = (p: string) => readFileSync(join(packageRoot(), "skills", p), "utf8");
  const cli = duoCliCommand();
  const wanted: { rel: string; content: string }[] = [
    { rel: ".duo/config.json", content: `${JSON.stringify(suggestedConfig(projectRoot, brain), null, 2)}\n` },
  ];
  const skills: { client: Provider; dir: string; refDir: string; vars: Record<string, string> }[] = [
    { client: "claude", dir: ".claude/skills/duo-delegate", refDir: "reference", vars: { DUO_CLI: cli, BRAIN: "claude", EXECUTOR: "codex" } },
    { client: "codex", dir: ".agents/skills/duo-delegate", refDir: "references", vars: { DUO_CLI: cli, BRAIN: "codex", EXECUTOR: "claude" } },
  ];
  for (const s of skills) {
    wanted.push({ rel: `${s.dir}/SKILL.md`, content: render(tpl(`${s.client}/duo-delegate/SKILL.md`), s.vars) });
    wanted.push({ rel: `${s.dir}/${s.refDir}/request-format.md`, content: render(tpl("shared/request-format.md"), s.vars) });
    wanted.push({ rel: `${s.dir}/${s.refDir}/decision-guide.md`, content: render(tpl("shared/decision-guide.md"), s.vars) });
  }
  const plan: PlannedFile[] = wanted.map(({ rel, content }) => {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) return { rel, action: "create", content };
    const existing = readFileSync(abs, "utf8");
    return existing === content ? { rel, action: "unchanged", content } : { rel, action: "conflict", content, existing };
  });
  const gi = join(projectRoot, ".gitignore");
  if (!existsSync(gi)) {
    plan.push({ rel: ".gitignore", action: "create", content: ".duo/\n" });
  } else {
    const existing = readFileSync(gi, "utf8");
    const hasLine = existing.split(/\r?\n/).some((l) => [".duo", ".duo/", "/.duo", "/.duo/"].includes(l.trim()));
    plan.push(hasLine ? { rel: ".gitignore", action: "unchanged", content: existing } : { rel: ".gitignore", action: "append", content: `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}.duo/\n`, existing });
  }
  return plan;
}

export function previewDiff(projectRoot: string, f: PlannedFile): string {
  if (f.action === "create") return `+ ${f.rel} (novo, ${f.content.split("\n").length - 1} linhas)`;
  if (f.action === "unchanged") return `= ${f.rel} (sem mudanças)`;
  const tmp = mkdtempSync(join(tmpdir(), "duo-init-"));
  try {
    const a = join(tmp, "atual");
    const b = join(tmp, "proposto");
    writeFileSync(a, f.existing ?? "");
    writeFileSync(b, f.content);
    const d = git(projectRoot, ["diff", "--no-index", "--no-color", "--", a, b]);
    const body = d.stdout.split("\n");
    const start = body.findIndex((l) => l.startsWith("@@"));
    const label = f.action === "append" ? "acréscimo" : "CONFLITO: existe e difere (use --overwrite para substituir com backup)";
    return [`~ ${f.rel} (${label})`, `--- ${f.rel} (atual)`, `+++ ${f.rel} (proposto)`, ...(start >= 0 ? body.slice(start) : [])].join("\n").trimEnd();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function applyInit(projectRoot: string, plan: PlannedFile[], overwrite: boolean): { written: string[]; skipped: string[]; backups: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  const backups: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of plan) {
    const abs = join(projectRoot, f.rel);
    if (f.action === "unchanged") continue;
    if (f.action === "conflict" && !overwrite) {
      skipped.push(f.rel);
      continue;
    }
    if (f.action === "conflict" || f.action === "append") {
      const backup = join(projectRoot, ".duo", "backups", stamp, f.rel);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(abs, backup);
      backups.push(backup);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(f.rel);
  }
  return { written, skipped, backups };
}
