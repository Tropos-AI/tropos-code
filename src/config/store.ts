// src/config/store.ts — safe write-back for the JSON config files under TROPOS_HOME (settings.json, gateway.json).
// One implementation serves both files: a file is a `{path, schema}` descriptor. Writes validate the result with
// the file's schema, keep unknown keys, rotate backups, and are atomic and private.
import { copyFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import * as gatewayModule from "../gateway/config";
import { settingsLayerSchema } from "./settings";

export interface ConfigFile {
  path: string;
  schema: z.ZodType;
  /** Short name for messages: "settings" or "gateway". */
  label: string;
}

export type ConfigFileName = "settings" | "gateway";
export const CONFIG_FILE_NAMES: readonly ConfigFileName[] = ["settings", "gateway"];

/** Why a read, a path or a write was refused. `issuePath` is the zod issue path for schema failures. */
export class ConfigStoreError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly issuePath?: string,
  ) {
    super(message);
  }
}

export const BACKUP_COUNT = 5; // settings.json.bak, .bak.1 ... .bak.4

export function userSettingsFile(home: string): ConfigFile {
  return { path: join(home, "settings.json"), schema: settingsLayerSchema, label: "settings" };
}

/**
 * The gateway module keeps its schema private today; use it when it is exported, otherwise this loose mirror
 * (unknown keys pass, so keys the gateway adds later are never refused here).
 */
const fallbackGatewaySchema = z.looseObject({
  workspace: z.string().min(1).optional(),
  telegram: z.looseObject({ botToken: z.string().min(1).optional() }).optional(),
  sandbox: z
    .looseObject({
      image: z.string().min(1).optional(),
      network: z.enum(["none", "bridge"]).optional(),
      memory: z.string().min(1).optional(),
      cpus: z.string().min(1).optional(),
    })
    .optional(),
  idleMinutes: z.number().int().min(1).max(24 * 60).optional(),
  webPort: z.number().int().min(1).max(65535).optional(),
});

export function gatewayFile(home: string, schema?: z.ZodType): ConfigFile {
  const exported = (gatewayModule as Record<string, unknown>)["gatewayConfigSchema"];
  const own = exported instanceof z.ZodType ? exported : undefined;
  return { path: gatewayModule.gatewayConfigPath(home), schema: schema ?? own ?? fallbackGatewaySchema, label: "gateway" };
}

export function configFile(home: string, name: ConfigFileName): ConfigFile {
  return name === "gateway" ? gatewayFile(home) : userSettingsFile(home);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The file's JSON object; a missing file is `{}`. A file that is not a JSON object is an error naming the file. */
export async function readConfigRaw(file: ConfigFile): Promise<Json> {
  let text: string;
  try {
    text = await readFile(file.path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigStoreError(`Cannot read ${file.path}: ${(err as Error).message}`, file.path);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ConfigStoreError(`${file.path} is not valid JSON: ${(err as Error).message}`, file.path);
  }
  if (!isObject(value)) throw new ConfigStoreError(`${file.path} must hold a JSON object.`, file.path);
  return value;
}

export const readUserSettingsRaw = (home: string): Promise<Json> => readConfigRaw(userSettingsFile(home));

/** The first schema problem of `value` as `{path, message}`, or undefined when it is valid. */
export function schemaProblem(file: ConfigFile, value: unknown): { path: string; message: string } | undefined {
  const parsed = file.schema.safeParse(value);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  return { path: issue?.path.join(".") || "(root)", message: issue?.message ?? "invalid value" };
}

/** Checks the file on disk: undefined when valid or absent, else the reason. */
export async function validateConfigFile(file: ConfigFile): Promise<string | undefined> {
  try {
    const problem = schemaProblem(file, await readConfigRaw(file));
    return problem ? `${problem.path}: ${problem.message}` : undefined;
  } catch (err) {
    return err instanceof ConfigStoreError ? err.message : (err as Error).message;
  }
}

// ---- dot paths ------------------------------------------------------------------------------------------------

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** "a.b.0.c" -> ["a","b","0","c"]. Empty segments and prototype-ish names are refused. */
export function parsePath(path: string): string[] {
  const segments = path.split(".");
  if (path === "" || segments.some((s) => s === "")) throw new Error(`"${path}" is not a valid path (use dots between keys, e.g. sandbox.network).`);
  const bad = segments.find((s) => FORBIDDEN_SEGMENTS.has(s));
  if (bad) throw new Error(`"${bad}" is not allowed in a path.`);
  return segments;
}

const isIndex = (s: string) => /^(0|[1-9]\d*)$/.test(s);

export function getAt(obj: unknown, path: string | string[]): unknown {
  let cur: unknown = obj;
  for (const seg of typeof path === "string" ? parsePath(path) : path) {
    if (Array.isArray(cur)) cur = isIndex(seg) ? cur[Number(seg)] : undefined;
    else if (isObject(cur) && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/** A copy of `obj` with `value` at `path`, creating objects on the way. `undefined` removes the key (or array item). */
export function setAt(obj: Json, path: string | string[], value: unknown): Json {
  const segments = typeof path === "string" ? parsePath(path) : path;
  const root = structuredClone(obj);
  let cur: Json | unknown[] = root;
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (Array.isArray(cur)) {
      if (!isIndex(seg)) throw new Error(`"${seg}" is not an index into the list at ${segments.slice(0, i).join(".")}.`);
      const idx = Number(seg);
      if (last) {
        if (value === undefined) cur.splice(idx, 1);
        else cur[idx] = value;
        return;
      }
      cur = (cur[idx] ??= {}) as Json | unknown[];
      return;
    }
    if (last) {
      if (value === undefined) delete cur[seg];
      else cur[seg] = value;
      return;
    }
    const next = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    if (next === undefined || next === null) cur[seg] = {};
    else if (typeof next !== "object") throw new Error(`${segments.slice(0, i + 1).join(".")} is not an object, so ${segments.slice(i + 1).join(".")} cannot be set.`);
    cur = cur[seg] as Json | unknown[];
  });
  return root;
}

export const unsetAt = (obj: Json, path: string | string[]): Json => setAt(obj, path, undefined);

// ---- comparison and merging ---------------------------------------------------------------------------------------

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Objects merge key by key, arrays and scalars replace, an `undefined` value deletes the key. */
export function mergePatch(base: Json, patch: Json): Json {
  const out: Json = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_SEGMENTS.has(k)) throw new Error(`"${k}" is not allowed as a key.`);
    if (v === undefined) delete out[k];
    else if (isObject(v) && isObject(out[k])) out[k] = mergePatch(out[k], v);
    else out[k] = structuredClone(v);
  }
  return out;
}

// ---- writing --------------------------------------------------------------------------------------------------------

/** .bak.3 -> .bak.4, ..., .bak -> .bak.1, then a private copy of the current file becomes .bak. */
async function rotateBackups(path: string): Promise<void> {
  const name = (i: number) => (i === 0 ? `${path}.bak` : `${path}.bak.${i}`);
  await rm(name(BACKUP_COUNT - 1), { force: true });
  for (let i = BACKUP_COUNT - 2; i >= 0; i--) await rename(name(i), name(i + 1)).catch(() => undefined);
  await copyFile(path, name(0));
  await chmod(name(0), 0o600);
}

export type Mutator = (draft: Json) => Json | void;
export type Patch = Json;

export interface UpdateResult {
  changed: boolean;
  before: Json;
  after: Json;
  path: string;
  /** The `.bak` written for the previous contents, when there were any. */
  backup?: string;
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Reads the file, applies `change` (a function over a copy, or a patch), validates the result with the file's
 * schema and writes it. Unknown keys survive (the schema only checks, the raw object is what is written).
 * Nothing is written when the result equals what is on disk. Concurrent updates in this process are serialised.
 */
export function updateConfigFile(file: ConfigFile, change: Mutator | Patch): Promise<UpdateResult> {
  const run = async (): Promise<UpdateResult> => {
    const before = await readConfigRaw(file);
    let after: Json;
    if (typeof change === "function") {
      const draft = structuredClone(before);
      const returned = change(draft);
      after = isObject(returned) ? returned : draft;
    } else {
      after = mergePatch(before, change);
    }
    const problem = schemaProblem(file, after);
    if (problem) throw new ConfigStoreError(`Refusing to write ${file.path}: ${problem.path}: ${problem.message}`, file.path, problem.path);
    if (sameJson(before, after)) return { changed: false, before, after, path: file.path };

    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    let backup: string | undefined;
    const existed = await readFile(file.path).then(
      () => true,
      () => false,
    );
    if (existed) {
      await rotateBackups(file.path);
      backup = `${file.path}.bak`;
    }
    const tmp = `${file.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(after, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { changed: true, before, after, path: file.path, backup };
  };
  const previous = queues.get(file.path) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(
    file.path,
    next.catch(() => undefined),
  );
  return next;
}

export const updateUserSettings = (home: string, change: Mutator | Patch): Promise<UpdateResult> => updateConfigFile(userSettingsFile(home), change);

// ---- schema and redaction -----------------------------------------------------------------------------------------

/** JSON Schema (draft 2020-12) of what the file accepts, for the web form and `tcode config schema`. */
export function jsonSchemaOf(file: ConfigFile): Record<string, unknown> {
  return z.toJSONSchema(file.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}
export const settingsJsonSchema = (): Record<string, unknown> => jsonSchemaOf(userSettingsFile(""));

const SECRET_KEY = /(^|[-_])(api[-_]?key|token|password|passwd|secret|key|authorization|credentials?)$|(apikey|token|password|secret)$/i;
const SECRET_VALUE = /^(sk-|sk_|xox[abprs]-|gh[pousr]_|github_pat_|AIza|Bearer\s)|^\d{6,}:[A-Za-z0-9_-]{30,}$/;
export const REDACTED = "********";

const isSecretEntry = (key: string | undefined, v: unknown): boolean =>
  typeof v === "string" && v !== "" && ((key !== undefined && SECRET_KEY.test(key)) || SECRET_VALUE.test(v));

/** True under mcpServers.<name>.env / .headers: whatever is configured there is credential material (tokens hide under any name). */
function inMcpSecrets(path: readonly string[]): boolean {
  const i = path.indexOf("mcpServers");
  return i >= 0 && path.length > i + 3 && (path[i + 2] === "env" || path[i + 2] === "headers");
}

/**
 * A copy of `value` where secret-looking entries (by key name or by shape of the value) are masked, and every value
 * under mcpServers.*.env and mcpServers.*.headers.
 */
export function redact<T>(value: T): T {
  const walk = (v: unknown, path: readonly string[]): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...path, k])]));
    if (typeof v === "string" && v !== "" && inMcpSecrets(path)) return REDACTED;
    return isSecretEntry(path.at(-1) && !/^\d+$/.test(path.at(-1)!) ? path.at(-1) : undefined, v) ? REDACTED : v;
  };
  return walk(value, []) as T;
}

/** A copy of `value` without the entries `redact` would mask: for backups made with --no-secrets. */
export function stripSecrets<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.filter((x) => !isSecretEntry(undefined, x)).map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).filter(([k, x]) => !isSecretEntry(k, x)).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  // An MCP server's env and headers are secrets as a whole (tokens, connection strings) whatever the keys are called.
  if (isObject(out) && isObject((out as Json).mcpServers)) {
    for (const server of Object.values((out as Json).mcpServers as Json)) {
      if (isObject(server)) {
        delete (server as Json).env;
        delete (server as Json).headers;
      }
    }
  }
  return out;
}

/** Redacts `value` as it would appear at the dotted `path` (the whole path counts: mcpServers.<name>.env.X is always a secret). */
export function redactAt(path: string, value: unknown): unknown {
  const segments = path.split(".");
  const wrapped = segments.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  return segments.reduce<unknown>((node, key) => (node as Json)[key], redact(wrapped));
}
