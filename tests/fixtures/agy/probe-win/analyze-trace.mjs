#!/usr/bin/env node
// Lê o CSV do Process Monitor (captura sem filtro de processo) e confere o F5 do design: nenhum processo da árvore
// do agy (os lançamentos que a sonda registrou e os filhos deles) acessa o perfil real fora das pastas permitidas.
// Saída: 0 limpo, 1 acesso proibido, 2 rastreio incompleto ou uso errado. Caminhos impressos passam por redact().
// Uso: node analyze-trace.mjs <procmon.csv> <results.json>
import { spawnSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createTraceAnalyzer, redact, resolveAgy } from "./lib.mjs";

const [csvPath, resultsPath] = process.argv.slice(2);
if (!csvPath || !resultsPath) { console.error("uso: node analyze-trace.mjs <procmon.csv> <results.json>"); process.exit(2); }
const res = JSON.parse(readFileSync(resultsPath, "utf8"));
const launches = (res.launches ?? []).filter((l) => Number.isInteger(l.pid) && typeof l.image === "string");
if (!launches.length) { console.error("results.json sem PIDs e executáveis de lançamento do agy"); process.exit(2); }
const launchPids = launches.map((l) => l.pid);

// Permitido: só a raiz privada DESTA execução (não as de execuções anteriores), mais as pastas de instalação do agy e
// do Node recalculadas nesta máquina. O results.json foi limpo por redact: o perfil volta a partir de %USERPROFILE%.
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const runRoot = typeof res.root === "string" ? res.root.replace(/%USERPROFILE%/gi, homedir()) : null;
if (!runRoot || /<token>|<email>/.test(runRoot)) { console.error("results.json sem a raiz privada da execução legível"); process.exit(2); }
const allowed = [runRoot, dirname(process.execPath)];
const where = spawnSync("cmd.exe", ["/d", "/c", "where", "agy"], { encoding: "utf8", timeout: 15_000 });
const agy = resolveAgy(where.stdout ?? "", (p) => readFileSync(p, "utf8"));
if (agy.path) allowed.push(dirname(agy.path));
if (agy.script) { const m = /^(.*\\node_modules\\(?:@[^\\]+\\)?[^\\]+)/i.exec(agy.script); allowed.push(m ? m[1] : dirname(agy.script)); }
const forbidden = [join(homedir(), ".gemini"), process.env.APPDATA, localAppData].filter(Boolean);

if (!Number.isInteger(res.probePid)) { console.error("results.json sem o PID da sonda"); process.exit(2); }
const analyzer = createTraceAnalyzer({ probePid: res.probePid, launches, forbidden, allowed });
const rl = createInterface({ input: createReadStream(csvPath, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of rl) analyzer.line(line);
const r = analyzer.result();

const groups = new Map();
for (const h of r.hits) { const k = redact(`${h.process} ${h.op} ${h.path}`, homedir()); groups.set(k, (groups.get(k) ?? 0) + 1); }
for (const [k, n] of groups) console.log(`${n}x ${k}`);
console.log(`eventos lidos: ${r.rows}; lançamentos do agy: ${launchPids.length}`);
if (r.verdict === "forbidden" && r.missingPids.length) console.log(`(além disso, rastreio sem cobertura completa de ${r.missingPids.length} lançamento(s))`);
if (r.verdict === "incomplete") {
  console.log(`INCOMPLETO: rastreio sem criação, eventos de arquivo ou saída de ${r.missingPids.length} lançamento(s) do agy (PIDs ${r.missingPids.join(", ")}); capture de novo do início ao fim`);
  process.exit(2);
}
console.log(r.verdict === "forbidden" ? `PROIBIDO: ${r.hits.length} acesso(s) da árvore do agy ao perfil real fora das pastas permitidas` : "OK: a árvore do agy não acessou o perfil real fora das pastas permitidas");
process.exit(r.verdict === "forbidden" ? 1 : 0);
