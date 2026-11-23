// Ensaio do probe.mjs no Mac com um agy falso: --dry-run acha o agy, prova o login sem inferência e não gasta cota.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./probe.mjs", import.meta.url));

function fakeAgy(dir, { login }) {
  const agy = join(dir, "agy");
  writeFileSync(agy, `#!/bin/sh
case "$1" in
  --version) echo "1.5.99" ;;
  --help) echo "usage: agy --model --output-format" ;;
  models)
    mkdir -p "$HOME/.gemini/antigravity-cli/log"
    printf '%s\\n' "${login}" > "$HOME/.gemini/antigravity-cli/log/a.log"
    echo "gemini-3.8-flash-low" ;;
  *) echo "inferência não deveria rodar no dry-run" >&2; exit 9 ;;
esac
`);
  chmodSync(agy, 0o755);
  return agy;
}

function runDry(login) {
  const dir = mkdtempSync(join(tmpdir(), "probe-dry-"));
  const agy = fakeAgy(dir, { login });
  const out = join(dir, "out");
  const r = spawnSync(process.execPath, [probe, "--dry-run", "--out", out], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PROBE_WHERE_OVERRIDE: agy, PROBE_ROOT_OVERRIDE: join(dir, "roots") },
  });
  const run = readdirSync(out)[0];
  const text = readFileSync(join(out, run, "results.json"), "utf8");
  return { r, text, res: JSON.parse(text) };
}

test("dry-run com login de assinatura: prossegue, sem e-mail na evidência", () => {
  const { r, text, res } = runDry("ChainedAuth: authenticated via keyring (effective: keyring) user ana@example.com authMethod=consumer");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(res.f1.version, "1.5.99");
  assert.equal(res.f4.verdict, "proceed");
  assert.deepEqual(res.f4.models, ["gemini-3.8-flash-low"]);
  assert.equal(res.quota, null);
  assert.equal(text.includes("@"), false);
});

test("dry-run com login por API: para antes de qualquer inferência", () => {
  const { r, res } = runDry("authMethod=api_key");
  assert.equal(r.status, 3);
  assert.equal(res.f4.verdict, "stop");
  assert.match(res.stop, /^STOP F4/);
});
