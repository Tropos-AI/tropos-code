// src/doctor/checks/settings.ts — every settings file Tropos would read parses and validates.
import { SettingsError, readSettingsFile, settingsPaths } from "../../config/settings";
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
          }),
        );
      }
    }
    return out.length ? out : [finding("settings.parse", "ok", checked ? `${checked} settings file${checked === 1 ? "" : "s"} parse` : "No settings files (defaults in use)")];
  },
};
