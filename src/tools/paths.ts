// src/tools/paths.ts
import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { expandHome } from "../paths";

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

/**
 * Walks `parts` from `real` (always a canonical directory) the way the OS does: each
 * component is looked up on disk, symlinks are followed by walking their target, and
 * `..` climbs from the canonical parent. Once a component does not exist, nothing below
 * it can be a link, so the rest of the path is appended lexically.
 */
function walk(real: string, parts: string[], budget: Budget): string {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      real = dirname(real);
      continue;
    }
    const candidate = join(real, part);
    const info = lstatOrNull(candidate);
    if (info === null) {
      return appendLexical(candidate, parts.slice(i + 1));
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

function appendLexical(base: string, rest: string[]): string {
  let out = base;
  for (const part of rest) {
    if (part === "" || part === ".") continue;
    out = part === ".." ? dirname(out) : join(out, part);
  }
  return out;
}

/**
 * Resolves a model-supplied path to the location the OS would actually touch, as an
 * absolute canonical path. Symlinks are followed in order, so `link/../x` climbs from the
 * link's target, and dangling links resolve from their real parent. Throws
 * PathResolutionError rather than returning an unresolved path.
 */
export function resolveToolPath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  const budget: Budget = { hops: MAX_HOPS };
  let start: string;
  if (isAbsolute(expanded)) {
    start = "/";
  } else {
    try {
      start = realpathSync.native(cwd);
    } catch (error) {
      throw new PathResolutionError(`cannot resolve working directory ${cwd}: ${(error as Error).message}`);
    }
  }
  return walk(start, expanded.split("/"), budget);
}
