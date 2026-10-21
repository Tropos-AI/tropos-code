// src/harness/audit.ts — what a diff did to the tests: the anti-cheat check shared by the eval and the harness lab's
// probes. A run that "solved" its task by weakening tests is rejected whatever else it scored.

export interface DiffAudit {
  files: number;
  insertions: number;
  deletions: number;
  /** Test files the agent changed or deleted (the hidden copies overwrite some of them before verifying). */
  testFilesTouched: string[];
  /** Of those, the ones where lines that were already there were removed or changed: tests weakened, not just added. */
  testFilesEdited: string[];
  /** Added lines that skip or focus tests (`.skip(`, `.only(`, `.todo(`), as "path: line". */
  focusMarkers: string[];
}

export const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const FOCUS_MARKER = /\b(test|it|describe)\.(skip|only|todo)\s*\(|\bx(it|describe)\s*\(/;

/**
 * Summarises the agent's changes against the base commit, from `git diff --cached --no-renames
 * --numstat` and `git diff --cached --no-renames -U0` (renames show up as a delete plus an add).
 */
export function auditDiff(numstat: string, patch: string): DiffAudit {
  const audit: DiffAudit = { files: 0, insertions: 0, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] };
  for (const line of numstat.split("\n")) {
    const [added, removed, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    audit.files++;
    // Binary files show "-" for both counts.
    audit.insertions += Number(added) || 0;
    audit.deletions += Number(removed) || 0;
    if (TEST_FILE.test(path)) {
      audit.testFilesTouched.push(path);
      // A changed line counts as one removed and one added, so only adding tests leaves this at 0.
      if (Number(removed) > 0) audit.testFilesEdited.push(path);
    }
  }
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("+") && FOCUS_MARKER.test(line)) audit.focusMarkers.push(`${file}: ${line.slice(1).trim()}`);
  }
  return audit;
}

/** True when the diff weakened tests: removed or changed test lines, or added .skip/.only/.todo. */
export function weakenedTests(audit: DiffAudit): boolean {
  return audit.testFilesEdited.length > 0 || audit.focusMarkers.length > 0;
}
