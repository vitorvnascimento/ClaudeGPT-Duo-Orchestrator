import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  cacheIsStale,
  checkForUpdatesInBackground,
  compareVersions,
  currentVersion,
  fetchLatestRelease,
  installerEnv,
  parseLatestRelease,
  releaseUpdateCheck,
  reserveUpdateCheck,
  readUpdateCache,
  refreshUpdateCache,
  updateCachePath,
  updateCheckDisabled,
  updateNotice,
} from "../src/update.js";
import { CLI } from "./helpers.js";

const REPO = "https://github.com/vitorvnascimento/ClaudeGPT-Duo-Orchestrator";
const release = (version: string, extra: Record<string, unknown> = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  body: "\u001b[31mtexto livre nunca exibido\u001b[0m",
  assets: [{ browser_download_url: `${REPO}/releases/download/v${version}/duo-orchestrator-${version}.tgz` }],
  ...extra,
});

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "duo-update-"));
  return { dir, env: { HOME: dir, XDG_CACHE_HOME: join(dir, "cache"), PATH: process.env.PATH } };
}

describe("aviso de nova versão", () => {
  it("compara versões numericamente", () => {
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
    assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
    assert.equal(compareVersions("lixo", "1.0.0"), 0);
  });

  it("aceita só release estável deste repositório com o .tgz esperado", () => {
    assert.deepEqual(parseLatestRelease(release("0.3.0")), {
      version: "0.3.0",
      tarballUrl: `${REPO}/releases/download/v0.3.0/duo-orchestrator-0.3.0.tgz`,
      pageUrl: `${REPO}/releases/tag/v0.3.0`,
    });
    assert.equal(parseLatestRelease(release("0.3.0", { prerelease: true })), null);
    assert.equal(parseLatestRelease(release("0.3.0", { draft: true })), null);
    assert.equal(parseLatestRelease(release("0.3.0", { tag_name: "v0.3" })), null);
    assert.equal(parseLatestRelease(release("0.3.0", { tag_name: "v0.3.0\u001b[31m" })), null);
    assert.equal(parseLatestRelease(release("0.3.0", { assets: [{ browser_download_url: "https://evil.example/duo-orchestrator-0.3.0.tgz" }] })), null);
    assert.equal(parseLatestRelease(release("0.3.0", { assets: [] })), null);
    // Nome antigo do repositório (mesmo dono) continua aceito; outro dono, outro arquivo ou traversal, não.
    const old = "https://github.com/vitorvnascimento/duo-orchestrator/releases/download/v0.3.0/duo-orchestrator-0.3.0.tgz";
    assert.equal(parseLatestRelease(release("0.3.0", { assets: [{ browser_download_url: old }] }))?.pageUrl, "https://github.com/vitorvnascimento/duo-orchestrator/releases/tag/v0.3.0");
    for (const bad of [
      "https://github.com/outro-dono/ClaudeGPT-Duo-Orchestrator/releases/download/v0.3.0/duo-orchestrator-0.3.0.tgz",
      `${REPO}/releases/download/v0.3.0/duo-orchestrator-0.3.1.tgz`,
      `${REPO}/releases/download/v0.2.0/duo-orchestrator-0.3.0.tgz`,
      "https://github.com/vitorvnascimento/../releases/download/v0.3.0/duo-orchestrator-0.3.0.tgz",
      "https://github.com/vitorvnascimento/x/releases/download/v0.3.0/duo-orchestrator-0.3.0.tgz?a=1",
      "https://github.com.evil.example/vitorvnascimento/x/releases/download/v0.3.0/duo-orchestrator-0.3.0.tgz",
      "http://github.com/vitorvnascimento/x/releases/download/v0.3.0/duo-orchestrator-0.3.0.tgz",
    ]) assert.equal(parseLatestRelease(release("0.3.0", { assets: [{ browser_download_url: bad }] })), null, bad);
    assert.equal(parseLatestRelease(null), null);
  });

  it("a consulta não envia credenciais, mesmo com tokens no ambiente", async () => {
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
    process.env.GITHUB_TOKEN = "ghp_nao_pode_sair_daqui_0000000000";
    process.env.GH_TOKEN = "gho_nao_pode_sair_daqui_0000000000";
    try {
      const calls: { url: string; init: { headers: Record<string, string>; redirect: string } }[] = [];
      const latest = await fetchLatestRelease(async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => release("0.3.0") };
      });
      assert.equal(latest?.version, "0.3.0");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "https://api.github.com/repositories/1389886707/releases/latest", "consulta pelo ID: renomear o repositório não quebra o aviso");
      assert.deepEqual(Object.keys(calls[0]?.init.headers ?? {}).sort(), ["Accept", "User-Agent"]);
      assert.equal(calls[0]?.init.redirect, "error");
      assert.ok(!JSON.stringify(calls).includes("nao_pode_sair"));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("falha de rede grava a tentativa e preserva o último resultado conhecido", async () => {
    const { env, dir } = tempEnv();
    try {
      const ok = await refreshUpdateCache(env, async () => ({ ok: true, status: 200, json: async () => release("0.3.0") }), Date.parse("2026-10-01T00:00:00Z"));
      assert.equal(ok.latest?.version, "0.3.0");
      const failed = await refreshUpdateCache(env, async () => { throw new Error("offline"); }, Date.parse("2026-10-02T00:00:00Z"));
      assert.equal(failed.ok, false);
      assert.equal(failed.latest?.version, "0.3.0");
      assert.equal(cacheIsStale(failed, Date.parse("2026-10-02T23:00:00Z")), false, "falha também espera 24 h");
      assert.equal(cacheIsStale(failed, Date.parse("2026-10-03T00:00:00Z")), true);
      assert.equal(cacheIsStale(ok, Date.parse("2026-10-01T23:59:00Z")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha tardia não apaga o sucesso de uma consulta concorrente", async () => {
    const { env, dir } = tempEnv();
    try {
      const now = Date.parse("2026-10-01T00:00:00Z");
      let failLate!: () => void;
      const slow = refreshUpdateCache(env, () => new Promise((_, reject) => { failLate = () => reject(new Error("offline")); }), now);
      await refreshUpdateCache(env, async () => ({ ok: true, status: 200, json: async () => release("9.9.9") }), now + 1000);
      failLate();
      await slow;
      const notWritten = await refreshUpdateCache(env, async () => { throw new Error("offline"); }, now + 2000, false);
      assert.equal(notWritten.ok, true, "sem reserva devolve o resultado conhecido");
      assert.equal(readUpdateCache(env)?.latest?.version, "9.9.9");
      assert.equal(readUpdateCache(env)?.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("só um processo por vez reserva a consulta; reserva órfã expira", () => {
    const { env, dir } = tempEnv();
    try {
      const now = Date.now();
      assert.equal(reserveUpdateCheck(env, now), true);
      assert.equal(reserveUpdateCheck(env, now), false);
      assert.equal(reserveUpdateCheck(env, now + 11 * 60 * 1000), true, "reserva de processo morto é retomada");
      releaseUpdateCheck(env);
      assert.equal(reserveUpdateCheck(env, now), true);
      releaseUpdateCheck(env);
      // Cache recém-atualizado por outro processo entre a leitura e a reserva: não dispara consulta.
      writeFileSync(updateCachePath(env), JSON.stringify({ checkedAt: new Date(now).toISOString(), ok: true, latest: null }));
      checkForUpdatesInBackground({ ...env, PATH: "/nonexistent" }, () => {});
      assert.equal(reserveUpdateCheck(env, now), true, "reserva liberada, nenhum trabalhador ficou com ela");
      releaseUpdateCheck(env);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache substituído por FIFO não trava o comando", { skip: process.platform === "win32" }, () => {
    const { env, dir } = tempEnv();
    try {
      mkdirSync(join(updateCachePath(env), ".."), { recursive: true });
      assert.equal(spawnSync("mkfifo", [updateCachePath(env)]).status, 0);
      const started = Date.now();
      assert.equal(readUpdateCache(env), null);
      assert.equal(reserveUpdateCheck(env), true, "reserva prévia: o teste não dispara consulta real");
      let written = "";
      checkForUpdatesInBackground({ ...env, PATH: "/nonexistent" }, (x) => { written += x; });
      assert.equal(written, "");
      assert.ok(Date.now() - started < 1000);
    } finally {
      releaseUpdateCheck(env);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o instalador de duo update --apply não recebe tokens nem proxies do shell", () => {
    const env = installerEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "ghp_x", GH_TOKEN: "x", NPM_TOKEN: "x", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x", HTTPS_PROXY: "http://u:p@proxy", npm_config__authToken: "x" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
    const main = readFileSync(join(CLI, "..", "main.js"), "utf8");
    assert.match(main, /"--ignore-scripts"/);
    assert.match(main, /env: installerEnv\(\)/);
  });

  it("cache adulterado com URL de outro domínio é descartado", () => {
    const { env, dir } = tempEnv();
    try {
      mkdirSync(join(updateCachePath(env), ".."), { recursive: true });
      writeFileSync(updateCachePath(env), JSON.stringify({ checkedAt: new Date().toISOString(), ok: true, latest: { version: "9.9.9", tarballUrl: "https://evil.example/x.tgz", pageUrl: "x" } }));
      assert.equal(readUpdateCache(env)?.latest, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("avisa só quando a release é mais nova que a instalada", () => {
    const cache = (v: string) => ({ checkedAt: new Date().toISOString(), ok: true, latest: parseLatestRelease(release(v)) });
    assert.match(updateNotice(cache("9.9.9"), "0.2.0") ?? "", /nova versão 9\.9\.9.*instalada: 0\.2\.0/);
    assert.equal(updateNotice(cache("0.2.0"), "0.2.0"), null);
    assert.equal(updateNotice(cache("0.1.0"), "0.2.0"), null);
    assert.equal(updateNotice(null, "0.2.0"), null);
  });

  it("nunca consulta dentro de executor, CI, sandbox do Codex ou com DUO_NO_UPDATE_CHECK=1", () => {
    assert.equal(updateCheckDisabled({}), false);
    for (const env of [{ DUO_DEPTH: "1" }, { CI: "true" }, { CODEX_SANDBOX: "seatbelt" }, { DUO_NO_UPDATE_CHECK: "1" }]) assert.equal(updateCheckDisabled(env), true);
    let written = "";
    checkForUpdatesInBackground({ DUO_DEPTH: "1" }, (s) => { written += s; });
    assert.equal(written, "");
  });

  it("CLI mostra o aviso no stderr (stdout --json intacto) a partir de um cache recente", () => {
    const { env, dir } = tempEnv();
    try {
      mkdirSync(join(updateCachePath(env), ".."), { recursive: true });
      const latest = parseLatestRelease(release("9.9.9"));
      writeFileSync(updateCachePath(env), JSON.stringify({ checkedAt: new Date().toISOString(), ok: true, latest }));
      const r = spawnSync(process.execPath, [CLI, "quota", "show", "--json"], { cwd: dir, env: { ...env, DUO_NO_UPDATE_CHECK: "", CI: "", CODEX_SANDBOX: "" }, encoding: "utf8" });
      assert.match(r.stderr, /nova versão 9\.9\.9/);
      assert.doesNotMatch(r.stdout, /nova versão/);
      assert.equal(JSON.parse(readFileSync(updateCachePath(env), "utf8")).latest.version, "9.9.9");
      assert.ok(currentVersion());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
