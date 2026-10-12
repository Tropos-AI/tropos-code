// src/tools/diff.ts
import { createTwoFilesPatch } from "diff";
import type { DiffDisplay } from "./types";

export function makeDiff(path: string, before: string, after: string): DiffDisplay {
  const patch = createTwoFilesPatch(path, path, before, after, "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { kind: "diff", path, patch, added, removed };
}
