// src/tools/paths.ts
import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Raised whenever a path cannot be resolved faithfully. Callers must treat it as a refusal. */
export class PathResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathResolutionError";
  }
}

/** Symlink hops allowed per resolution (shared across nested link targets). */
const MAX_HOPS = 40;

interface Budget {
  hops: number;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PathResolutionError(`cannot inspect ${path}: ${(error as Error).message}`);
  }
}

function readLinkOrThrow(path: string): string {
  try {
    return readlinkSync(path);
  } catch (error) {
    throw new PathResolutionError(`cannot read symlink ${path}: ${(error as Error).message}`);
  }
}

function canonicalDir(path: string, what: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    throw new PathResolutionError(`cannot resolve ${what} ${path}: ${(error as Error).message}`);
  }
}

/**
 * Walks `parts` from `real` (always a canonical directory) the way the OS does: each
 * component is looked up on disk, symlinks are followed by walking their target, and
 * `..` climbs from the canonical parent. A missing component is kept as a plain path
 * segment and the walk continues, so a later `..` or link is still handled on disk.
 */
function walk(real: string, parts: string[], budget: Budget): string {
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      real = dirname(real);
      continue;
    }
    const candidate = join(real, part);
    const info = lstatOrNull(candidate);
    if (info === null) {
      real = candidate;
      continue;
    }
    if (info.isSymbolicLink()) {
      if (budget.hops === 0) {
        throw new PathResolutionError(`too many symlinks while resolving path (limit ${MAX_HOPS})`);
      }
      budget.hops--;
      const target = readLinkOrThrow(candidate);
      real = walk(isAbsolute(target) ? "/" : real, target.split("/"), budget);
      continue;
    }
    real = candidate;
  }
  return real;
}

/**
 * Resolves a model-supplied path to the location the OS would actually touch, as an
 * absolute canonical path. Symlinks are followed in order, so `link/../x` climbs from the
 * link's target, and dangling links resolve from their real parent. `~` and `~/...` start
 * from the canonical home (`home` is injectable for tests). Throws PathResolutionError
 * rather than returning an unresolved path.
 */
export function resolveToolPath(input: string, cwd: string, home: string = homedir()): string {
  const budget: Budget = { hops: MAX_HOPS };
  if (input === "~" || input.startsWith("~/")) {
    // Walk the raw remainder: joining it onto home first would collapse `..` before links.
    return walk(canonicalDir(home, "home directory"), input.slice(1).split("/"), budget);
  }
  if (isAbsolute(input)) {
    return walk("/", input.split("/"), budget);
  }
  return walk(canonicalDir(cwd, "working directory"), input.split("/"), budget);
}
