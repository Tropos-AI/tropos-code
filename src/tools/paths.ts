// src/tools/paths.ts
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandHome } from "../paths";

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolves a model-supplied path against `cwd` and canonicalizes it: symlinks in the
 * nearest existing ancestor are followed (so files that don't exist yet are handled),
 * and dangling symlinks resolve to where they point.
 */
export function resolveToolPath(input: string, cwd: string, depth = 0): string {
  const absolute = resolve(cwd, expandHome(input));
  let existing = absolute;
  const tail: string[] = [];
  let info = lstatOrNull(existing);
  while (!info) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
    info = lstatOrNull(existing);
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    if (info?.isSymbolicLink() && depth < 10) {
      // Dangling link: resolve its target the same way.
      real = resolveToolPath(readlinkSync(existing), dirname(existing), depth + 1);
    } else {
      real = existing;
    }
  }
  return tail.length > 0 ? join(real, ...tail) : real;
}
