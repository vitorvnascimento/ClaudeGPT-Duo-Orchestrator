import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packageRoot } from "../src/paths.js";
import type { AuthPaths } from "../src/permissions/auth.js";

export const FAKE_CLAUDE = join(packageRoot(), "tests", "fixtures", "fake-claude.mjs");
export const FAKE_CODEX = join(packageRoot(), "tests", "fixtures", "fake-codex.mjs");
export const CLI = join(packageRoot(), "dist", "src", "cli", "main.js");

export type Sandbox = {
  tmp: string;
  root: string;
  home: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  authPaths: AuthPaths;
  log(): Record<string, unknown>[];
  execCalls(): Record<string, unknown>[];
  request(obj: Record<string, unknown>, name?: string): string;
  config(patch: Record<string, unknown>): void;
  write(rel: string, content: string): void;
  read(rel: string): string;
  git(...args: string[]): string;
  cleanup(): void;
};

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object" && !Array.isArray(v) ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

export function makeSandbox(configPatch: Record<string, unknown> = {}): Sandbox {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "duo-test-")));
  const root = join(tmp, "repo");
  const home = join(tmp, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  const logPath = join(tmp, "fake-log.jsonl");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".duo/\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(root, "src", "util.ts"), "export const util = 1;\n");
  writeFileSync(join(root, "README.md"), "# demo\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  let cfg: Record<string, unknown> = {
    executors: { claude: { command: ["node", FAKE_CLAUDE] }, codex: { command: ["node", FAKE_CODEX] } },
    billing: { acknowledgeUnverifiableExtraUsage: { claude: true, codex: true } },
    limits: { timeoutSec: 20, maxOutputBytes: 200_000 },
    acceptance: { allowedCommands: [["node", "-e"]] },
  };
  cfg = deepMerge(cfg, configPatch);
  const writeCfg = () => {
    mkdirSync(join(root, ".duo"), { recursive: true });
    writeFileSync(join(root, ".duo", "config.json"), JSON.stringify(cfg, null, 2));
  };
  writeCfg();

  const env: NodeJS.ProcessEnv = {};
  // Os testes simulam a execução fora do sandbox do Codex (onde duo delegate realmente roda).
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("DUO_") && !k.startsWith("FAKE_") && !k.startsWith("CODEX_SANDBOX")) env[k] = v;
  Object.assign(env, { DUO_NO_UPDATE_CHECK: "1", HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), FAKE_LOG: logPath });

  const readLog = () =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  let n = 0;
  return {
    tmp,
    root,
    home,
    logPath,
    env,
    authPaths: { home, projectRoot: root, claudeManagedSettings: [join(tmp, "managed-settings.json")] },
    log: readLog,
    execCalls: () => readLog().filter((e) => e.cmd === "print" || e.cmd === "exec"),
    request(obj, name) {
      const p = join(tmp, name ?? `req-${++n}.json`);
      writeFileSync(p, JSON.stringify(obj));
      return p;
    },
    config(patch) {
      cfg = deepMerge(cfg, patch);
      writeCfg();
    },
    write(rel, content) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    },
    read(rel) {
      return readFileSync(join(root, rel), "utf8");
    },
    git: g,
    cleanup() {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// Cérebro realista nos pedidos adaptativos: o modelo do cérebro é conhecido (exigido para delegar ao mesmo
// cliente com escolha automática) e nunca é escolhido automaticamente nos catálogos de teste (Fable só com
// ciência+include; gpt-5.5 é legado). Testes que exercitam o próprio cérebro informam brainModel explicitamente.
const DEFAULT_BRAIN_MODEL = { claude: "claude-fable-5-1", codex: "gpt-5.5" } as const;

export function baseRequest(brain: "claude" | "codex", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const req = baseRequestRaw(brain, overrides);
  if (req.adaptive === true && !("brainModel" in overrides)) req.brainModel = DEFAULT_BRAIN_MODEL[brain];
  return req;
}

function baseRequestRaw(brain: "claude" | "codex", overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    adaptive: false, // Contrato pré-adaptativo; testes da fase 2 optam por true.
    brain,
    executor: brain === "claude" ? "codex" : "claude",
    kind: "implement",
    objective: "Adicionar a constante nova em src/app.ts sem alterar outros arquivos.",
    reason: "clear_benefit",
    rationale: "Subtarefa isolada em um arquivo.",
    scope: { allowedPaths: ["src/app.ts"] },
    acceptance: { criteria: ["src/app.ts exporta a constante nova"] },
    ...overrides,
  };
}
