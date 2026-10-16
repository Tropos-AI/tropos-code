// src/doctor/checks/settings.ts — every settings file Tropos would read parses and validates.
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
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const backup = `${path}.broken-${stamp}`;
    await copyFile(path, backup);
    let kept = "{}\n";
    try {
      const raw: unknown = JSON.parse(text);
      const parsed = settingsLayerSchema.safeParse(raw);
      if (parsed.success) return { ok: false, message: "the file is valid now; nothing changed" };
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const bad = new Set(parsed.error.issues.map((i) => i.path[0]).filter((k): k is string => typeof k === "string"));
        const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => !bad.has(k)));
        kept = `${JSON.stringify(rest, null, 2)}\n`;
      }
    } catch {
      // Unparsable JSON: nothing in it can be trusted, start from empty.
    }
    await writeFile(path, kept, { mode: 0o600 });
    await readSettingsFile(path); // throws (-> fix failed) if what we wrote is still invalid
    return { ok: true, message: `kept the valid settings; the old file is at ${backup}` };
  },
};
