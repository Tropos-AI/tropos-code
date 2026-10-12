// src/paths.ts
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";

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
