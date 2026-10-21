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

// The diff audit moved to src/harness/audit.ts, where the harness lab's probes use it too.
export { auditDiff, TEST_FILE, type DiffAudit } from "../../src/harness/audit";
