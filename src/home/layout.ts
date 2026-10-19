// src/home/layout.ts — the old home layout -> the C6 layout: the table, the one-release read fallback, and layout.json.
import { lstatSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { journalDir, learnedSkillsDir, userSkillsDir, workspaceFile } from "../paths";

export type LegacyItem = "SOUL.md" | "IDENTITY.md" | "USER.md" | "MEMORY.md" | "skills" | "skills-learned";

/** Where an item lived before the layout change. */
export function legacyPath(home: string, item: LegacyItem): string {
  return item === "USER.md" || item === "MEMORY.md" ? join(home, "memories", item) : join(home, item);
}

/** Where an item lives now. */
export function currentPath(home: string, item: LegacyItem): string {
  if (item === "skills") return userSkillsDir(home);
  if (item === "skills-learned") return learnedSkillsDir(home);
  return workspaceFile(home, item);
}

function exists(path: string): boolean {
  try {
    lstatSync(path); // a dangling or foreign link still counts as "there": never follow it
    return true;
  } catch {
    return false;
  }
}

/** The current path, unless only the legacy one exists (a home the migration hasn't reached yet). */
export function resolveLayoutPath(home: string, item: LegacyItem): string {
  const now = currentPath(home, item);
  if (exists(now)) return now;
  const old = legacyPath(home, item); // LEGACY_LAYOUT
  return exists(old) ? old : now;
}

const ROOT_FILES = new Set(["SOUL.md", "IDENTITY.md", "SOUL.imported.md"]);

/** A home-relative path in the old layout, as the same path in the new one; undefined for anything that didn't move. */
export function legacyToCurrent(rel: string): string | undefined {
  // LEGACY_LAYOUT
  if (ROOT_FILES.has(rel)) return `workspace/${rel}`;
  const memories = /^memories\/(USER\.md|MEMORY\.md|imported-[^/]+\.md)$/.exec(rel);
  if (memories) return `workspace/${memories[1]}`;
  if (/^skills(-learned)?\/.+/.test(rel)) return `workspace/${rel}`;
  return undefined;
}

/** What the chief owns inside the workspace; the workspace itself is a project and is not one of these. */
export function workspaceOwnPaths(home: string): string[] {
  return [
    ...(["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "BOOTSTRAP.md"] as const).map((name) => workspaceFile(home, name)),
    journalDir(home),
    userSkillsDir(home),
    learnedSkillsDir(home),
  ];
}

export const LAYOUT_VERSION = 2;

export interface LayoutState {
  version: number;
  migratedAt: string;
  backup?: string;
}

const layoutFile = (home: string): string => join(home, "layout.json");

/** `<home>/layout.json`; missing or unreadable reads as null. */
export async function readLayoutState(home: string): Promise<LayoutState | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(layoutFile(home), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const { version, migratedAt, backup } = raw as Record<string, unknown>;
    if (typeof version !== "number" || typeof migratedAt !== "string") return null;
    return typeof backup === "string" ? { version, migratedAt, backup } : { version, migratedAt };
  } catch {
    return null;
  }
}

export async function writeLayoutState(home: string, state: LayoutState): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const tmp = `${layoutFile(home)}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, layoutFile(home));
}
