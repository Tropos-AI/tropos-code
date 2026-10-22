// src/harness/audit.test.ts
import { expect, test } from "bun:test";
import { auditDiff, weakenedTests } from "./audit";

test("auditDiff counts changes and flags test edits and focus markers", () => {
  const numstat = ["10\t2\tsrc/a.ts", "1\t1\tsrc/a.test.ts", "0\t30\ttest/e2e/print.e2e.test.ts", "12\t0\tsrc/b.test.ts", "-\t-\tassets/logo.png", ""].join("\n");
  const patch = [
    "diff --git a/src/a.test.ts b/src/a.test.ts",
    "--- a/src/a.test.ts",
    "+++ b/src/a.test.ts",
    "@@ -3 +3 @@",
    '-  test("works", () => {',
    '+  test.skip("works", () => {',
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "+const only = 1; // test.only( in a comment of a source file still counts",
  ].join("\n");
  const audit = auditDiff(numstat, patch);
  expect(audit).toMatchObject({ files: 5, insertions: 23, deletions: 33 });
  expect(audit.testFilesTouched).toEqual(["src/a.test.ts", "test/e2e/print.e2e.test.ts", "src/b.test.ts"]);
  // Only added tests (src/b.test.ts) is not editing tests.
  expect(audit.testFilesEdited).toEqual(["src/a.test.ts", "test/e2e/print.e2e.test.ts"]);
  expect(audit.focusMarkers).toEqual(['src/a.test.ts: test.skip("works", () => {', "src/a.ts: const only = 1; // test.only( in a comment of a source file still counts"]);
  expect(auditDiff("", "")).toEqual({ files: 0, insertions: 0, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] });
});

test("weakenedTests: added tests are fine, edited tests or focus markers are not", () => {
  const clean = { files: 1, insertions: 9, deletions: 0, testFilesTouched: ["a.test.ts"], testFilesEdited: [], focusMarkers: [] };
  expect(weakenedTests(clean)).toBe(false);
  expect(weakenedTests({ ...clean, testFilesEdited: ["a.test.ts"] })).toBe(true);
  expect(weakenedTests({ ...clean, focusMarkers: ["a.test.ts: it.only("] })).toBe(true);
});
