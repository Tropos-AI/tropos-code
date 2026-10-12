import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";

export interface WalkOptions {
  /** True for paths a deny rule covers; such files are never yielded (nor read by callers). */
  isDenied?: (absPath: string) => boolean;
}

/** Splits a pattern into its path segments and brace/comma alternatives. */
function tokens(pattern: string): string[] {
  return pattern.split(/[\/{},\s]/);
}

/** True when the pattern names the directory `name` as a whole path segment (not a substring). */
export function namesDir(pattern: string, name: string): boolean {
  return tokens(pattern).includes(name);
}

/**
 * Rejects patterns that could reach outside the search directory: absolute paths, `~`,
 * and any `..` segment (including inside brace alternatives). Returns an error message,
 * or null when the pattern is contained.
 */
export function assertContainedPattern(pattern: string): string | null {
  if (/(^|[{,])[\/~]/.test(pattern)) {
    return `Pattern must be relative to the search directory and may not start with "/" or "~": ${pattern}`;
  }
  if (tokens(pattern).includes("..")) {
    return `Pattern may not contain ".." segments: ${pattern}`;
  }
  return null;
}

function isWithin(child: string, parent: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(prefix);
}

/**
 * Relative file paths under `base` matching `pattern`. node_modules and .git are skipped
 * unless the pattern names them as path segments. Only files whose canonical location is
 * inside the canonical `base` are yielded, so symlinks that point outside are never
 * returned or opened by callers. Files covered by `isDenied` (lexical or canonical path)
 * are dropped before the caller can read them.
 */
export async function* walkFiles(base: string, pattern: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const skipped: string[] = [];
  if (!namesDir(pattern, "node_modules")) skipped.push("node_modules");
  if (!namesDir(pattern, ".git")) skipped.push(".git");
  const realBase = await realpath(base);
  const glob = new Bun.Glob(pattern);
  for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: true, followSymlinks: false })) {
    const dirs = rel.split("/").slice(0, -1);
    if (dirs.some((segment) => skipped.includes(segment))) continue;
    const lexical = join(base, rel);
    const canonical = await realpath(lexical).catch(() => null);
    if (canonical === null || !isWithin(canonical, realBase)) continue;
    if (opts.isDenied?.(lexical) || opts.isDenied?.(canonical)) continue;
    yield rel;
  }
}
