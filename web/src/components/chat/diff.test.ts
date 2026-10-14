import { describe, expect, test } from "bun:test";

import { countChanges, parsePatch } from "@/components/chat/diff";

describe("parsePatch", () => {
  test("drops the file header, numbers both sides and labels hunks", () => {
    const rows = parsePatch(["--- a.ts", "+++ a.ts", "@@ -10,2 +10,2 @@ function f()", " a", "-b", "+c", "@@ -40 +40,0 @@", "-gone"].join("\n"));
    expect(rows).toEqual([
      { kind: "hunk", key: "r0", text: "lines 10–11 · function f()" },
      { kind: "ctx", key: "r1", text: "a", oldNo: 10, newNo: 10 },
      { kind: "del", key: "r2", text: "b", oldNo: 11 },
      { kind: "add", key: "r3", text: "c", newNo: 11 },
      { kind: "hunk", key: "r4", text: "line 40" },
      { kind: "del", key: "r5", text: "gone", oldNo: 40 },
    ]);
    expect(countChanges(rows)).toEqual({ added: 1, removed: 2 });
  });

  test("content that looks like a header after the first hunk is kept", () => {
    const rows = parsePatch(["@@ -1 +1 @@", "--- not a header", "+++ also content"].join("\n"));
    expect(rows.slice(1).map((r) => [r.kind, r.text])).toEqual([
      ["del", "-- not a header"],
      ["add", "++ also content"],
    ]);
  });
});
