// src/paths.ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative, isAbsolute, sep } from "node:path";

/**
 * Collision-free directory name for per-project data. The readable prefix is the
 * sanitized path; the 12-hex-char sha256 suffix keeps distinct paths apart even when
 * they sanitize to the same prefix (e.g. "/a/b-c" and "/a-b/c").
 */
export function projectKey(cwd: string): string {
  const readable = cwd.replace(/[^A-Za-z0-9._-]/g, "-");
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}

/** Root of Tropos user data: TROPOS_HOME, else ~/.tropos. */
export function troposHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TROPOS_HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".tropos");
}

export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** True when `path` equals `dir` or is nested below it. Both must be absolute. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * PATH without its relative entries. "node_modules/.bin" or "." on PATH resolves against the current
 * directory, which is a project a cloned repo controls.
 */
export function absolutePathEnv(path: string | undefined = process.env.PATH): string {
  return (path ?? "").split(delimiter).filter((dir) => dir !== "" && isAbsolute(dir)).join(delimiter);
}

/**
 * Finds a program for Tropos to run on its own (formatters, language servers): only through absolute
 * PATH entries, and never a file that really lives inside `root`, so a repo can't stand in its own
 * `prettier` or `gopls`.
 */
export function safeWhich(bin: string, root: string | undefined, path: string | undefined = process.env.PATH): string | null {
  let entries = absolutePathEnv(path).split(delimiter).filter(Boolean);
  let realRoot: string | undefined;
  if (root) {
    try {
      realRoot = realpathSync(root);
    } catch {
      realRoot = root;
    }
    const inRoot = realRoot;
    entries = entries.filter((dir) => !isInside(realOr(dir), inRoot));
  }
  const found = Bun.which(bin, { PATH: entries.join(delimiter) });
  // A PATH entry outside the repo can still hold a symlink into it.
  if (!found || !realRoot) return found;
  return isInside(realOr(found), realRoot) ? null : found;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// The Tropos home layout: the chief's own files live in one workspace folder, OpenClaw-style.

export type WorkspaceFileName = "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "MEMORY.md" | "BOOTSTRAP.md";

/** The default project and the chief's home: its own files sit here next to whatever the chat creates. */
export const workspaceDir = (home: string): string => join(home, "workspace");
export const workspaceFile = (home: string, name: WorkspaceFileName): string => join(workspaceDir(home), name);
/** The guests' own default project: a guest's chat or job never works in the chief's workspace unless it is shared. */
export const guestWorkspaceDir = (home: string): string => join(home, "guest-workspace");
/** The daily journal. */
export const journalDir = (home: string): string => join(workspaceDir(home), "memory");
export const userSkillsDir = (home: string): string => join(workspaceDir(home), "skills");
export const learnedSkillsDir = (home: string): string => join(workspaceDir(home), "skills-learned");
export const agentsDir = (home: string): string => join(home, "agents");
/** Where chats' git worktrees live: `<home>/worktrees/<project>/<task>`. */
export const worktreesDir = (home: string): string => join(home, "worktrees");
