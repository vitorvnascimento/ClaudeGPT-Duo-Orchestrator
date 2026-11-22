#!/usr/bin/env node
// Gate da sonda: libera só write_file/edit_file no alvo GATE_TARGET; nega todo o resto. Registra entrada e decisão.
import { appendFileSync, readFileSync } from "node:fs";
const target = process.env.GATE_TARGET, log = process.env.GATE_LOG;
const j = JSON.parse(readFileSync(0, "utf8"));
const name = j.toolCall?.name ?? "", args = j.toolCall?.args ?? {};
const path = args.Path ?? args.TargetFile ?? args.AbsolutePath ?? null;
const decision = /^(write_file|edit_file)$/.test(name) && path === target ? "allow" : "deny";
appendFileSync(log, JSON.stringify({ tool: name, path, decision }) + "\n");
process.stdout.write(JSON.stringify({ decision, reason: "duo-gate" }));
