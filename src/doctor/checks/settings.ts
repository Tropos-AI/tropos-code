// src/doctor/checks/settings.ts — every settings file Tropos would read parses and validates.
import { constants, existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { SettingsError, readSettingsFile, settingsLayerSchema, settingsPaths } from "../../config/settings";
import type { Check } from "../types";
import { errorText, finding } from "../util";

export const settingsCheck: Check = {
  id: "settings.parse",
  area: "settings",
  title: "Settings files are valid",
  async run(env) {
    const paths = settingsPaths(env.cwd, env.home);
    const out = [];
    let checked = 0;
    for (const [label, path] of Object.entries(paths)) {
      try {
        if ((await readSettingsFile(path)) !== null) checked++;
      } catch (err) {
        out.push(
          finding(`settings.parse.${label}`, "error", `${path} is not valid`, {
            detail: err instanceof SettingsError ? err.message.replace(`Invalid settings file ${path}: `, "") : errorText(err),
            // Only the user's own files are ours to rewrite; a repo's file belongs to the repo.
            ...(label === "user" || label === "userProject" ? { fixable: true, safe: false, data: { path } } : {}),
          }),
        );
      }
    }
    return out.length ? out : [finding("settings.parse", "ok", checked ? `${checked} settings file${checked === 1 ? "" : "s"} parse` : "No settings files (defaults in use)")];
  },
  async fix(f) {
    const path = String(f.data?.path ?? "");
    if (!path) return { ok: false, message: "no settings file named" };
    const text = await readFile(path, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // Rewriting it would mean starting from nothing, deny rules included.
      return { ok: false, message: `${path} isn't valid JSON, so nothing in it can be kept safely; fix it by hand (the file is unchanged)` };
    }
    if (settingsLayerSchema.safeParse(raw).success) return { ok: false, message: "the file is valid now; nothing changed" };
    const repaired = dropInvalid(raw);
    if (!repaired.ok) return { ok: false, message: `${repaired.reason}; fix ${path} by hand (the file is unchanged)` };
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    let backup = `${path}.broken-${stamp}`;
    for (let n = 2; existsSync(backup); n++) backup = `${path}.broken-${stamp}-${n}`;
    await copyFile(path, backup, constants.COPYFILE_EXCL);
    await writeFile(path, `${JSON.stringify(repaired.value, null, 2)}\n`, { mode: 0o600 });
    await readSettingsFile(path); // throws (-> fix failed) if what we wrote is still invalid
    return { ok: true, message: `kept the valid settings; dropped: ${repaired.dropped.join(", ")}. The original is in ${backup}` };
  },
};

/**
 * Settings whose entries can go one at a time: the file itself, and maps keyed by name. Anything else goes as a whole
 * array element or map entry, never one key inside an object: a hook group without its `matcher` would run for every
 * tool.
 */
const MAPS = new Set(["", "permissions", "env", "providers", "mcpServers", "hooks", "formatter", "lsp"]);
/** Never dropped, nor anything holding them: losing a deny or ask rule, or askBeforeSaving, lets run what was guarded. */
const GUARDED: Path[] = [["permissions", "deny"], ["permissions", "ask"], ["learning", "askBeforeSaving"]];
/** More invalid entries than this is not a file worth repairing by dropping. */
const MAX_DROPS = 500;

type Path = readonly PropertyKey[];

const pathLabel = (path: Path): string =>
  path.map((k, i) => (typeof k === "number" ? `[${k}]` : `${i === 0 ? "" : "."}${String(k)}`)).join("");

const startsWith = (path: Path, prefix: Path): boolean => prefix.length <= path.length && prefix.every((k, i) => path[i] === k);

function child(value: unknown, key: PropertyKey): { found: boolean; value?: unknown } {
  if (Array.isArray(value)) return typeof key === "number" && key < value.length ? { found: true, value: value[key] } : { found: false };
  if (value !== null && typeof value === "object" && Object.hasOwn(value, key)) return { found: true, value: (value as Record<PropertyKey, unknown>)[key] };
  return { found: false };
}

function exists(root: unknown, path: Path): boolean {
  let at = root;
  for (const key of path) {
    const next = child(at, key);
    if (!next.found) return false;
    at = next.value;
  }
  return true;
}

function remove(root: unknown, path: Path): void {
  let parent = root;
  for (const key of path.slice(0, -1)) parent = child(parent, key).value;
  const last = path.at(-1)!;
  if (Array.isArray(parent)) parent.splice(last as number, 1);
  else delete (parent as Record<PropertyKey, unknown>)[last];
}

/** The whole array element or map entry that holds `path`. */
function entryOf(path: Path): Path {
  for (let n = path.length; n > 1; n--) {
    if (typeof path[n - 1] === "number" || MAPS.has(pathLabel(path.slice(0, n - 1)))) return path.slice(0, n);
  }
  return path.slice(0, 1);
}

/** Why `target` can't be dropped, or undefined when it can. */
function guarded(value: unknown, target: Path): string | undefined {
  if (pathLabel(target) === "permissions") return "permissions is not valid, and doctor never drops permission rules";
  for (const g of GUARDED) {
    if (startsWith(target, g) || (startsWith(g, target) && exists(value, g))) {
      return `${pathLabel(target)} is not valid, and doctor never drops anything holding ${pathLabel(g)}`;
    }
  }
  return undefined;
}

/**
 * Drops each invalid entry as a whole (an array element, a named map entry, a top-level setting), one at a time since
 * an array removal shifts the paths after it. Never drops the whole file, a permission rule or askBeforeSaving.
 */
function dropInvalid(raw: unknown): { ok: true; value: unknown; dropped: string[] } | { ok: false; reason: string } {
  const value = structuredClone(raw);
  const dropped: string[] = [];
  for (let n = 0; n <= MAX_DROPS; n++) {
    const parsed = settingsLayerSchema.safeParse(value);
    if (parsed.success) return { ok: true, value, dropped };
    const issue = parsed.error.issues[0]!;
    let path: Path = issue.path;
    // A required key that is missing: the entry that should hold it.
    while (path.length > 0 && !exists(value, path)) path = path.slice(0, -1);
    if (path.length === 0) return { ok: false, reason: `the file isn't a settings object (${issue.message})` };
    const target = entryOf(path);
    const refused = guarded(value, target);
    if (refused) return { ok: false, reason: `${refused} (${issue.message})` };
    remove(value, target);
    dropped.push(pathLabel(target));
  }
  return { ok: false, reason: "too many invalid entries to repair one by one" };
}
