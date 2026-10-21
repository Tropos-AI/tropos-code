// eval/lib/workspace.ts
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Task } from "./task";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "eval",
  GIT_AUTHOR_EMAIL: "eval@localhost",
  GIT_COMMITTER_NAME: "eval",
  GIT_COMMITTER_EMAIL: "eval@localhost",
};

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode}): ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** The task's repository on this machine; "." is the repository the harness lives in. */
export function taskRepo(task: Task, harnessRoot: string): string {
  return task.repo === "." ? harnessRoot : isAbsolute(task.repo) ? task.repo : resolve(harnessRoot, task.repo);
}

/**
 * A fresh git repository holding the files of `revision` and a single commit. Later history is
 * not copied, so the agent cannot look up the real fix.
 */
export async function createWorkspace(repo: string, revision: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const archive = Bun.spawn(["git", "-C", repo, "archive", "--format=tar", revision], { stdout: "pipe", stderr: "pipe" });
  const untar = Bun.spawn(["tar", "-x", "-C", dest], { stdin: archive.stdout, stderr: "pipe" });
  const [archiveCode, untarCode] = await Promise.all([archive.exited, untar.exited]);
  if (archiveCode !== 0) throw new Error(`git archive ${revision} failed: ${(await new Response(archive.stderr).text()).trim()}`);
  if (untarCode !== 0) throw new Error(`extracting ${revision} failed: ${(await new Response(untar.stderr).text()).trim()}`);
  sh(["git", "init", "-q", "-b", "main"], { cwd: dest });
  sh(["git", "add", "-A"], { cwd: dest });
  sh(["git", "commit", "-q", "--no-gpg-sign", "-m", "base"], { cwd: dest, env: GIT_IDENTITY });
}

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
