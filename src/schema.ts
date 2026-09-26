// Validador mínimo para o subconjunto de JSON Schema usado em schemas/.
// Os mesmos arquivos são enviados às CLIs (--json-schema / --output-schema),
// então há uma única fonte de verdade para o formato.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths.js";

export type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  [k: string]: unknown;
};

const cache = new Map<string, JsonSchema>();

export function schemaPath(name: string): string {
  return join(packageRoot(), "schemas", `${name}.schema.json`);
}

export function loadSchema(name: string): JsonSchema {
  const hit = cache.get(name);
  if (hit) return hit;
  const parsed = JSON.parse(readFileSync(schemaPath(name), "utf8")) as JsonSchema;
  cache.set(name, parsed);
  return parsed;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

export function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: esperado ${types.join("|")}, recebido ${typeOf(value)}`);
      return errors;
    }
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(`${path}: deve ser ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: valor fora de ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: menor que ${schema.minLength} caracteres`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: maior que ${schema.maxLength} caracteres`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: não corresponde a ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: menor que ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: maior que ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: mínimo de ${schema.minItems} itens`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: máximo de ${schema.maxItems} itens`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: obrigatório`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validate(sub, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: propriedade não permitida`);
    }
  }
  return errors;
}
