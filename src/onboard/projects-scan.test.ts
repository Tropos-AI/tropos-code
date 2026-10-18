import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { addProject, listProjects } from "../gateway/projects";
import { addScannedProjects, scanForRepos } from "./projects-scan";

const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 86_400_000;
let root: string;
let home: string;
let userHome: string;
beforeEach(async () => {
  root = await makeTmpDir("scan-");
  home = join(root, "tropos");
  userHome = join(root, "user");
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
});
afterEach(() => removeDir(root));

/** A git repository at <userHome>/<path> whose newest git file is `ageDays` old. */
async function repo(path: string, ageDays: number): Promise<void> {
  const dir = join(userHome, path, ".git");
  await mkdir(dir, { recursive: true });
  const index = join(dir, "index");
  await writeFile(index, "");
  const t = new Date(NOW - ageDays * DAY);
  await utimes(index, t, t);
}
const scan = (extra: Partial<Parameters<typeof scanForRepos>[0]> = {}) => scanForRepos({ home, userHome, now: () => NOW, ...extra });

describe("scanForRepos", () => {
  test("finds repos under the common folders; skips hidden, node_modules, repo insides and anything past depth 3", async () => {
    await repo("code/app", 1);
    await repo("code/app/vendor/inner", 1);
    await repo("Projects/org/tool", 2);
    await repo("Developer/a/b/deep3", 3);
    await repo("Developer/a/b/c/too-deep", 3);
    await repo("code/.hidden/x", 1);
    await repo("code/node_modules/y", 1);
    await repo("Music/z", 1);
    const { repos, truncated } = await scan();
    expect(repos.map((r) => r.name).sort()).toEqual(["app", "deep3", "tool"]);
    expect(truncated).toBe(false);
  });

  test("a .git file (worktree or submodule) also marks a repo", async () => {
    await mkdir(join(userHome, "code", "wt"), { recursive: true });
    await writeFile(join(userHome, "code", "wt", ".git"), "gitdir: /elsewhere\n");
    expect((await scan()).repos.map((r) => r.name)).toEqual(["wt"]);
  });

  test("only repos touched in the last 30 days are recent, and they come first", async () => {
    await repo("code/old", 40);
    await repo("code/new", 10);
    expect((await scan()).repos.map((r) => [r.name, r.recent])).toEqual([["new", true], ["old", false]]);
  });

  test("symlinks are never followed: a linked repo is not listed and a loop is not walked", async () => {
    await repo("code/real", 1);
    await repo("elsewhere/linked-target", 1);
    await symlink(join(userHome, "elsewhere", "linked-target"), join(userHome, "code", "linked"));
    await symlink(join(userHome, "code"), join(userHome, "code", "loop"));
    const r = await scan();
    expect(r.repos.map((x) => x.name)).toEqual(["real"]);
    expect(r.truncated).toBe(false);
  });

  test("a slow tree stops at the time limit", async () => {
    await repo("code/a", 1);
    await repo("Projects/b", 1);
    await repo("src/c", 1);
    let t = 0;
    const r = await scan({ now: () => (t += 1_000), limits: { timeMs: 2_500 } });
    expect(r.truncated).toBe(true);
    expect(r.repos.length).toBeLessThan(3);
  });

  test("the repo count limit truncates", async () => {
    for (const n of ["a", "b", "c"]) await repo(`code/${n}`, 1);
    const r = await scan({ limits: { maxRepos: 2 } });
    expect(r.repos).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  test("registered repos are marked", async () => {
    await repo("code/app", 1);
    await repo("code/tool", 1);
    await addProject(home, { path: join(userHome, "code/app") }, { userHome });
    expect((await scan()).repos.map((r) => [r.name, r.registered]).sort()).toEqual([["app", true], ["tool", false]]);
  });
});

describe("addScannedProjects", () => {
  test("adds once and reports a refused path plainly", async () => {
    await repo("code/app", 1);
    await repo("code/tool", 1);
    await addProject(home, { path: join(userHome, "code/app") }, { userHome });
    const r = await addScannedProjects(home, [join(userHome, "code/app"), join(userHome, "code/tool"), userHome], userHome);
    expect(r.added).toEqual([await realpath(join(userHome, "code/tool"))]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.error).toContain("home directory");
    expect((await listProjects(home)).filter((p) => p.name === "app")).toHaveLength(1);
  });
});
