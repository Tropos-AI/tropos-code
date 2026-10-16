// src/exec/bwrap-args.ts — the bubblewrap arguments for a confined chat command on Linux, kept at macOS parity.
//
// Later mounts cover earlier ones: a fresh namespace with only inet networking, the whole system read-only, temp and
// the per-sandbox cache writable, secrets hidden, Tropos's default project and cache readable, the project writable,
// then the read-only protections inside it. Protected paths that don't yet exist are masked so they can't be created.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInside } from "../paths";
import { ConfinementError, type ConfinementPaths } from "./confinement-paths";

/** Host services a chat must not reach: the Docker daemon and D-Bus (the per-user runtime dir is masked separately). */
const SERVICE_MASKS: readonly string[] = ["/run/docker.sock", "/var/run/docker.sock", "/run/dbus", "/var/run/dbus"];

export function bwrapArgs(paths: ConfinementPaths, cwd: string): string[] {
  const { project } = paths;
  // Parity with the macOS profile needs real dirs; a symlinked or file `.git`/`.tropos` would let the protections be
  // sidestepped (a worktree gitfile points its hooks elsewhere), so refuse rather than confine something weaker.
  for (const name of [".git", ".tropos"]) requireRealDirOrAbsent(join(project, name));

  const args = ["--unshare-all", "--share-net", "--new-session", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  const uid = process.getuid?.() ?? 1000;
  args.push("--tmpfs", `/run/user/${uid}`);
  for (const sock of SERVICE_MASKS) args.push("--tmpfs", sock);

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

  // `.git` as a mount point can't be renamed (EBUSY): `mv .git g2; write g2/hooks/x; mv g2 .git` fails.
  const git = join(project, ".git");
  if (isRealDir(git)) args.push("--bind", git, git);
  for (const { path, kind } of protectedGitEntries(project)) args.push(...mask(path, kind));
  // The repo's settings hold its deny rules; read-only (a mount point), existing or not, so a shell can't write them.
  args.push(...mask(join(project, ".tropos"), "dir"));
  for (const f of ["settings.json", "settings.local.json"]) args.push(...mask(join(project, ".tropos", f), "file"));
  args.push("--chdir", cwd);
  return args;
}

type Kind = "file" | "dir";

/** Hide a secret: an empty read-only tmpfs over a dir, /dev/null over a file. */
function hide(p: string): string[] {
  return statSync(p).isDirectory() ? ["--tmpfs", p, "--remount-ro", p] : ["--ro-bind", "/dev/null", p];
}

/** Read-only mask for a protected path, whether or not it exists, so it can neither be changed nor created. */
function mask(path: string, kind: Kind): string[] {
  return kind === "dir" ? ["--tmpfs", path, "--remount-ro", path] : ["--ro-bind", "/dev/null", path];
}

/**
 * The git-internal paths that must stay read-only in the repo and in every nested git dir (submodules under
 * `modules/`, linked worktrees under `worktrees/`). `commondir` is included only when it already exists: an empty
 * placeholder breaks git ("failed to read commondir"), so its creation is caught by the backend's post-run check.
 */
function protectedGitEntries(project: string): { path: string; kind: Kind }[] {
  const out: { path: string; kind: Kind }[] = [];
  const git = join(project, ".git");
  if (!isRealDir(git)) return out;
  for (const dir of [git, ...nestedGitDirs(git, 0)]) {
    out.push({ path: join(dir, "hooks"), kind: "dir" });
    out.push({ path: join(dir, "config"), kind: "file" });
    out.push({ path: join(dir, "config.worktree"), kind: "file" });
    if (exists(join(dir, "commondir"))) out.push({ path: join(dir, "commondir"), kind: "file" });
  }
  const husky = join(project, ".husky");
  if (isRealDir(husky)) out.push({ path: husky, kind: "dir" });
  return out;
}

/** Git dirs under `.git/modules/**` and `.git/worktrees/*` (each has its own hooks and config). */
function nestedGitDirs(git: string, depth: number): string[] {
  if (depth > 4) return [];
  const found: string[] = [];
  for (const parent of [join(git, "modules"), join(git, "worktrees")]) {
    for (const entry of readDirs(parent)) {
      const sub = join(parent, entry);
      if (exists(join(sub, "HEAD"))) found.push(sub, ...nestedGitDirs(sub, depth + 1));
      else found.push(...nestedGitDirs(sub, depth + 1)); // a path segment of a submodule's name
    }
  }
  return found;
}

function readDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function requireRealDirOrAbsent(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return; // absent is fine: the mask creates it read-only
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ConfinementError(`${path} can't be confined: it must be a real directory, not a symlink or file.`);
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
