import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { worktreesDir } from "../paths";
import { git, makeRepo } from "../snapshots/test-repo";
import { createWorktree, finishWorktree, ghReady, taskName, WorktreeStore, worktreeChanges, type GitRun, type Worktree } from "./worktrees";

const HAS_GIT = Bun.which("git") !== null;
const d = HAS_GIT ? describe : describe.skip;

d("worktrees", () => {
  let home: string;
  let repo: string;
  const dirs: string[] = [];
  beforeEach(async () => {
    home = await makeTmpDir("tropos-wt-home-");
    repo = await makeRepo();
    dirs.push(home, repo);
  });
  afterEach(async () => {
    for (const x of dirs.splice(0)) await removeDir(x);
  });
  const make = async (): Promise<Worktree> =>
    (await createWorktree({ home, key: "telegram:1@app", projectId: "app", repo, now: () => new Date(2026, 9, 16, 9, 5) }))!;

  test("a worktree lives under ~/.tropos/worktrees/<project>/<task> on tropos/<task>, and the checkout is untouched", async () => {
    const w = await make();
    expect(w.path).toBe(join(home, "worktrees", "app", w.task));
    expect(w.branch).toBe(`tropos/${w.task}`);
    expect(w.task).toMatch(/^20261016-0905-[0-9a-f]{4}$/);
    expect(w.base).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(readFileSync(join(w.path, "a.txt"), "utf8")).toBe("one\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "branch", "--show-current").trim()).not.toBe(w.branch);
    expect(statSync(w.path).isDirectory()).toBe(true);
  });

  test("the task name has the date, the time and four hex digits", () => {
    expect(taskName(new Date(2026, 0, 2, 3, 4), () => "ab12")).toBe("20260102-0304-ab12");
  });

  test("a repo without commits gets no worktree", async () => {
    const bare = await makeTmpDir();
    dirs.push(bare);
    git(bare, "init", "-q");
    expect(await createWorktree({ home, key: "k", projectId: "x", repo: bare })).toBeUndefined();
  });

  test("a project folder that is a link out of ~/.tropos/worktrees is refused, and nothing is created through it", async () => {
    const outside = await makeTmpDir("tropos-wt-out-");
    dirs.push(outside);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(worktreesDir(home), { recursive: true });
    symlinkSync(outside, join(worktreesDir(home), "app"));
    await expect(createWorktree({ home, key: "k", projectId: "app", repo })).rejects.toThrow(/worktrees/);
    expect(existsSync(join(outside, "x"))).toBe(false);
    expect(git(repo, "branch", "--list", "tropos/*")).toBe("");
  });

  test("a project id that is not a plain name is refused", async () => {
    await expect(createWorktree({ home, key: "k", projectId: "../evil", repo })).rejects.toThrow();
  });

  test("the store keeps worktrees in a private file", async () => {
    const w = await make();
    const store = new WorktreeStore(home);
    expect(await store.get(w.key)).toBeUndefined();
    await store.put(w);
    expect(await new WorktreeStore(home).get(w.key)).toEqual(w);
    expect(statSync(join(home, "gateway", "worktrees.json")).mode & 0o777).toBe(0o600);
    await store.remove(w.key);
    expect(await store.get(w.key)).toBeUndefined();
  });

  test("keep commits the work on the branch and removes the worktree folder", async () => {
    const w = await make();
    writeFileSync(join(w.path, "b.txt"), "two\n");
    expect(await worktreeChanges(w)).toEqual({ changedFiles: 1, commitsAhead: 0 });
    const r = await finishWorktree(w, "keep", { title: "add b" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain(w.branch);
    expect(existsSync(w.path)).toBe(false);
    expect(git(repo, "show", `${w.branch}:b.txt`)).toBe("two\n");
  });

  test("merge brings the work into the current branch and deletes tropos/<task>", async () => {
    const w = await make();
    writeFileSync(join(w.path, "b.txt"), "two\n");
    const r = await finishWorktree(w, "merge", { title: "add b" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
    expect(git(repo, "branch", "--list", w.branch)).toBe("");
    expect(existsSync(w.path)).toBe(false);
  });

  test("a conflicting merge is aborted and the branch kept", async () => {
    const w = await make();
    writeFileSync(join(w.path, "a.txt"), "theirs\n");
    writeFileSync(join(repo, "a.txt"), "mine\n");
    git(repo, "commit", "-qam", "mine");
    const r = await finishWorktree(w, "merge", { title: "edit a" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(w.branch);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(repo, "branch", "--list", w.branch)).toContain(w.branch);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("mine\n");
  });

  test("discard removes the folder and the branch", async () => {
    const w = await make();
    writeFileSync(join(w.path, "b.txt"), "two\n");
    expect((await finishWorktree(w, "discard", { title: "x" })).ok).toBe(true);
    expect(existsSync(w.path)).toBe(false);
    expect(git(repo, "branch", "--list", w.branch)).toBe("");
  });

  test("a worktree path that was swapped for a link is unlinked, never followed", async () => {
    const w = await make();
    const outside = await makeTmpDir("tropos-wt-out-");
    dirs.push(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    const { rmSync } = await import("node:fs");
    rmSync(w.path, { recursive: true, force: true });
    symlinkSync(outside, w.path);
    expect((await finishWorktree(w, "discard", { title: "x" })).ok).toBe(true);
    expect(existsSync(w.path)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("x");
  });

  test("a stored path outside ~/.tropos/worktrees is never removed", async () => {
    const w = await make();
    const outside = await makeTmpDir("tropos-wt-out-");
    dirs.push(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    const r = await finishWorktree({ ...w, path: outside }, "discard", { title: "x" });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("x");
  });

  test("repo hooks never run on Tropos's commit or merge", async () => {
    const w = await make();
    for (const name of ["pre-commit", "commit-msg", "pre-merge-commit", "post-merge", "post-commit"]) {
      writeFileSync(join(repo, ".git", "hooks", name), `#!/bin/sh\ntouch ${join(repo, "HOOK_RAN")}\n`, { mode: 0o755 });
    }
    writeFileSync(join(w.path, "c.txt"), "x");
    await finishWorktree(w, "merge", { title: "c" });
    expect(existsSync(join(repo, "c.txt"))).toBe(true);
    expect(existsSync(join(repo, "HOOK_RAN"))).toBe(false);
  });

  describe("pr", () => {
    const fakeGh = (ready: boolean) => {
      const calls: string[][] = [];
      const gh: GitRun = async (args) => {
        calls.push(args);
        if (args[0] === "auth") return { code: ready ? 0 : 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "https://github.com/o/r/pull/7\n", stderr: "" };
      };
      return { gh, calls };
    };

    test("pushes the branch and opens a PR with gh", async () => {
      const origin = await makeTmpDir("tropos-wt-origin-");
      dirs.push(origin);
      git(origin, "init", "-q", "--bare");
      git(repo, "remote", "add", "origin", origin);
      const w = await make();
      writeFileSync(join(w.path, "b.txt"), "two\n");
      const { gh, calls } = fakeGh(true);
      const r = await finishWorktree(w, "pr", { title: "add b", gh });
      expect(r.ok).toBe(true);
      expect(r.message).toContain("https://github.com/o/r/pull/7");
      const create = calls.find((c) => c[0] === "pr")!;
      expect(create.slice(0, 4)).toEqual(["pr", "create", "--head", w.branch]);
      expect(create).toContain("add b");
      expect(git(origin, "branch", "--list", w.branch)).toContain(w.branch);
      expect(existsSync(w.path)).toBe(false);
      expect(git(repo, "branch", "--list", w.branch)).toContain(w.branch);
    });

    test("without gh logged in it is refused and nothing is pushed or committed", async () => {
      const origin = await makeTmpDir("tropos-wt-origin-");
      dirs.push(origin);
      git(origin, "init", "-q", "--bare");
      git(repo, "remote", "add", "origin", origin);
      const w = await make();
      writeFileSync(join(w.path, "b.txt"), "two\n");
      const { gh } = fakeGh(false);
      const r = await finishWorktree(w, "pr", { title: "add b", gh });
      expect(r.ok).toBe(false);
      expect(git(origin, "branch", "--list")).toBe("");
      expect(existsSync(w.path)).toBe(true);
    });

    test("ghReady needs both a logged-in gh and an origin remote", async () => {
      const { gh } = fakeGh(true);
      expect(await ghReady(repo, gh)).toBe(false);
      git(repo, "remote", "add", "origin", "https://example.com/x.git");
      expect(await ghReady(repo, gh)).toBe(true);
      expect(await ghReady(repo, fakeGh(false).gh)).toBe(false);
    });
  });
});
