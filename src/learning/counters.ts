// src/learning/counters.ts
// The learning loop's counters, kept per project so work a session never reviewed still counts in the next one.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "../memory/notes";
import { projectDir } from "../session/store";

export interface LearningCounters {
  turnsSinceMemory: number;
  toolsSinceSkill: number;
}

const ZERO: LearningCounters = { turnsSinceMemory: 0, toolsSinceSkill: 0 };
const count = z.number().int().nonnegative();
const schema = z.object({ turnsSinceMemory: count, toolsSinceSkill: count });

const countersPath = (home: string, cwd: string) => join(projectDir(home, cwd), "learning.json");

/** A missing or damaged file reads as zeros: the worst case is a review that comes a little later. */
export async function loadCounters(home: string, cwd: string): Promise<LearningCounters> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(countersPath(home, cwd), "utf8")));
    return parsed.success ? { turnsSinceMemory: parsed.data.turnsSinceMemory, toolsSinceSkill: parsed.data.toolsSinceSkill } : { ...ZERO };
  } catch {
    return { ...ZERO };
  }
}

export async function saveCounters(home: string, cwd: string, c: LearningCounters): Promise<void> {
  await mkdir(projectDir(home, cwd), { recursive: true, mode: 0o700 });
  await atomicWrite(countersPath(home, cwd), `${JSON.stringify({ turnsSinceMemory: c.turnsSinceMemory, toolsSinceSkill: c.toolsSinceSkill })}\n`);
}
