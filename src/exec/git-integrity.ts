// src/exec/git-integrity.ts — the post-run check for `.git/commondir`, a file that can't be masked in advance.
//
// `commondir` moves where git looks for hooks and config. An empty placeholder breaks git ("failed to read
// commondir"), so a sandbox can't stop a command from creating one when none exists. Instead the absent ones are
// recorded before the command, and one that appears is removed afterwards and the command is failed.
//
// Removal never follows a link: a command may have replaced a parent (`.git/modules/x`) with a link to a host
// directory. Every component from the real `.git` down is lstat'ed, the parent must still resolve inside it, and only
// the single entry is unlinked. A planted directory, or anything that fails the check, is left alone and reported.
//
// The same goes for whole git dirs a command creates under `.git/modules` or `.git/worktrees` (bwrap can only make
// the ones that already exist read-only): after the command, each new one loses its hooks, config and commondir.
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isInside } from "../paths";

export const COMMONDIR_TAMPERED = "tropos sandbox: a command tried to redirect git's hooks (.git/commondir); it was undone";
export const commondirUnsafe = (path: string): string =>
  `tropos sandbox: a command tried to redirect git's hooks (.git/commondir); it could not be undone safely; check ${path}`;
export const GIT_METADATA_TAMPERED = "tropos sandbox: a command created git metadata with hooks/config; it was undone";
export const gitMetadataUnsafe = (path: string): string =>
  `tropos sandbox: a command created git metadata with hooks/config; it could not be undone safely; check ${path}`;

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
function parentsAreSafe(snap: Pick<CommondirSnapshot, "gitRoot" | "realGitRoot">, path: string): boolean {
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

/** How many directory levels below `.git` the nested-git-dir search goes; anything deeper is reported, not skipped. */
const MAX_NESTING = 10;

export interface NestedGitDirs {
  /** Directories with a HEAD under `modules/` (any path segments) and `worktrees/`, and under theirs in turn. */
  gitDirs: string[];
  /** Links met on the way; git would follow them, the search never does. */
  links: string[];
  /** Directories at the depth limit that were not searched. */
  deep: string[];
}

/**
 * The repo's nested git dirs (submodules, linked worktrees), found without following a link. Inside a git dir only its
 * own `modules/` and `worktrees/` are searched (not objects/ or refs/); any other directory is a path segment of a
 * submodule's name (`libs` in `libs/foo`) and is searched through.
 */
export function findNestedGitDirs(gitRoot: string): NestedGitDirs {
  const found: NestedGitDirs = { gitDirs: [], links: [], deep: [] };
  const searchGitDir = (dir: string, depth: number) => {
    for (const name of ["modules", "worktrees"]) search(join(dir, name), depth + 1);
  };
  const search = (dir: string, depth: number) => {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(dir);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) return void found.links.push(dir);
    if (!info.isDirectory()) return;
    if (depth > MAX_NESTING) return void found.deep.push(dir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const sub = join(dir, entry.name);
      if (entry.isSymbolicLink()) found.links.push(sub);
      else if (!entry.isDirectory()) continue;
      else if (presentOrUnknown(join(sub, "HEAD"))) {
        found.gitDirs.push(sub);
        searchGitDir(sub, depth + 1);
      } else search(sub, depth + 1);
    }
  };
  searchGitDir(gitRoot, 0);
  return found;
}

function presentOrUnknown(path: string): boolean {
  try {
    return present(path);
  } catch {
    return true;
  }
}

export interface GitDirsSnapshot {
  gitRoot: string;
  realGitRoot: string;
  /** The nested git dirs before the command. */
  gitDirs: string[];
  /** Everything the search met before the command: git dirs, links and unsearched deep dirs. */
  known: Set<string>;
}

/** Null when `.git` is missing or not a real directory: there is nothing to check then. */
export function gitDirsSnapshot(gitRoot: string): GitDirsSnapshot | null {
  try {
    const info = lstatSync(gitRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    const found = findNestedGitDirs(gitRoot);
    return { gitRoot, realGitRoot: realpathSync(gitRoot), gitDirs: found.gitDirs, known: new Set([...found.gitDirs, ...found.links, ...found.deep]) };
  } catch {
    return null;
  }
}

/** What git would run from a git dir: its hooks and config, and the commondir pointer that moves both. */
const GIT_DIR_CODE = ["hooks", "config", "config.worktree", "commondir"];

/**
 * After the command: a link planted on the way is removed (never followed); every git dir that is new loses its hooks
 * (file by file; a directory inside is left and reported), config and commondir. A deep dir, or anything that fails
 * the link check, is left alone and reported. The caller fails the command on `message`.
 */
export function enforceNewGitDirs(snap: GitDirsSnapshot): CommondirCheck {
  const removed: string[] = [];
  const unsafe: string[] = [];
  const unlinkIfSafe = (path: string) => {
    if (!parentsAreSafe(snap, path)) return void unsafe.push(path);
    try {
      unlinkSync(path);
      removed.push(path);
    } catch {
      unsafe.push(path);
    }
  };
  const found = findNestedGitDirs(snap.gitRoot);
  for (const link of found.links) if (!snap.known.has(link)) unlinkIfSafe(link);
  for (const deep of found.deep) if (!snap.known.has(deep)) unsafe.push(deep);
  for (const dir of found.gitDirs) {
    if (snap.known.has(dir)) continue;
    for (const name of GIT_DIR_CODE) {
      const path = join(dir, name);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(path);
      } catch {
        continue; // not there
      }
      if (!info.isDirectory()) {
        unlinkIfSafe(path);
        continue;
      }
      if (name !== "hooks" || !parentsAreSafe(snap, path)) {
        unsafe.push(path); // never recurse
        continue;
      }
      removeHooksDir(path, removed, unsafe);
    }
  }
  const message = unsafe.length > 0 ? unsafe.map(gitMetadataUnsafe).join("\n") : removed.length > 0 ? GIT_METADATA_TAMPERED : null;
  return { removed, unsafe, message };
}

/** Unlinks each file or link in a (parent-checked) hooks dir, then the dir; a directory inside is left and reported. */
function removeHooksDir(hooks: string, removed: string[], unsafe: string[]): void {
  try {
    let clean = true;
    for (const entry of readdirSync(hooks, { withFileTypes: true })) {
      const path = join(hooks, entry.name);
      if (entry.isDirectory()) {
        unsafe.push(path);
        clean = false;
      } else unlinkSync(path);
    }
    if (clean) {
      rmdirSync(hooks);
      removed.push(hooks);
    }
  } catch {
    unsafe.push(hooks);
  }
}
