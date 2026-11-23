import { record } from "./_record.mjs";
record("deny");
process.stdout.write(JSON.stringify({ decision: "deny", reason: "probe-deny" }));
