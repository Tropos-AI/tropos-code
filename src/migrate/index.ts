// src/migrate/index.ts — library entry: plan, execute, and describe importable sources.
import { mkdir, stat } from "node:fs/promises";
import { createBackup } from "../backup";
import { readRecord, writeRecord, type MigrationRecord } from "./record";
import { SOURCE_IDS, locateSource, readSource, type SourceId } from "./source";
import { splitEntries, MigrateError, planMigration } from "./plan";
import type { ApplyResult, MigrateDeps, Plan } from "./types";

export { MigrateError, planMigration, splitEntries };
export { CATEGORIES } from "./types";
export type { ApplyResult, Category, MigrateDeps, MigrateOptions, Plan, PlanFile, PlanItem, SkillConflict } from "./types";
export { SOURCE_IDS, type SourceId } from "./source";

/** True when running the plan would write something. */
export const hasWrites = (plan: Plan): boolean => plan.ops.length > 0;

/**
 * Runs the plan: a safety backup first (unless disabled), then each write; one failure does not stop
 * the others. What succeeded is recorded so a re-run skips it.
 */
export async function executePlan(plan: Plan, deps: MigrateDeps, opts: { backup: boolean; onProgress?: (m: string) => void } = { backup: true }): Promise<ApplyResult> {
  const result: ApplyResult = { written: 0, failed: [] };
  if (!hasWrites(plan)) return result;
  if (opts.backup && (await stat(deps.home).then((s) => s.isDirectory(), () => false))) {
    const b = await createBackup({ home: deps.home, now: deps.now, sessions: false, troposVersion: deps.version, onProgress: (e) => e.phase === "warn" && opts.onProgress?.(`backup: ${e.message}`) }).catch((err) => {
      throw new MigrateError(`The safety backup failed (${(err as Error).message}); nothing was imported. Fix that or use --no-backup.`);
    });
    result.backup = b.archive;
  }
  await mkdir(deps.home, { recursive: true, mode: 0o700 });
  const rec: MigrationRecord = (await readRecord(deps.home, plan.source)) ?? { version: 1, source: plan.source, root: plan.root, updatedAt: "", items: {} };
  const at = new Date(deps.now()).toISOString();
  for (const op of plan.ops) {
    try {
      await op.run();
      result.written += op.itemIds.length;
      for (const [k, v] of Object.entries(op.keys)) rec.items[k] = { ...v, at };
    } catch (err) {
      for (const id of op.itemIds) result.failed.push({ id, error: (err as Error).message });
    }
  }
  rec.root = plan.root;
  rec.updatedAt = at;
  if (Object.keys(rec.items).length) await writeRecord(deps.home, rec);
  return result;
}

export interface SourceSummary {
  source: SourceId;
  root: string;
  soul: boolean;
  identity: boolean;
  agents: boolean;
  memoryEntries: number;
  dailyNotes: number;
  skills: number;
  providerKeys: number;
}

/** What each tool leaves behind that could be imported (read-only). */
export async function detectSources(deps: Pick<MigrateDeps, "env" | "userHome">): Promise<SourceSummary[]> {
  const out: SourceSummary[] = [];
  for (const source of SOURCE_IDS) {
    const root = await locateSource(source, deps.env, deps.userHome);
    if (!root) continue;
    const b = await readSource(source, root, deps.userHome);
    out.push({
      source,
      root,
      soul: Boolean(b.soul),
      identity: Boolean(b.identity),
      agents: Boolean(b.agents),
      memoryEntries: b.memory.reduce((n, d) => n + splitEntries(d.file.text).length, 0),
      dailyNotes: b.daily.length,
      skills: b.skills.filter((s) => !s.skipReason).length,
      providerKeys: Object.keys(b.env).filter((k) => /KEY$/.test(k)).length,
    });
  }
  return out;
}

/** The plan as plain data (no functions), for --json. */
export const publicPlan = (p: Plan) => ({ source: p.source, root: p.root, items: p.items, suggestions: p.suggestions, notices: p.notices, warnings: p.warnings });
