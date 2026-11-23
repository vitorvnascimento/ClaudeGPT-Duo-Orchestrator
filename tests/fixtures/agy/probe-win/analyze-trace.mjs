#!/usr/bin/env node
// Lê o CSV do Process Monitor e lista acessos do agy/node a pastas proibidas do perfil real (F5 do design).
// Permitidos: a raiz privada da sonda, a pasta de instalação do agy e do Node. Sai com 1 se houver acesso proibido.
// Uso: node analyze-trace.mjs <procmon.csv> <results.json>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { analyzeTrace } from "./lib.mjs";

const [csvPath, resultsPath] = process.argv.slice(2);
if (!csvPath || !resultsPath) { console.error("uso: node analyze-trace.mjs <procmon.csv> <results.json>"); process.exit(2); }
const expand = (p) => (p ? p.replace(/%USERPROFILE%/gi, homedir()) : p);
const res = JSON.parse(readFileSync(resultsPath, "utf8"));
const forbidden = [win32.join(homedir(), ".gemini"), process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
const allowed = [res.root, res.node?.execDir, res.f1?.path && win32.dirname(res.f1.path), res.f1?.script && win32.dirname(res.f1.script)]
  .map(expand).filter(Boolean).map((p) => p.toLowerCase());
const { hits } = analyzeTrace(readFileSync(csvPath, "utf8"), forbidden);
const bad = hits.filter((h) => !allowed.some((a) => h.path.toLowerCase() === a || h.path.toLowerCase().startsWith(`${a}\\`)));
const groups = new Map();
for (const h of bad) { const k = `${h.process} ${h.op} ${h.path}`; groups.set(k, (groups.get(k) ?? 0) + 1); }
for (const [k, n] of groups) console.log(`${n}x ${k.replace(new RegExp(homedir().replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "gi"), "%USERPROFILE%")}`);
console.log(bad.length ? `PROIBIDO: ${bad.length} acesso(s) ao perfil real fora das pastas permitidas` : "OK: nenhum acesso do agy/node ao perfil real fora das pastas permitidas");
process.exit(bad.length ? 1 : 0);
