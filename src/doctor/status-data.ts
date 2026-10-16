// src/doctor/status-data.ts — the pieces of "what state is this install in" that `tcode status` and the web status call share.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveLayout } from "../install/layout";
import { compareVersions, isVersion, newestFirst } from "../install/version";
import { isRecord } from "./util";

/** A job list in any shape we know of: a JSON array, {jobs: [...]}, or one JSON object per line. Unreadable means unknown. */
export async function countJobs(home: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(join(home, "gateway", "cron", "jobs.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const json: unknown = JSON.parse(text);
    if (Array.isArray(json)) return json.length;
    if (isRecord(json) && Array.isArray(json.jobs)) return json.jobs.length;
    if (isRecord(json)) return Object.keys(json).length;
  } catch {
    // maybe JSON lines
  }
  return text.split("\n").filter((l) => l.trim()).length;
}

/** The newest version installed on disk when it is newer than the running one: an update waiting for a restart. No network. */
export async function updateReadyVersion(env: NodeJS.ProcessEnv, userHome: string, running: string): Promise<string | null> {
  const layout = resolveLayout(env, userHome);
  const newest = newestFirst((await readdir(layout.versions).catch(() => [])).filter(isVersion))[0];
  return newest && compareVersions(newest, running) > 0 ? newest : null;
}
