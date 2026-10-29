import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { resolveExecutable } from "../src/adapters/resolve.js";

// Shims reais do npm (cmd-shim) para pacotes com bin .js e com bin .exe.
const JS_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;
const EXE_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`;

function npmPrefix(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "duo-resolve-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content, { mode: 0o755 });
  }
  return dir;
}

describe("resolveExecutable no Windows (shims do npm)", () => {
  it("shim .cmd de bin .js executa o script com este node, sem shell", () => {
    const dir = npmPrefix({ "codex.cmd": JS_SHIM, "node_modules/@openai/codex/bin/codex.js": "" });
    const r = resolveExecutable("codex", null, { PATH: dir }, "win32");
    assert.deepEqual(r, { ok: true, command: process.execPath, prefixArgs: [join(dir, "node_modules/@openai/codex/bin/codex.js")], source: "path" });
  });

  it("shim .cmd de bin .exe executa o .exe direto", () => {
    const dir = npmPrefix({ "claude.cmd": EXE_SHIM, "node_modules/@anthropic-ai/claude-code/bin/claude.exe": "" });
    const r = resolveExecutable("claude", null, { PATH: dir }, "win32");
    assert.deepEqual(r, { ok: true, command: join(dir, "node_modules/@anthropic-ai/claude-code/bin/claude.exe"), prefixArgs: [], source: "path" });
  });

  it(".exe no PATH continua tendo prioridade sobre o shim", () => {
    const dir = npmPrefix({ "codex.exe": "", "codex.cmd": JS_SHIM, "node_modules/@openai/codex/bin/codex.js": "" });
    assert.equal((resolveExecutable("codex", null, { PATH: dir }, "win32") as { command: string }).command, join(dir, "codex.exe"));
  });

  it("recusa shim que não é do npm, alvo ausente, fora de node_modules ou com extensão perigosa", () => {
    const cases: Record<string, string>[] = [
      { "codex.cmd": "@echo off\r\nnode C:\\x\\codex.js %*\r\n" },
      { "codex.cmd": JS_SHIM },
      { "codex.cmd": JS_SHIM.replace("node_modules\\@openai\\codex\\bin\\codex.js", "node_modules\\..\\evil.js"), "evil.js": "" },
      { "codex.cmd": EXE_SHIM.replace("@anthropic-ai\\claude-code\\bin\\claude.exe", "x\\run.bat"), "node_modules/x/run.bat": "" },
      { "codex.cmd": `${JS_SHIM}"%dp0%\\node_modules\\b\\other.js"\r\n`, "node_modules/@openai/codex/bin/codex.js": "", "node_modules/b/other.js": "" },
      { "codex.bat": JS_SHIM, "node_modules/@openai/codex/bin/codex.js": "" },
    ];
    for (const files of cases) {
      const r = resolveExecutable("codex", null, { PATH: npmPrefix(files) }, "win32");
      assert.equal(r.ok, false, JSON.stringify(files));
      assert.match((r as { reason: string }).reason, /shim/);
    }
  });
});
