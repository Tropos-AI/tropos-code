// web/src/components/chat/diff.ts — a unified patch as numbered rows for DiffBlock. Pure, so it is unit-tested.
import { patchBody } from "@core/tools/diff";

export type DiffRow =
  | { kind: "hunk"; key: string; text: string }
  | { kind: "add" | "del" | "ctx"; key: string; text: string; oldNo?: number; newNo?: number };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/;

/** "lines 4–9" for a hunk's new side (or old side, for a pure removal). */
function hunkRange(start: number, count: number): string {
  if (count <= 1) return `line ${start}`;
  return `lines ${start}–${start + count - 1}`;
}

/** Hunk headers become separator rows; every other line gets its old and/or new line number. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  patchBody(patch).forEach((line, i) => {
    const key = `r${i}`;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const range = newCount > 0 ? hunkRange(Math.max(1, newNo), newCount) : hunkRange(oldNo, oldCount);
      rows.push({ kind: "hunk", key, text: hunk[5] ? `${range} · ${hunk[5]}` : range });
      return;
    }
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "+") rows.push({ kind: "add", key, text, newNo: newNo++ });
    else if (sign === "-") rows.push({ kind: "del", key, text, oldNo: oldNo++ });
    else rows.push({ kind: "ctx", key, text, oldNo: oldNo++, newNo: newNo++ });
  });
  return rows;
}

/** How many lines a patch adds and removes. */
export function countChanges(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added++;
    else if (row.kind === "del") removed++;
  }
  return { added, removed };
}
