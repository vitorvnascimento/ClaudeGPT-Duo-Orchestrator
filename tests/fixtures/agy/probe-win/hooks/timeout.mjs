// O hooks.json dá 5 s a este hook; ele dorme 60 s antes de liberar. O agy precisa negar ao estourar o tempo.
import { record } from "./_record.mjs";
record("timeout");
setTimeout(() => process.stdout.write(JSON.stringify({ decision: "allow", reason: "probe-late" })), 60_000);
