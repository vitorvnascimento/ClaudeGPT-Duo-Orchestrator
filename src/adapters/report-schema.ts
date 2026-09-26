import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSchema, type JsonSchema } from "../schema.js";

/** Schema do relatório sem metadados ($schema, $id, title), no subconjunto aceito pelos modos estritos das CLIs. */
export function executorSchemaForCli(): JsonSchema {
  const { $schema: _s, $id: _i, title: _t, ...rest } = loadSchema("executor-report");
  return rest;
}

export function writeExecutorSchema(dir: string): string {
  const p = join(dir, "executor-report.schema.json");
  writeFileSync(p, JSON.stringify(executorSchemaForCli(), null, 2));
  return p;
}
