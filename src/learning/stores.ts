// src/learning/stores.ts — Tropos's own stores: where the learning tools save under the Tropos home (contract C2).
import { join, relative } from "node:path";
import { IDENTITY_FILE, IDENTITY_STATE_FILE, SOUL_FILE } from "../context/identity";
import { LEARNED_SKILLS_DIR } from "../extensions/sources";
import { isInside } from "../paths";
import { resolveToolPath } from "../tools/paths";

/** The tools that save to the stores; the owner's saves there run without asking (src/permissions/engine.ts). */
export const STORE_TOOLS = ["Memory", "DailyNote", "SkillManage", "AgentManage", "Identity"] as const;

const STORE_ENTRIES = ["memories", "skills", LEARNED_SKILLS_DIR, "agents", IDENTITY_FILE, SOUL_FILE, IDENTITY_STATE_FILE];

/**
 * The canonical path of `path`, a store under `home`, or undefined when it isn't where it claims to be: a store that
 * is (or sits under) a symlink could send saves into the project or /etc, so it never counts as a store, wherever it
 * points. Only the home itself may be reached through a link.
 */
export function canonicalStorePath(home: string, path: string): string | undefined {
  const rel = relative(home, path);
  if (rel === "" || !isInside(path, home)) return undefined;
  try {
    const real = resolveToolPath(path, "/");
    return real === join(resolveToolPath(home, "/"), rel) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The stores Memory, DailyNote, SkillManage, AgentManage and Identity write to, as canonical paths. P5 and P6 add to it. */
export function troposStorePaths(home: string): string[] {
  return STORE_ENTRIES.flatMap((name) => canonicalStorePath(home, join(home, name)) ?? []);
}
