// src/learning/skill-usage.ts
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveLayoutPath } from "../home/layout";
import { atomicWrite } from "../memory/notes";

export interface SkillUse {
  uses: number;
  lastUsed: string;
}

export type SkillUsage = Record<string, SkillUse>;

/** Dot-named, so the skill loader skips it. */
export function usagePath(home: string): string {
  return join(resolveLayoutPath(home, "skills"), ".usage.json"); // LEGACY_LAYOUT via resolveLayoutPath
}

function isUse(value: unknown): value is SkillUse {
  const v = value as Partial<SkillUse> | null;
  return typeof v === "object" && v !== null && typeof v.uses === "number" && Number.isFinite(v.uses) && typeof v.lastUsed === "string";
}

/**
 * How often and how recently each skill was loaded, for the curator. A missing or corrupt file reads
 * as no usage: the counts are a hint, never worth failing over.
 */
export async function readSkillUsage(home: string): Promise<SkillUsage> {
  // A null prototype keeps a skill named "__proto__" an ordinary key.
  const usage: SkillUsage = Object.create(null) as SkillUsage;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(usagePath(home), "utf8"));
  } catch {
    return usage;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return usage;
  for (const [name, use] of Object.entries(parsed)) {
    if (isUse(use)) usage[name] = { uses: use.uses, lastUsed: use.lastUsed };
  }
  return usage;
}

/** Serialises read-modify-writes within this process so parallel loads don't lose counts. */
let queue: Promise<unknown> = Promise.resolve();

export function recordSkillUse(home: string, name: string, now: Date = new Date()): Promise<void> {
  const run = queue.then(async () => {
    const usage = await readSkillUsage(home);
    usage[name] = { uses: (usage[name]?.uses ?? 0) + 1, lastUsed: now.toISOString() };
    const path = usagePath(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, `${JSON.stringify(usage, null, 2)}\n`);
  });
  queue = run.catch(() => {});
  return run;
}
