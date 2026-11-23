import { record } from "./_record.mjs";
record("crash");
throw new Error("probe-crash");
