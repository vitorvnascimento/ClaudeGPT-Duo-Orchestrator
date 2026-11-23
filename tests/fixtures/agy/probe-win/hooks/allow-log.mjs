import { record } from "./_record.mjs";
record("allow-log");
process.stdout.write(JSON.stringify({ decision: "allow", reason: "probe" }));
