// src/exec/bwrap-args.ts — the bubblewrap arguments for a confined chat command on Linux.
//
// Later mounts cover earlier ones: the whole system read-only, temp and caches writable, secrets hidden, Tropos's
// default project readable again, the project writable, then the read-only protections inside it.
import { existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInside } from "../paths";
import { ConfinementError, type ConfinementPaths } from "./confinement-paths";
import { protectedPaths } from "./docker";

export function bwrapArgs(paths: ConfinementPaths, cwd: string): string[] {
  const { project } = paths;
  let protectedInProject: string[];
  try {
    protectedInProject = protectedPaths(project);
  } catch (err) {
    throw new ConfinementError((err as Error).message);
  }
  const args = ["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const dir of paths.writable) if (existsSync(dir)) args.push("--bind", dir, dir);

  const secrets = paths.deniedReads.filter((p) => existsSync(p));
  const hide = (p: string) => (statSync(p).isDirectory() ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p]);
  for (const secret of secrets) args.push(...hide(secret));
  const carveOut = paths.readCarveOut;
  const carve = existsSync(carveOut) && carveOut !== project;
  if (carve) args.push("--ro-bind", carveOut, carveOut);

  args.push("--bind", project, project);
  // The project bind brings back what lies beneath it, so secrets inside the project (a project at ~) are hidden
  // again, and the workspace inside a hidden secret is made readable again.
  const reopened = secrets.filter((secret) => secret !== project && isInside(secret, project));
  for (const secret of reopened) args.push(...hide(secret));
  if (carve && reopened.some((secret) => isInside(carveOut, secret))) args.push("--ro-bind", carveOut, carveOut);

  // A mount point can't be renamed (EBUSY): `mv .git g2; write g2/hooks/x; mv g2 .git` fails.
  const git = join(project, ".git");
  if (isRealDir(git)) args.push("--bind", git, git);
  for (const p of protectedInProject) args.push("--ro-bind", p, p);
  // The repo's settings hold its deny rules; read-only and a mount point, so a shell can't strip or move them.
  const settings = join(project, ".tropos");
  if (isRealDir(settings)) args.push("--ro-bind", settings, settings);
  args.push("--chdir", cwd);
  return args;
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
