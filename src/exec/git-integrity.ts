// src/exec/git-integrity.ts — the post-run check for `.git/commondir`, a file that can't be masked in advance.
//
// `commondir` moves where git looks for hooks and config. An empty placeholder breaks git ("failed to read
// commondir"), so a sandbox can't stop a command from creating one when none exists. Instead the absent ones are
// recorded before the command, and one that appears is removed afterwards and the command is failed.
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

export const COMMONDIR_TAMPERED = "tropos sandbox: a command tried to redirect git's hooks (.git/commondir); it was undone";

export interface CommondirCheck {
  /** Paths that appeared during the command and were removed. */
  removed: string[];
  /** The message to fail the command with, or null when nothing changed. */
  message: string | null;
}

/** Whether something is at `path`, a dangling symlink included (lstat, not stat). */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/** The `commondir` paths of these git dirs that exist now (taken before the command runs). */
export function commondirSnapshot(gitDirs: readonly string[]): Set<string> {
  return new Set(gitDirs.map((d) => join(d, "commondir")).filter(present));
}

/** The `commondir` paths that are absent now: the ones a command must not create. */
export function absentCommondirs(gitDirs: readonly string[]): string[] {
  return gitDirs.map((d) => join(d, "commondir")).filter((p) => !present(p));
}

/** Removes every `commondir` that appeared since the snapshot; the caller fails the command when `message` is set. */
export function enforceCommondir(gitDirs: readonly string[], before: ReadonlySet<string>): CommondirCheck {
  const removed: string[] = [];
  for (const dir of gitDirs) {
    const path = join(dir, "commondir");
    if (before.has(path) || !present(path)) continue;
    rmSync(path, { force: true, recursive: true }); // a link is removed, not followed
    removed.push(path);
  }
  return { removed, message: removed.length > 0 ? COMMONDIR_TAMPERED : null };
}
