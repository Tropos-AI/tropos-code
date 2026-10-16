// web/src/components/admin/schema-utils.ts — reads the JSON Schema (draft 2020-12, as zod emits it) that config.get returns
// and decides which control each field gets. Anything it does not understand becomes the "json" kind, so the form never
// hides a field it cannot render.

export type Schema = Record<string, unknown>;

export type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "stringArray" | "object" | "record" | "json";

export interface FieldInfo {
  kind: FieldKind;
  schema: Schema;
  description?: string;
  readOnly: boolean;
  /** `enum` choices. */
  options?: Array<string | number>;
  /** `object`: the child properties in schema order. */
  properties?: Array<[string, Schema]>;
  /** `record`: what each value is. */
  valueKind?: "string" | "number" | "boolean";
  min?: number;
  max?: number;
  defaultValue?: unknown;
}

export const MASK = "••••";

const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

/** Follows "#/$defs/x" references against the root schema. */
export function deref(schema: Schema, root: Schema, depth = 0): Schema {
  const ref = schema["$ref"];
  if (typeof ref !== "string" || depth > 8 || !ref.startsWith("#/")) return schema;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) node = isObject(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return isObject(node) ? { ...deref(node, root, depth + 1), ...omit(schema, "$ref") } : schema;
}

function omit(schema: Schema, key: string): Schema {
  const { [key]: _removed, ...rest } = schema;
  return rest;
}

/** Collapses `anyOf`/`oneOf`/`allOf`/`type: [..., "null"]` wrappers (optional and nullable fields) to the one real schema. */
export function simplify(input: Schema, root: Schema): Schema {
  let schema = deref(input, root);
  const meta: Schema = {};
  for (const key of ["description", "default", "readOnly", "title"]) if (key in schema) meta[key] = schema[key];

  if (Array.isArray(schema["type"])) {
    const types = (schema["type"] as unknown[]).filter((t) => t !== "null");
    schema = { ...schema, type: types.length === 1 ? types[0] : types };
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const options = schema[key];
    if (!Array.isArray(options)) continue;
    const real = options.filter(isObject).map((o) => simplify(o, root)).filter((o) => o["type"] !== "null");
    if (real.length === 1) return { ...real[0]!, ...meta };
    // A union of string literals is an enum.
    const literals = real.map((o) => (o["const"] !== undefined ? [o["const"]] : Array.isArray(o["enum"]) ? (o["enum"] as unknown[]) : null));
    if (real.length > 1 && literals.every((l) => l !== null)) return { ...meta, enum: literals.flatMap((l) => l!) };
    return { ...omit(schema, key), ...meta, "x-complex": true };
  }
  if ("const" in schema && !("enum" in schema)) return { ...schema, enum: [schema["const"]] };
  return schema;
}

export function describeField(input: Schema, root: Schema): FieldInfo {
  const schema = simplify(input, root);
  const description = typeof schema["description"] === "string" ? schema["description"] : undefined;
  const base = { schema, description, readOnly: schema["readOnly"] === true, defaultValue: schema["default"] };
  if (schema["x-complex"]) return { ...base, kind: "json" };

  const options = schema["enum"];
  if (Array.isArray(options) && options.length > 0 && options.every((o) => typeof o === "string" || typeof o === "number")) {
    return { ...base, kind: "enum", options: options as Array<string | number> };
  }
  const type = schema["type"];
  if (type === "string") return { ...base, kind: "string" };
  if (type === "boolean") return { ...base, kind: "boolean" };
  if (type === "number" || type === "integer") {
    return {
      ...base,
      kind: type,
      min: typeof schema["minimum"] === "number" ? schema["minimum"] : undefined,
      max: typeof schema["maximum"] === "number" ? schema["maximum"] : undefined,
    };
  }
  if (type === "array") {
    const items = isObject(schema["items"]) ? simplify(schema["items"], root) : null;
    return items && items["type"] === "string" && !items["enum"] ? { ...base, kind: "stringArray" } : { ...base, kind: "json" };
  }
  if (type === "object" || isObject(schema["properties"])) {
    const props = isObject(schema["properties"]) ? Object.entries(schema["properties"]).filter((e): e is [string, Schema] => isObject(e[1])) : [];
    if (props.length > 0) return { ...base, kind: "object", properties: props };
    const extra = schema["additionalProperties"];
    if (isObject(extra)) {
      const valueType = simplify(extra, root)["type"];
      if (valueType === "string" || valueType === "number" || valueType === "boolean") return { ...base, kind: "record", valueKind: valueType };
    }
  }
  return { ...base, kind: "json" };
}

export function getAtPath(value: unknown, path: string): unknown {
  let node = value;
  for (const part of path.split(".")) {
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

export const isMasked = (value: unknown): boolean => typeof value === "string" && value.startsWith(MASK);

/** A string field that holds a secret: named like one, or already masked by the server. */
export function isSecretField(name: string, value: unknown): boolean {
  return /(^|[_-])(api[_-]?key|key|token|secret|password|passwd)$/i.test(name) || /(apikey|token|secret|password)$/i.test(name) || isMasked(value);
}

/** "defaultProject" → "Default project"; keeps ids like "mcpServers" readable too. */
export function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function lineOfPosition(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, position));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

/** Pulls "line N" out of a JSON.parse or server error message (V8 gives a position, others a line and column). */
export function errorLocation(message: string, text: string): { line: number; column?: number } | null {
  const lineCol = /line (\d+)(?: column (\d+))?/i.exec(message);
  if (lineCol) return { line: Number(lineCol[1]), column: lineCol[2] ? Number(lineCol[2]) : undefined };
  const pos = /position (\d+)/i.exec(message);
  if (pos) return lineOfPosition(text, Number(pos[1]));
  return null;
}
