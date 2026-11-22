import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateGeminiArgv } from "../src/adapters/gemini-argv.js";

const CANONICAL = ["-p=", "--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-4-argon-high",
  "--settings", '{"allowNonWorkspaceAccess":false}', "--disable-slash-commands"];

describe("argv do agy", () => {
  it("accepts the adapter's canonical argv", () => {
    assert.equal(validateGeminiArgv(CANONICAL), null);
    assert.equal(validateGeminiArgv([...CANONICAL, "--conversation", "abc", "--json-schema", "/tmp/s.json", "--mode", "plan"]), null);
    assert.ok(CANONICAL.includes("-p="));
  });

  it("rejects dangerously-skip-permissions anywhere", () => {
    assert.match(String(validateGeminiArgv([...CANONICAL, "--dangerously-skip-permissions"])), /--dangerously-skip-permissions/);
    assert.match(String(validateGeminiArgv(["--dangerously-skip-permissions", ...CANONICAL])), /--dangerously-skip-permissions/);
  });

  it("rejects remote-agent, remote-control, add-dir, new-project, agent and unknown flags", () => {
    for (const bad of [["--remote-agent"], ["--remote-control"], ["--add-dir", "/"], ["--new-project"], ["--agent", "x"], ["--effort", "high"], ["--sandbox"], ["--foo"]]) {
      assert.notEqual(validateGeminiArgv([...CANONICAL, ...bad]), null, bad.join(" "));
    }
  });

  it("rejects --mode other than accept-edits|plan and formats other than stream-json", () => {
    assert.notEqual(validateGeminiArgv([...CANONICAL, "--mode", "auto"]), null);
    assert.notEqual(validateGeminiArgv(["-p=", "--input-format", "text", "--output-format", "stream-json", "--model", "gemini-x"]), null);
    assert.notEqual(validateGeminiArgv(["-p=", "--input-format", "stream-json", "--output-format", "json", "--model", "gemini-x"]), null);
  });

  it("rejects -p followed by a separate value and other prompt forms", () => {
    for (const p of [["-p", "oi"], ["-p=oi"], ["--print", "x"], ["--prompt", "x"], ["-p"], ["-i", "x"]]) {
      const args = [...p, ...CANONICAL.slice(1)];
      assert.notEqual(validateGeminiArgv(args), null, p.join(" "));
    }
  });

  it("requires exactly one -p= and a value for value-taking flags", () => {
    assert.notEqual(validateGeminiArgv(CANONICAL.slice(1)), null);
    assert.notEqual(validateGeminiArgv([...CANONICAL, "-p="]), null);
    assert.notEqual(validateGeminiArgv(["-p=", "--input-format", "stream-json", "--output-format", "stream-json", "--model"]), null);
  });
});
