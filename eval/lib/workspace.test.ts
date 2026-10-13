// eval/lib/workspace.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { auditDiff, createWorkspace } from "./workspace";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("eval-ws-");
});
afterEach(() => removeDir(dir));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

test("createWorkspace copies one revision with no later history", async () => {
  const repo = join(dir, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "src", "a.ts"), "v1");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const first = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "src", "a.ts"), "v2 the secret fix");
  git(repo, "commit", "-qam", "the fix");

  const ws = join(dir, "ws");
  await createWorkspace(repo, first, ws);
  expect(readFileSync(join(ws, "src", "a.ts"), "utf8")).toBe("v1");
  expect(git(ws, "log", "--format=%s")).toBe("base");
  expect(git(ws, "status", "--porcelain")).toBe("");
  expect(existsSync(join(ws, ".git"))).toBe(true);
  expect(Bun.spawnSync(["git", "cat-file", "-e", git(repo, "rev-parse", "HEAD")], { cwd: ws }).exitCode).not.toBe(0);
});

test("createWorkspace reports an unknown revision", async () => {
  const repo = join(dir, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  await expect(createWorkspace(repo, "deadbeef", join(dir, "ws"))).rejects.toThrow("git archive deadbeef failed");
});

test("auditDiff counts changes and flags test edits and focus markers", () => {
  const numstat = ["10\t2\tsrc/a.ts", "1\t0\tsrc/a.test.ts", "0\t30\ttest/e2e/print.e2e.test.ts", "-\t-\tassets/logo.png", ""].join("\n");
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
  expect(audit).toMatchObject({ files: 4, insertions: 11, deletions: 32 });
  expect(audit.testFilesTouched).toEqual(["src/a.test.ts", "test/e2e/print.e2e.test.ts"]);
  expect(audit.focusMarkers).toEqual(['src/a.test.ts: test.skip("works", () => {', "src/a.ts: const only = 1; // test.only( in a comment of a source file still counts"]);
  expect(auditDiff("", "")).toEqual({ files: 0, insertions: 0, deletions: 0, testFilesTouched: [], focusMarkers: [] });
});
