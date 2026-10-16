// src/migrate/types.ts
import type { SourceId } from "./source";

export type Category = "identity" | "memory" | "skills" | "agents";
export const CATEGORIES: readonly Category[] = ["identity", "memory", "skills", "agents"];
export type SkillConflict = "overwrite" | "skip" | "rename";

export interface MigrateOptions {
  source: SourceId;
  /** Explicit source directory (--source). */
  sourceDir?: string;
  only?: Category[];
  skillConflict: SkillConflict;
  migrateSecrets: boolean;
  allowFlagged: boolean;
  /** Keep the executable bit on imported skill files (default: files are 0600, so nothing imported is runnable). */
  allowScripts?: boolean;
}

export interface MigrateDeps {
  /** Tropos data directory. */
  home: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
  now(): number;
  version?: string;
}

export type ItemAction = "create" | "append" | "alongside" | "rename" | "overwrite" | "overflow" | "skip";

/** One file (or note entry) that becomes text the agent reads: shown before the person confirms. */
export interface PlanFile {
  path: string;
  bytes: number;
  /** The first ~120 characters, whitespace collapsed. */
  preview: string;
  /** A script (exec bit, shebang or script extension): runnable only if the agent or a hook runs it. */
  script?: boolean;
}

export interface PlanItem {
  id: string;
  category: Category | "secrets";
  kind: string;
  /** Where it comes from, relative to the source. */
  source: string;
  /** Where it goes (absolute). */
  dest?: string;
  action: ItemAction;
  /** Why it is skipped, or what to know about it. */
  reason?: string;
  bytes?: number;
  /** What will be written, for the confirmation prompt and --dry-run. */
  files?: PlanFile[];
  /** The first file's preview. */
  preview?: string;
}

/** A unit of writing; run only for a real import. */
export interface Op {
  itemIds: string[];
  /** Record entries to save once run() succeeds. */
  keys: Record<string, { hash: string; dest?: string }>;
  run(): Promise<void>;
}

export interface Plan {
  source: SourceId;
  root: string;
  items: PlanItem[];
  /** Printed advice that changes nothing (model, channels). */
  suggestions: string[];
  notices: string[];
  warnings: string[];
  ops: Op[];
}

export interface ApplyResult {
  written: number;
  failed: { id: string; error: string }[];
  backup?: string;
}
