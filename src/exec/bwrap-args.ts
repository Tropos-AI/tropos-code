// src/exec/bwrap-args.ts — the bubblewrap arguments for a confined chat command on Linux, kept at macOS parity.
//
// Later mounts cover earlier ones: a fresh namespace with only inet networking, the whole system read-only, host
// services masked, temp writable, secrets hidden, the cache and the default project reopened, the project writable,
// then the read-only protections inside it. A protected path that exists is bound read-only onto itself (still
// readable, so the chat's own git works); one that doesn't is covered by an empty read-only placeholder so it can't
// be created. `commondir` is the exception (an empty one breaks git), and git dirs a command creates can't be bound
// in advance: the backend checks both after each command (git-integrity.ts).
//
// Residuals: `--share-net` keeps the host's network namespace, so abstract Unix sockets (no path to mask) stay
// reachable; and a project at `~` makes the host caches under it writable through the project bind.
import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInside } from "../paths";
import { ConfinementError, type ConfinementPaths } from "./confinement-paths";
import { findNestedGitDirs } from "./git-integrity";

/** Host services a chat must not reach: the per-user runtime dir (ssh/gpg agents, session bus), Docker, D-Bus. */
export function hostServicePaths(uid: number): string[] {
  return [`/run/user/${uid}`, "/run/docker.sock", "/var/run/docker.sock", "/run/dbus", "/var/run/dbus"];
}

/** Masks for the host services that exist: a directory gets an empty tmpfs, a socket or file /dev/null. */
export function hostServiceMasks(candidates: readonly string[]): string[] {
  const args: string[] = [];
  for (const path of candidates) {
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(path);
    } catch {
      continue; // absent: nothing to reach
    }
    args.push(...(info.isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]));
  }
  return args;
}

export function bwrapArgs(paths: ConfinementPaths, cwd: string): string[] {
  const { project } = paths;
  // Parity with the macOS profile needs real dirs: a linked or file `.git`/`.husky`/`.tropos` (a worktree gitfile, a
  // link a chat could swap) can't be made a read-only mount point, so refuse rather than confine something weaker.
  for (const name of [".git", ".husky", ".tropos"]) requireRealDirOrAbsent(join(project, name));

  const args = ["--unshare-all", "--share-net", "--new-session", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  args.push(...hostServiceMasks(hostServicePaths(process.getuid?.() ?? 1000)));

  for (const dir of paths.writable) if (exists(dir)) args.push("--bind", dir, dir);

  const secrets = paths.deniedReads.filter(exists);
  for (const secret of secrets) args.push(...hide(secret));
  // The cache lives inside the now-hidden ~/.tropos; rebind it writable, and the default project readable.
  if (exists(paths.cacheDir)) args.push("--bind", paths.cacheDir, paths.cacheDir);
  const carveOut = paths.readCarveOut;
  const carve = exists(carveOut) && carveOut !== project;
  if (carve) args.push("--ro-bind", carveOut, carveOut);

  args.push("--bind", project, project);
  // The project bind brings back what lies beneath it: secrets inside the project (a project at ~) are hidden again,
  // and a cache or workspace nested in a hidden secret is reopened.
  const reopened = secrets.filter((secret) => secret !== project && isInside(secret, project));
  for (const secret of reopened) args.push(...hide(secret));
  if (reopened.length > 0 && isInside(paths.cacheDir, project) && exists(paths.cacheDir)) args.push("--bind", paths.cacheDir, paths.cacheDir);
  if (carve && reopened.some((secret) => isInside(carveOut, secret))) args.push("--ro-bind", carveOut, carveOut);

  // The chief's own files, last among the binds that could bring them back (the project or the workspace carve-out).
  for (const own of paths.ownFiles.filter(isStatable)) args.push(...hide(own));

  // `.git` as a mount point can't be renamed (EBUSY): `mv .git g2; write g2/hooks/x; mv g2 .git` fails.
  for (const [i, git] of paths.gitDirs.entries()) {
    if (!isRealDir(git)) {
      // No `.git` at all: an empty read-only one, so `git init` (and planting hooks with it) fails as on macOS.
      if (i === 0 && !exists(git)) args.push(...protect(git, "dir"));
      continue;
    }
    args.push("--bind", git, git);
    for (const dir of [git, ...findNestedGitDirs(git).gitDirs]) {
      args.push(...protect(join(dir, "hooks"), "dir"), ...protect(join(dir, "config"), "file"), ...protect(join(dir, "config.worktree"), "file"));
      const commondir = join(dir, "commondir");
      if (exists(commondir)) args.push("--ro-bind", commondir, commondir);
    }
  }
  for (const husky of paths.husky) args.push(...protect(husky, "dir"));
  // The repo's settings hold its deny rules: the whole `.tropos` read-only, or an empty read-only one if missing.
  args.push(...protect(join(project, ".tropos"), "dir"));
  args.push("--chdir", cwd);
  return args;
}

type Kind = "file" | "dir";

/** Hide a secret: an empty read-only tmpfs over a dir, /dev/null over a file. */
function hide(path: string): string[] {
  return statSync(path).isDirectory() ? ["--tmpfs", path, "--remount-ro", path] : ["--ro-bind", "/dev/null", path];
}

/** Read-only: an existing path onto itself; a missing one as an empty placeholder (bwrap creates the mount point). */
function protect(path: string, kind: Kind): string[] {
  if (exists(path)) return ["--ro-bind", path, path];
  return kind === "dir" ? ["--tmpfs", path, "--remount-ro", path] : ["--ro-bind", "/dev/null", path];
}

function requireRealDirOrAbsent(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return; // absent is fine: a read-only placeholder covers it
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ConfinementError(`${path} can't be confined: it must be a real directory, not a symlink or file.`);
  }
}

/** Exists and resolves (a dangling link can't be hidden: there is nothing to mask). */
function isStatable(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
