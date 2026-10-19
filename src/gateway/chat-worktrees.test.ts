import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { AppContext } from "../cli/runtime";
import { git, makeRepo } from "../snapshots/test-repo";
import { createChatWorktrees, workdirForSession, worktreeContext } from "./chat-worktrees";
import { builtinProject, type Project } from "./projects";
import { createWorktree, WorktreeStore } from "./worktrees";

describe.skipIf(Bun.which("git") === null)("chat worktrees", () => {
  let home: string;
  let repo: string;
  let store: WorktreeStore;
  let app: Project;
  const dirs: string[] = [];
  beforeEach(async () => {
    home = await makeTmpDir("tropos-cwt-home-");
    repo = await makeRepo();
    dirs.push(home, repo);
    store = new WorktreeStore(home);
    app = { id: "app", name: "app", path: repo };
  });
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeDir(d);
  });

  test("a chat in a registered repo gets a worktree, and so does a guest's job; the default workspace and the owner's scheduled runs don't", async () => {
    const w = await workdirForSession({ key: "telegram:1@app", project: app, store, create: createWorktree, home });
    expect(w?.path.startsWith(join(home, "worktrees", "app"))).toBe(true);
    expect(await workdirForSession({ key: "telegram:1@app", project: app, store, create: createWorktree, home })).toEqual(w);
    expect(await workdirForSession({ key: "telegram:1@default", project: builtinProject(home), store, create: createWorktree, home })).toBeUndefined();
    expect(await workdirForSession({ key: "project:app@app", project: app, store, create: createWorktree, home })).toBeUndefined();
    // A guest's job never works in the owner's checkout.
    const guestJob = await workdirForSession({ key: "project:app:guest@app", project: app, store, create: createWorktree, home });
    expect(guestJob?.path.startsWith(join(home, "worktrees", "app"))).toBe(true);
    expect(guestJob?.path).not.toBe(w?.path);
  });

  test("a stored worktree whose folder is gone is replaced by a new one", async () => {
    const first = (await workdirForSession({ key: "telegram:1@app", project: app, store, create: createWorktree, home }))!;
    await removeDir(first.path);
    const second = (await workdirForSession({ key: "telegram:1@app", project: app, store, create: createWorktree, home }))!;
    expect(second.path).not.toBe(first.path);
    expect(existsSync(second.path)).toBe(true);
    expect((await store.get("telegram:1@app"))?.path).toBe(second.path);
  });

  test("a folder that is not a git repo with a commit has no worktree", async () => {
    const plain = await makeTmpDir("tropos-cwt-plain-");
    dirs.push(plain);
    expect(await workdirForSession({ key: "telegram:1@plain", project: { id: "plain", name: "plain", path: plain }, store, create: createWorktree, home })).toBeUndefined();
  });

  test("the context points the session at the worktree and tells the agent where it is", async () => {
    const w = (await workdirForSession({ key: "telegram:1@app", project: app, store, create: createWorktree, home }))!;
    const base = { cwd: repo, allowedDirs: [repo], contextBlocks: async () => ["<suggestions>s</suggestions>"] } as unknown as AppContext;
    const ctx = worktreeContext(base, w);
    expect(ctx.cwd).toBe(w.path);
    expect(ctx.allowedDirs).toEqual([w.path]);
    expect(await ctx.contextBlocks!()).toEqual([
      "<suggestions>s</suggestions>",
      `<worktree>You are working in a git worktree of app at ${w.path}, on branch ${w.branch}. The owner's own checkout is untouched. Don't commit, push or switch branches; when you're done, summarise what changed. The owner then chooses: merge, open a PR, keep the branch, or discard.</worktree>`,
    ]);
    expect(base.cwd).toBe(repo);
  });

  describe("finishing", () => {
    let closed: string[];
    const make = (isOwner: (s: string) => boolean = (s) => s === "1") => {
      closed = [];
      return createChatWorktrees({ store, current: async () => app, isOwner: async (s) => isOwner(s), closeSession: async (k) => void closed.push(k) });
    };
    const start = async () => (await workdirForSession({ key: "telegram:1@app", project: app, store, create: createWorktree, home }))!;

    test("guests can keep or discard but not merge or open a PR", async () => {
      const w = await start();
      const cw = make();
      expect(await cw.finish("telegram:1", "2", "merge", "t")).toBe("Only the owner can merge or open a PR. You can keep the branch or discard it.");
      expect(await cw.finish("telegram:1", "2", "pr", "t")).toBe("Only the owner can merge or open a PR. You can keep the branch or discard it.");
      expect(closed).toEqual([]);
      expect(await store.get("telegram:1@app")).toBeDefined();
      expect(await cw.finish("telegram:1", "2", "keep", "t")).toContain(w.branch);
      expect(closed).toEqual(["telegram:1@app"]);
      expect(await store.get("telegram:1@app")).toBeUndefined();
      expect(existsSync(w.path)).toBe(false);
    });

    test("the owner's merge lands the work; the session closes and the next message starts a new task", async () => {
      const w = await start();
      writeFileSync(join(w.path, "b.txt"), "two\n");
      const cw = make();
      expect(await cw.status("telegram:1")).toMatchObject({ branch: w.branch, changedFiles: 1, commitsAhead: 0 });
      expect(await cw.finish("telegram:1", "1", "merge", "add b")).toContain(`Merged ${w.branch}`);
      expect(git(repo, "log", "-1", "--format=%s").trim()).toContain(w.branch);
      expect(existsSync(join(repo, "b.txt"))).toBe(true);
      expect(closed).toEqual(["telegram:1@app"]);
      expect(await cw.status("telegram:1")).toBeUndefined();
      const next = await start();
      expect(next.task).not.toBe(w.task);
    });

    test("a PR that can't be opened leaves the worktree where it is for the next message", async () => {
      const w = await start();
      const gh = async () => ({ code: 1, stdout: "", stderr: "not logged in" });
      const cw = createChatWorktrees({ store, current: async () => app, isOwner: async () => true, closeSession: async () => {}, gh });
      expect(await cw.finish("telegram:1", "1", "pr", "t")).toContain("can't open a PR");
      expect(existsSync(w.path)).toBe(true);
      expect(await store.get("telegram:1@app")).toBeDefined();
    });

    test("there is nothing to finish without a worktree", async () => {
      expect(await make().finish("telegram:1", "1", "keep", "t")).toBe("There's no open task to finish here.");
      expect(await make().status("telegram:1")).toBeUndefined();
    });
  });
});
