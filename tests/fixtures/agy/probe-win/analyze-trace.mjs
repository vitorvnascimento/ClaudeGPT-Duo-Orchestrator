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
import { createTraceAnalyzer, redact, resolveAgy, tracePolicy } from "./lib.mjs";

const [csvPath, resultsPath] = process.argv.slice(2);
if (!csvPath || !resultsPath) { console.error("uso: node analyze-trace.mjs <procmon.csv> <results.json>"); process.exit(2); }
const res = JSON.parse(readFileSync(resultsPath, "utf8"));
const launches = (res.launches ?? []).filter((l) => Number.isInteger(l.pid) && typeof l.image === "string");
if (!launches.length) { console.error("results.json sem PIDs e executáveis de lançamento do agy"); process.exit(2); }
const launchPids = launches.map((l) => l.pid);

// Política do F5 decidida só pelos caminhos do CSV (lib.tracePolicy). O results.json foi limpo por redact: a raiz
// desta execução volta a partir de %USERPROFILE%. O agy e o Node são localizados nesta máquina.
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const runRoot = typeof res.root === "string" ? res.root.replace(/%USERPROFILE%/gi, homedir()) : null;
if (!runRoot || /<token>|<email>/.test(runRoot)) { console.error("results.json sem a raiz privada da execução legível"); process.exit(2); }
const where = spawnSync("cmd.exe", ["/d", "/c", "where", "agy"], { encoding: "utf8", timeout: 15_000 });
const agy = resolveAgy(where.stdout ?? "", (p) => readFileSync(p, "utf8"));
const policy = tracePolicy({ home: homedir(), appData: process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), localAppData, runRoot, agyPath: agy.path, nodeDir: dirname(process.execPath) });

if (!Number.isInteger(res.probePid)) { console.error("results.json sem o PID da sonda"); process.exit(2); }
const analyzer = createTraceAnalyzer({ probePid: res.probePid, launches, policy });
const rl = createInterface({ input: createReadStream(csvPath, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of rl) analyzer.line(line);
const r = analyzer.result();

const groups = new Map();
for (const h of r.hits) { const k = redact(`${h.process} ${h.op} ${h.path}`, homedir()); groups.set(k, (groups.get(k) ?? 0) + 1); }
for (const [k, n] of groups) console.log(`${n}x ${k}`);
console.log(`eventos lidos: ${r.rows}; lançamentos do agy: ${launchPids.length}`);
if (r.noResultColumn) console.log("o CSV não tem a coluna Result: sem ela não dá para saber se um acesso aconteceu");
if (r.failed.length) console.log(`aberturas que falharam em pasta proibida (acesso negado etc.; não são acesso): ${r.failed.length}`);
const lookupNames = new Map();
for (const l of r.lookups) { const k = redact(l.path, homedir()); lookupNames.set(k, (lookupNames.get(k) ?? 0) + 1); }
if (lookupNames.size) {
  console.log(`procuras sem sucesso (o agy tentou e não achou; não são acesso): ${r.lookups.length}`);
  for (const [k, n] of [...lookupNames].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${n}x ${k}`);
}
const labelOf = (pid) => (res.launches ?? []).filter((l) => String(l.pid) === pid).map((l) => l.label).join(" / ");
for (const m of r.missing) console.log(`sem cobertura completa: PID ${m.pid} (${labelOf(m.pid)}) criado=${m.created} eventosDeArquivo=${m.fs} saiu=${m.exited} filhosVivos=${m.liveDescendants}`);
if (r.verdict === "incomplete") {
  console.log(`INCOMPLETO: ${r.missing.length} lançamento(s) do agy sem criação, eventos de arquivo ou saída no rastreio; capture de novo do início ao fim`);
  process.exit(2);
}
console.log(r.verdict === "forbidden" ? `PROIBIDO: ${r.hits.length} acesso(s) da árvore do agy ao perfil real fora das pastas permitidas` : "OK: a árvore do agy não acessou o perfil real fora das pastas permitidas");
process.exit(r.verdict === "forbidden" ? 1 : 0);
