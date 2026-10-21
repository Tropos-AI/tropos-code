// eval/lib/workspace.ts
import { isAbsolute, resolve } from "node:path";
import type { Task } from "./task";

/** The task's repository on this machine; "." is the repository the harness lives in. */
export function taskRepo(task: Task, harnessRoot: string): string {
  return task.repo === "." ? harnessRoot : isAbsolute(task.repo) ? task.repo : resolve(harnessRoot, task.repo);
}

// Creating the workspace and auditing its diff moved to src/harness, where the harness lab's probes use them too.
export { createWorkspace } from "../../src/harness/workspace";
export { auditDiff, TEST_FILE, type DiffAudit } from "../../src/harness/audit";
