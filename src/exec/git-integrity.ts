// src/exec/git-integrity.ts — the post-run check for `.git/commondir`, a file that can't be masked in advance.
//
// `commondir` moves where git looks for hooks and config. An empty placeholder breaks git ("failed to read
// commondir"), so a sandbox can't stop a command from creating one when none exists. Instead the absent ones are
// recorded before the command, and one that appears is removed afterwards and the command is failed.
//
// Removal never follows a link: a command may have replaced a parent (`.git/modules/x`) with a link to a host
// directory. Every component from the real `.git` down is lstat'ed, the parent must still resolve inside it, and only
// the single entry is unlinked. A planted directory, or anything that fails the check, is left alone and reported.
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isInside } from "../paths";

export const COMMONDIR_TAMPERED = "tropos sandbox: a command tried to redirect git's hooks (.git/commondir); it was undone";
export const COMMONDIR_MARKER = "tropos sandbox: a command tried to redirect git's hooks";
export const commondirUnsafe = (path: string): string =>
  `tropos sandbox: a command tried to redirect git's hooks (.git/commondir); it could not be undone safely; check ${path}`;

export interface CommondirSnapshot {
  /** The workspace's `.git` as configured, and its real path when the snapshot was taken. */
  gitRoot: string;
  realGitRoot: string;
  /** The repo's git dirs (itself, submodules, linked worktrees), all inside `gitRoot`. */
  gitDirs: string[];
  /** The `commondir` paths that existed before the command. */
  present: Set<string>;
}

export interface CommondirCheck {
  /** Paths that appeared during the command and were removed. */
  removed: string[];
  /** Paths that appeared but were left in place: a directory, or a location that failed the link check. */
  unsafe: string[];
  /** The message to fail the command with, or null when nothing changed. */
  message: string | null;
}

/** Whether something is at `path`, a dangling link included (lstat, not stat). */
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

/** Null when `.git` is missing or not a real directory: there is nothing to check then. */
export function commondirSnapshot(gitRoot: string, gitDirs: readonly string[]): CommondirSnapshot | null {
  try {
    const info = lstatSync(gitRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    return { gitRoot, realGitRoot: realpathSync(gitRoot), gitDirs: [...gitDirs], present: new Set(gitDirs.map((d) => join(d, "commondir")).filter(present)) };
  } catch {
    return null;
  }
}

/** The `commondir` paths that are absent now: the ones a command must not create. */
export function absentCommondirs(snap: CommondirSnapshot): string[] {
  return snap.gitDirs.map((d) => join(d, "commondir")).filter((p) => !snap.present.has(p));
}

/** The directories from `gitRoot` down to `dir`, inclusive; null when `dir` is not inside `gitRoot`. */
function chain(gitRoot: string, dir: string): string[] | null {
  const rel = relative(gitRoot, dir);
  if (rel === "..") return null;
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const out = [gitRoot];
  for (const part of rel.split(sep).filter(Boolean)) out.push(join(out.at(-1)!, part));
  return out;
}

/** Whether `path`'s parent chain is links-free real directories that still resolve inside the real `.git`. */
function parentsAreSafe(snap: CommondirSnapshot, path: string): boolean {
  const dirs = chain(snap.gitRoot, dirname(path));
  if (!dirs) return false;
  try {
    for (const dir of dirs) {
      const info = lstatSync(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    }
    return isInside(realpathSync(dirname(path)), snap.realGitRoot);
  } catch {
    return false;
  }
}

/** Removes each `commondir` that appeared since the snapshot, when that is safe; the caller fails the command on `message`. */
export function enforceCommondir(snap: CommondirSnapshot): CommondirCheck {
  const removed: string[] = [];
  const unsafe: string[] = [];
  for (const path of absentCommondirs(snap)) {
    let appeared: boolean;
    try {
      appeared = present(path);
    } catch {
      appeared = true; // can't even look: report it rather than assume it's fine
    }
    if (!appeared) continue;
    if (!parentsAreSafe(snap, path)) {
      unsafe.push(path);
      continue;
    }
    try {
      const info = lstatSync(path);
      if (info.isDirectory()) {
        unsafe.push(path); // never recurse: leave it and report
        continue;
      }
      unlinkSync(path); // a file or a link; a link is removed, not followed
      removed.push(path);
    } catch {
      unsafe.push(path);
    }
  }
  const message = unsafe.length > 0 ? unsafe.map(commondirUnsafe).join("\n") : removed.length > 0 ? COMMONDIR_TAMPERED : null;
  return { removed, unsafe, message };
}

/**
 * The same check as a POSIX shell snippet, for a wrapper that runs after the command on the host (Docker). It sets
 * `status=1` and prints the message when a `commondir` appeared; `quote` single-quotes a value for the shell.
 */
export function commondirGuardShell(snap: CommondirSnapshot, quote: (s: string) => string): string[] {
  const lines: string[] = [];
  for (const path of absentCommondirs(snap)) {
    const dirs = chain(snap.gitRoot, dirname(path));
    if (!dirs) continue;
    const p = quote(path);
    lines.push(
      `if [ -e ${p} ] || [ -L ${p} ]; then`,
      "  ok=1",
      `  for c in ${dirs.map(quote).join(" ")}; do if [ -L "$c" ] || [ ! -d "$c" ]; then ok=0; fi; done`,
      `  if [ "$ok" = 1 ]; then r=$(cd -P -- ${quote(dirname(path))} 2>/dev/null && pwd -P) || ok=0; case "$r/" in ${quote(`${snap.realGitRoot}/`)}*) ;; *) ok=0 ;; esac; fi`,
      `  if [ "$ok" = 1 ] && { [ -L ${p} ] || [ ! -d ${p} ]; } && rm -f -- ${p}; then echo ${quote(COMMONDIR_TAMPERED)} >&2; else echo ${quote(commondirUnsafe(path))} >&2; fi`,
      "  status=1",
      "fi",
    );
  }
  return lines;
}
