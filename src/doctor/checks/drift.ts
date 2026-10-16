// src/doctor/checks/drift.ts — gateway.json written by an older version (migration is `tcode migrate`'s job).
import { join } from "node:path";
import type { Check } from "../types";
import { finding, isRecord, readJsonFile } from "../util";

export const driftCheck: Check = {
  id: "config.drift",
  area: "config",
  title: "Configuration is current",
  async run(env) {
    const json = await readJsonFile(join(env.home, "gateway.json"));
    // Missing or unparsable: nothing to compare (the gateway check reports a broken file).
    if (!isRecord(json)) return [finding("config.drift", "ok", "No old-format configuration found")];
    if (json.workspace !== undefined && json.projects === undefined) {
      return [
        finding("config.drift", "warn", "gateway.json still uses the old `workspace` key", {
          detail: "Projects replaced it. Run `tcode migrate` to convert it (nothing changes until you do).",
        }),
      ];
    }
    return [finding("config.drift", "ok", "gateway.json uses the current format")];
  },
};
