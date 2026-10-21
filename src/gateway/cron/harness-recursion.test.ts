// src/gateway/cron/harness-recursion.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { labDir, type LabRun } from "../../harness/lab";
import type { ProbeResult } from "../../harness/probe";
import { deliverable, handOver } from "./harness-recursion";
import type { CronJob } from "./types";

let dir: string;
let home: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }).stdout.toString().trim();
beforeEach(async () => {
  dir = await makeTmpDir("recursion-");
  home = join(dir, "home");
  repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "a.txt"), "one\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
});
afterEach(() => removeDir(dir));

const probe = (label: string, passed: number, over: Partial<ProbeResult> = {}): ProbeResult => ({
  id: `r1-${label}`, label, harness: [], finalText: `answer from ${label}`, seconds: 1, error: null,
  checks: Array.from({ length: 2 }, (_, i) => ({ command: `c${i}`, ok: i < passed, exit: i < passed ? 0 : 1, timedOut: false, tail: "", seconds: 1 })),
  audit: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] },
  signals: { turns: 5, toolCalls: 5, toolErrors: 0, filesWritten: 1, verifiedAfterLastEdit: true, rereadWritten: 0, endReason: "end_turn", costUsd: 0 },
  ...over,
});

const labRun = (probes: ProbeResult[], over: Partial<LabRun> = {}): LabRun => ({
  id: "20261021-100000-aaaa",
  task: { id: "prompt", title: "Fix a", prompt: "Fix a", repo, revision: "x", domain: "general", checks: [], split: "dev" },
  scope: "global", k: 1, mode: "parallel", model: "m", editorModel: "m", startedAt: "",
  probes, proposals: [], compositions: [], verdict: { outcome: "better", reasons: ["checks passed 1 → 2"] }, candidate: "20261021-100000-aaaa", costUsd: 1,
  ...over,
});

const job = { id: "j1", name: "Nightly fix", project: "app", prompt: "Fix a", harnessRecursion: 1 } as CronJob;

test("the deliverable is the selector's pick, unless a valid run passes more checks; cheats and failures never", () => {
  const ref = probe("ref", 2);
  const comp = probe("comp-1", 1);
  expect(deliverable(labRun([ref, comp], { selected: { id: "r1-comp-1", reason: "" } }))?.label).toBe("ref");
  expect(deliverable(labRun([probe("ref", 1), probe("comp-1", 2)], { selected: { id: "r1-comp-1", reason: "" } }))?.label).toBe("comp-1");
  const cheat = probe("comp-1", 2, { audit: { files: 1, insertions: 0, deletions: 3, testFilesTouched: ["a.test.ts"], testFilesEdited: ["a.test.ts"], focusMarkers: [] } });
  expect(deliverable(labRun([probe("ref", 0), cheat]))?.label).toBe("ref");
  expect(deliverable(labRun([probe("ref", 0, { error: "boom" })]))).toBeUndefined();
});

test("the best attempt lands on a committed branch in a worktree; the real checkout is untouched", async () => {
  const run = labRun([probe("ref", 1), probe("comp-1", 2)], { selected: { id: "r1-comp-1", reason: "" } });
  await mkdir(join(labDir(home, run.id), "comp-1"), { recursive: true });
  await writeFile(join(labDir(home, run.id), "comp-1", "patch.diff"), "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n");
  const out = await handOver({ home, job, repo, result: { run, reflection: { lessons: [], dropped: [], stored: false, costUsd: 0 } } });
  expect(out.branch).toMatch(/^tropos\//);
  expect(out.text).toContain(`The best attempt (comp-1, 2/2 checks) is committed on branch ${out.branch}`);
  expect(out.text).toContain("answer from comp-1");
  expect(out.text).toContain("Harness: better (checks passed 1 → 2); candidate 20261021-100000-aaaa waits for you.");
  expect(git(repo, "show", `${out.branch}:a.txt`)).toBe("two");
  expect(git(repo, "log", "-1", "--format=%s", out.branch!)).toBe("Nightly fix: Fix a");
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
});

test("an attempt that changed nothing, or no valid attempt, is reported without a branch", async () => {
  const empty = await handOver({ home, job, repo, result: { run: labRun([probe("ref", 2)]), reflection: { lessons: [], dropped: [], stored: false, costUsd: 0 } } });
  expect(empty.branch).toBeUndefined();
  expect(empty.text).toContain("the best attempt (2/2 checks) changed nothing");
  const none = await handOver({ home, job, repo, result: { run: labRun([probe("ref", 0, { error: "x" })], { verdict: { outcome: "invalid", reasons: [] }, candidate: undefined }), reflection: { lessons: [], dropped: [], stored: false, costUsd: 0 } } });
  expect(none.text).toContain("no attempt finished without errors");
});
