// src/web/admin/config.ts — `config.*`: settings.json and gateway.json through the validated store. Secrets are masked
// on the way out, and a masked placeholder coming back never overwrites the real secret.
import { stat } from "node:fs/promises";
import { CONFIG_FILE_NAMES, getAt, ConfigStoreError, REDACTED, configFile, jsonSchemaOf, readConfigRaw, redact, setAt, unsetAt, updateConfigFile, type ConfigFileName } from "../../config/store";
import type { ConfigView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { jsonErrorOffset, lineColumn } from "./json-position";
import { messageOf, scrub } from "./util";

/** What the API shows in place of a secret (the store masks with its own string; both mean "keep the stored value" coming back). */
export const MASK = "••••";
const isMask = (v: unknown): boolean => v === MASK || v === REDACTED;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function fileOf(ctx: AdminContext, name: unknown) {
  if (!(CONFIG_FILE_NAMES as readonly unknown[]).includes(name)) throw new AdminError('The file must be "settings" or "gateway".');
  return configFile(ctx.home, name as ConfigFileName);
}

/** Every string in `value` that equals the placeholder, as a dotted path. */
function maskedPaths(value: unknown, at = ""): string[] {
  if (isMask(value)) return [at || "(root)"];
  if (Array.isArray(value)) return value.flatMap((v, i) => maskedPaths(v, at ? `${at}.${i}` : String(i)));
  if (isObject(value)) return Object.entries(value).flatMap(([k, v]) => maskedPaths(v, at ? `${at}.${k}` : k));
  return [];
}

/** Puts the stored secret back wherever the edited text still shows the placeholder. */
function restoreMasked(edited: unknown, stored: unknown): unknown {
  if (isMask(edited) && typeof stored === "string") return stored;
  if (Array.isArray(edited)) return edited.map((v, i) => restoreMasked(v, Array.isArray(stored) ? stored[i] : undefined));
  if (isObject(edited)) return Object.fromEntries(Object.entries(edited).map(([k, v]) => [k, restoreMasked(v, isObject(stored) ? stored[k] : undefined)]));
  return edited;
}

/** The store masks with "********"; the API's mask is "••••". */
function remask<T>(v: T): T {
  if (v === REDACTED) return MASK as T;
  if (Array.isArray(v)) return v.map(remask) as T;
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remask(x)])) as T;
  return v;
}

/** The store's reason, which names the zod issue path; nothing in it is a value. */
function refusal(err: unknown): AdminError {
  return new AdminError(scrub(err instanceof ConfigStoreError ? err.message : messageOf(err)));
}

export function configHandlers(ctx: AdminContext): AdminHandlers {
  // The running gateway rebuilds what the saved file feeds (channels, project contexts); the save stands either way.
  const reload = () => ctx.gateway?.reload().catch(() => undefined);
  const view = async (name: unknown): Promise<ConfigView> => {
    const file = fileOf(ctx, name);
    try {
      const modified = await stat(file.path).then((i) => i.mtime.toISOString(), () => undefined);
      return { file: file.label as ConfigFileName, path: file.path, value: remask(redact(await readConfigRaw(file))), schema: jsonSchemaOf(file), ...(modified ? { modifiedAt: modified } : {}) };
    } catch (err) {
      throw refusal(err);
    }
  };

  return {
    "config.get": (p) => view(p?.file),
    "config.raw": async (p) => {
      const v = await view(p?.file);
      return { text: `${JSON.stringify(v.value, null, 2)}\n`, path: v.path };
    },
    "config.set": async (p) => {
      const file = fileOf(ctx, p?.file);
      if (typeof p.path !== "string") throw new AdminError("Say which setting to change.");
      try {
        await updateConfigFile(file, (draft) => {
          if (p.value === null || p.value === undefined) return unsetAt(draft, p.path);
          // Masks inside the value keep what is stored at the same place.
          const restored = restoreMasked(p.value, getAt(draft, p.path));
          const left = maskedPaths(restored);
          if (left.length) throw new AdminError(`${[p.path, ...left].join(".")} holds the masked placeholder but there is no saved value to keep. Enter the real value.`);
          return setAt(draft, p.path, restored);
        });
      } catch (err) {
        throw refusal(err);
      }
      await reload();
      return view(p.file);
    },
    "config.apply": async (p) => {
      const file = fileOf(ctx, p?.file);
      if (typeof p.text !== "string") throw new AdminError("There is no text to apply.");
      let edited: unknown;
      try {
        edited = JSON.parse(p.text);
      } catch (err) {
        const at = jsonErrorOffset(p.text);
        const where = at >= 0 ? ` (line ${lineColumn(p.text, at).line}, column ${lineColumn(p.text, at).column})` : "";
        throw new AdminError(`Not valid JSON${where}: ${scrub(messageOf(err))}`);
      }
      if (!isObject(edited)) throw new AdminError("The file must hold a JSON object.");
      try {
        const stored = await readConfigRaw(file);
        const restored = restoreMasked(edited, stored) as Json;
        const still = maskedPaths(restored);
        if (still.length) throw new AdminError(`${still[0]} holds the masked placeholder but there is no saved value to keep. Enter the real value or remove the key.`);
        // Replacing, not merging: keys deleted in the editor are removed from the file.
        await updateConfigFile(file, () => restored);
      } catch (err) {
        throw err instanceof AdminError ? err : refusal(err);
      }
      await reload();
      return view(p.file);
    },
  };
}
