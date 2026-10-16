// src/exec/git-integrity.ts — the post-run check for `.git/commondir`, a file that can't be pre-masked.
//
// `commondir` moves where git looks for hooks and config, so planting one redirects the owner's next host `git` to
// attacker-controlled hooks. An empty placeholder breaks git ("failed to read commondir"), so a confined command
// can't be stopped from creating it up front; instead its absence is recorded before the command and, if it appears
// afterwards, it is removed. Used by the Docker and host (sandbox/bwrap) backends alike.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export const COMMONDIR_TAMPERED = "a command tried to redirect git's hooks (.git/commondir); it was undone";

/** The `.git/commondir` paths that already exist, across the repo and its submodules and linked worktrees. */
export function commondirSnapshot(gitDirs: readonly string[]): Set<string> {
  return new Set(gitDirs.map((d) => join(d, "commondir")).filter((p) => existsSync(p)));
}

/**
 * Removes any `.git/commondir` that appeared since the snapshot. Returns the tamper message when it removed one (so
 * the caller can fail the command), or null when nothing changed.
 */
export function enforceCommondir(gitDirs: readonly string[], before: Set<string>): string | null {
  let tampered = false;
  for (const dir of gitDirs) {
    const path = join(dir, "commondir");
    if (!before.has(path) && existsSync(path)) {
      rmSync(path, { force: true });
      tampered = true;
    }
  }
  return tampered ? COMMONDIR_TAMPERED : null;
}
