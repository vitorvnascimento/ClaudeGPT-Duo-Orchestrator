import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSchema, type JsonSchema } from "../schema.js";

/** Schema do relatório sem metadados ($schema, $id, title), no subconjunto aceito pelos modos estritos das CLIs. */
export function executorSchemaForCli(computerUse = false): JsonSchema {
  const { $schema: _s, $id: _i, title: _t, ...rest } = structuredClone(loadSchema("executor-report"));
  if (computerUse) {
    rest.required = [...(rest.required ?? []), "appsUsed"];
  } else if (rest.properties) {
    delete rest.properties.appsUsed;
  }
  return rest;
}

export function writeExecutorSchema(dir: string, computerUse = false): string {
  const p = join(dir, "executor-report.schema.json");
  writeFileSync(p, JSON.stringify(executorSchemaForCli(computerUse), null, 2));
  return p;
}
