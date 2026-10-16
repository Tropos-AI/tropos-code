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
import { lstatSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isInside } from "../paths";

export const COMMONDIR_TAMPERED = "tropos sandbox: a command tried to redirect git's hooks (.git/commondir); it was undone";
export const commondirUnsafe = (path: string): string =>
  `tropos sandbox: a command tried to redirect git's hooks (.git/commondir); it could not be undone safely; check ${path}`;
export const GIT_METADATA_TAMPERED = "tropos sandbox: a command created git metadata with hooks/config; it was undone";
export const GIT_LINK_REMOVED = "tropos sandbox: a link in .git pointed into a folder chat commands can write; it was removed";
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

/**
 * How many directories the nested-git-dir search may visit. There is no depth limit (a git dir at any depth is
 * found); past this count the search stops and the check fails closed, on every command until the tree shrinks.
 */
export const MAX_GIT_DIR_VISITS = 10_000;

export interface NestedGitDirs {
  /** Directories with a HEAD under `modules/` (any path segments) and `worktrees/`, and under theirs in turn. */
  gitDirs: string[];
  /** Links met on the way; git would follow them, the search never does. */
  links: string[];
  /** Directories the search could not read, so could not check. */
  unreadable: string[];
  /** The search stopped at its visit limit: what it found is incomplete. */
  overflow: boolean;
}

/**
 * The repo's nested git dirs (submodules, linked worktrees), found without following a link. Inside a git dir only its
 * own `modules/` and `worktrees/` are searched (not objects/ or refs/); any other directory is a path segment of a
 * submodule's name (`libs` in `libs/foo`) and is searched through.
 */
export function findNestedGitDirs(gitRoot: string, maxVisits = MAX_GIT_DIR_VISITS): NestedGitDirs {
  const found: NestedGitDirs = { gitDirs: [], links: [], unreadable: [], overflow: false };
  const pending = [join(gitRoot, "worktrees"), join(gitRoot, "modules")];
  let visits = 0;
  while (pending.length > 0) {
    if (++visits > maxVisits) {
      found.overflow = true;
      break;
    }
    const dir = pending.pop()!;
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") found.unreadable.push(dir);
      continue;
    }
    if (info.isSymbolicLink()) {
      found.links.push(dir);
      continue;
    }
    if (!info.isDirectory()) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      found.unreadable.push(dir);
      continue;
    }
    for (const entry of entries) {
      const sub = join(dir, entry.name);
      if (entry.isSymbolicLink()) found.links.push(sub);
      else if (!entry.isDirectory()) continue;
      else {
        const head = hasHead(sub);
        if (head === null) found.unreadable.push(sub); // can't tell whether it is a git dir
        else if (head) {
          found.gitDirs.push(sub);
          pending.push(join(sub, "worktrees"), join(sub, "modules"));
        } else pending.push(sub);
      }
    }
  }
  return found;
}

/** Whether `dir` has a HEAD entry; null when that can't be told (an unreadable dir). */
function hasHead(dir: string): boolean | null {
  try {
    return present(join(dir, "HEAD"));
  } catch {
    return null;
  }
}

export interface GitDirsSnapshot {
  gitRoot: string;
  realGitRoot: string;
  /** The nested git dirs before the command. */
  gitDirs: string[];
  /** What the search met before the command: git dirs, links and unreadable dirs. Never an overflow. */
  known: Set<string>;
  /** Real paths a confined command can write; a link in .git into one of them is never trusted. */
  writable: string[];
  maxVisits: number;
}

/** Null when `.git` is missing or not a real directory: there is nothing to check then. */
export function gitDirsSnapshot(gitRoot: string, opts: { writable?: string[]; maxVisits?: number } = {}): GitDirsSnapshot | null {
  const maxVisits = opts.maxVisits ?? MAX_GIT_DIR_VISITS;
  try {
    const info = lstatSync(gitRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    const found = findNestedGitDirs(gitRoot, maxVisits);
    const known = new Set([...found.gitDirs, ...found.links, ...found.unreadable]);
    return { gitRoot, realGitRoot: realpathSync(gitRoot), gitDirs: found.gitDirs, known, writable: opts.writable ?? [], maxVisits };
  } catch {
    return null;
  }
}

/** What git would run from a git dir: its hooks and config, and the commondir pointer that moves both. */
const GIT_DIR_CODE = ["hooks", "config", "config.worktree", "commondir"];

/**
 * After the command: a link planted on the way is removed (never followed); every git dir that is new loses its hooks
 * (file by file; a directory inside is left and reported), config and commondir. Then, whatever the snapshot says, a
 * link that points into a sandbox-writable path is removed: in `modules/` and `worktrees/`, and as (or in) any git
 * dir's hooks, or as its config or commondir (a background job may have planted it after the snapshot was taken, and
 * an owner's link there would run whatever a chat writes). Anything that fails the link check is left alone and
 * reported, and so is a search that overflowed or met a new dir it can't read. The caller fails the command on `message`.
 */
export function enforceNewGitDirs(snap: GitDirsSnapshot): CommondirCheck {
  const removed: string[] = [];
  const removedLinks: string[] = [];
  const unsafe: string[] = [];
  const unlinkIfSafe = (path: string, into = removed) => {
    if (!parentsAreSafe(snap, path)) return void unsafe.push(path);
    try {
      unlinkSync(path);
      into.push(path);
    } catch {
      unsafe.push(path);
    }
  };
  const found = findNestedGitDirs(snap.gitRoot, snap.maxVisits);
  // Fail closed: a search that couldn't finish, or a new dir it couldn't read, may hide a git dir.
  if (found.overflow) unsafe.push(snap.gitRoot);
  for (const dir of found.unreadable) if (!snap.known.has(dir)) unsafe.push(dir);
  for (const link of found.links) if (!snap.known.has(link)) unlinkIfSafe(link);
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
  if (snap.writable.length > 0) {
    const candidates = [...found.links, ...[snap.gitRoot, ...found.gitDirs].flatMap(gitDirCodePaths)];
    for (const path of new Set(candidates)) if (pointsInto(path, snap.writable)) unlinkIfSafe(path, removedLinks);
  }
  const lines = unsafe.length > 0 ? unsafe.map(gitMetadataUnsafe) : [...(removed.length > 0 ? [GIT_METADATA_TAMPERED] : []), ...(removedLinks.length > 0 ? [GIT_LINK_REMOVED] : [])];
  return { removed: [...removed, ...removedLinks], unsafe, message: lines.length > 0 ? lines.join("\n") : null };
}

/** A git dir's code paths, and the entries of its hooks dir when that is a real directory. */
function gitDirCodePaths(dir: string): string[] {
  const out = GIT_DIR_CODE.map((name) => join(dir, name));
  try {
    const hooks = join(dir, "hooks");
    if (lstatSync(hooks).isDirectory()) out.push(...readdirSync(hooks).map((name) => join(hooks, name)));
  } catch {
    // no hooks dir
  }
  return out;
}

/** Whether `path` is a link whose target (resolved, or by its text when dangling) lies in one of `dirs`. */
function pointsInto(path: string, dirs: readonly string[]): boolean {
  let text: string;
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    text = readlinkSync(path);
  } catch {
    return false;
  }
  const targets = [resolve(realOr(dirname(path)), text)];
  try {
    targets.push(realpathSync(path));
  } catch {
    // dangling: its text is all there is
  }
  return targets.some((target) => dirs.some((dir) => isInside(target, dir)));
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
