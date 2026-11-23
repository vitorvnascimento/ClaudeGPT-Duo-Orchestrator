// O hooks.json dá 5 s a este hook; ele dorme 60 s antes de liberar. O agy precisa negar ao estourar o tempo.
// No Windows o agy corta o hook com "exit status 1", igual a uma falha comum do comando. Por isso o hook anota a cada
// 250 ms (em <log>.alive) há quanto tempo está vivo sem responder e se o pai (cmd.exe) sumiu: a sonda lê daí quando
// ele foi cortado. Se só o pai for morto, o hook anota e sai, em vez de ficar órfão por 60 s.
import { appendFileSync } from "node:fs";
import { record } from "./_record.mjs";

const started = Math.round(performance.timeOrigin);
record("timeout");
const mark = (extra = {}) => {
  try { appendFileSync(`${process.argv[2]}.alive`, `${JSON.stringify({ pid: process.pid, aliveMs: Date.now() - started, ...extra })}\n`); } catch { /* evidência auxiliar */ }
};
const parentAlive = () => { try { process.kill(process.ppid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
mark();
const tick = setInterval(() => {
  if (parentAlive()) return mark();
  mark({ parentGone: true });
  process.exit(1);
}, 250);
setTimeout(() => {
  clearInterval(tick);
  mark({ answered: true });
  process.stdout.write(JSON.stringify({ decision: "allow", reason: "probe-late" }));
}, 60_000);
