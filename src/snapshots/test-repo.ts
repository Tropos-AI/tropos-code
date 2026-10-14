// src/snapshots/test-repo.ts
// Test helpers shared by the snapshot tests: real temporary git repositories.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../../test/helpers/tmp";

/** Runs the user's git in `cwd` with no inherited GIT_* variables; throws on failure. */
export function git(cwd: string, ...args: string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** A temp repo with one committed file (a.txt = "one\n") and a .gitignore for *.log. */
export async function makeRepo(): Promise<string> {
  const repo = await makeTmpDir("tropos-snap-repo-");
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return repo;
}
