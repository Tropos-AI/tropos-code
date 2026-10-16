// src/doctor/checks/sessions.ts — how much disk the saved sessions use.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "../types";
import { finding, formatBytes } from "../util";

export const SESSIONS_WARN_BYTES = 1 << 30;

async function treeSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await treeSize(p);
    else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

export function sessionsCheck(limit = SESSIONS_WARN_BYTES): Check {
  return {
    id: "sessions.disk",
    area: "sessions",
    title: "Session disk usage",
    async run(env) {
      const bytes = await treeSize(join(env.home, "projects"));
      if (bytes < limit) return [finding("sessions.disk", "ok", `Sessions use ${formatBytes(bytes)}`)];
      return [
        finding("sessions.disk", "warn", `Sessions use ${formatBytes(bytes)} (over ${formatBytes(limit)})`, {
          detail: `They live in ${join(env.home, "projects")}. Run \`tcode backup\` if you want a copy, then delete the folders of projects you no longer use.`,
        }),
      ];
    },
  };
}

export const sessionsDefaultCheck = sessionsCheck();
