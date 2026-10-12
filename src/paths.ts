// src/paths.ts
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";

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
