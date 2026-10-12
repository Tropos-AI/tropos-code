// src/tools/diff.ts
import { createTwoFilesPatch } from "diff";
import type { DiffDisplay } from "./types";

/** Hunk lines of a unified patch: everything before the first "@@" is file header, dropped by position (not by prefix, so content like "-- sql" survives). */
export function patchBody(patch: string): string[] {
  const lines = patch.split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first === -1) return [];
  return lines.slice(first).filter((l) => l.length > 0 && !l.startsWith("\\ No newline"));
}

export function makeDiff(path: string, before: string, after: string): DiffDisplay {
  const patch = createTwoFilesPatch(path, path, before, after, "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  for (const line of patchBody(patch)) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { kind: "diff", path, patch, added, removed };
}
