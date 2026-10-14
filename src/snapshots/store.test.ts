// src/snapshots/store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { projectKey } from "../paths";
import { SnapshotStore } from "./store";
import { git, makeRepo } from "./test-repo";

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await makeRepo();
  home = await makeTmpDir("tropos-snap-home-");
});

afterEach(async () => {
  await removeDir(repo);
  await removeDir(home);
});

async function openStore(cwd = repo): Promise<SnapshotStore> {
  const store = await SnapshotStore.open(home, cwd);
  if (store === null) throw new Error("store did not open");
  return store;
}

describe("SnapshotStore.open", () => {
  test("returns null outside a git work tree", async () => {
    const plain = await makeTmpDir("tropos-snap-plain-");
    try {
      expect(await SnapshotStore.open(home, plain)).toBeNull();
    } finally {
      await removeDir(plain);
    }
  });

  test("returns null when git is missing", async () => {
    expect(await SnapshotStore.open(home, repo, { git: "/nonexistent/git-binary" })).toBeNull();
  });

  test("creates the store under <home>/snapshots/<projectKey(root)> with .git excluded", async () => {
    mkdirSync(join(repo, "sub"));
    const store = await openStore(join(repo, "sub"));
    expect(store.root).toBe(repo);
    expect(store.dir).toBe(join(home, "snapshots", projectKey(repo)));
    expect(existsSync(join(store.dir, "HEAD"))).toBe(true);
    expect(readFileSync(join(store.dir, "info", "exclude"), "utf8")).toBe(".git\n");
    // Reopening reuses it.
    const again = await openStore();
    expect(again.dir).toBe(store.dir);
  });

  test("excludes the store itself when the home lives inside the work tree", async () => {
    const inner = join(repo, ".tropos-home");
    const store = await SnapshotStore.open(inner, repo);
    expect(store).not.toBeNull();
    const exclude = readFileSync(join(store!.dir, "info", "exclude"), "utf8");
    expect(exclude).toContain(`/.tropos-home/snapshots/${projectKey(repo)}/`);
    writeFileSync(join(repo, "b.txt"), "b\n");
    const tree = await store!.track();
    expect(tree).not.toBeNull();
    writeFileSync(join(repo, "c.txt"), "c\n");
    expect(await store!.changedSince(tree!)).toEqual(["c.txt"]);
  });
});

describe("track / changedSince / restore", () => {
  test("track returns a stable tree hash", async () => {
    const store = await openStore();
    const t1 = await store.track();
    expect(t1).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await store.track()).toBe(t1!);
    writeFileSync(join(repo, "a.txt"), "two\n");
    expect(await store.track()).not.toBe(t1!);
  });

  test("changedSince lists added, modified and deleted paths, sorted, ignoring ignored files", async () => {
    mkdirSync(join(repo, "dir"));
    writeFileSync(join(repo, "dir", "gone.txt"), "x\n");
    const store = await openStore();
    const tree = (await store.track())!;
    expect(await store.changedSince(tree)).toEqual([]);
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "z new.txt"), "new\n");
    rmSync(join(repo, "dir", "gone.txt"));
    writeFileSync(join(repo, "debug.log"), "ignored\n");
    expect(await store.changedSince(tree)).toEqual(["a.txt", "dir/gone.txt", "z new.txt"]);
  });

  test("changedSince throws for an unknown tree", async () => {
    const store = await openStore();
    await expect(store.changedSince("0".repeat(40))).rejects.toThrow();
  });

  test("restore overwrites changed, recreates deleted, deletes created; leaves ignored and .git alone", async () => {
    mkdirSync(join(repo, "keep"));
    writeFileSync(join(repo, "keep", "deleted.txt"), "keep me\n");
    writeFileSync(join(repo, "untouched.txt"), "same\n");
    const store = await openStore();
    const tree = (await store.track())!;
    const statusBefore = git(repo, "status", "--porcelain");
    const headBefore = git(repo, "rev-parse", "HEAD");
    const indexBefore = readFileSync(join(repo, ".git", "index"));
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(repo, "untouched.txt"), old, old);

    writeFileSync(join(repo, "a.txt"), "edited\n");
    rmSync(join(repo, "keep"), { recursive: true });
    mkdirSync(join(repo, "new dir", "deep"), { recursive: true });
    writeFileSync(join(repo, "new dir", "deep", "créé ü.txt"), "new\n");
    writeFileSync(join(repo, "build.log"), "ignored\n");

    const changed = await store.restore(tree);
    expect(changed).toEqual(["a.txt", "keep/deleted.txt", "new dir/deep/créé ü.txt"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(repo, "keep", "deleted.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(repo, "new dir"))).toBe(false); // emptied directories removed too
    expect(readFileSync(join(repo, "build.log"), "utf8")).toBe("ignored\n");
    // Unchanged files are not rewritten.
    expect(Math.round(Bun.file(join(repo, "untouched.txt")).lastModified / 1000)).toBe(Math.round(old.getTime() / 1000));
    // The real repository is untouched.
    // (index first: `git status` itself may rewrite the real index with refreshed stat data)
    expect(readFileSync(join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(await store.changedSince(tree)).toEqual([]);
  });

  test("restore keeps a directory that still holds other files", async () => {
    mkdirSync(join(repo, "d"));
    writeFileSync(join(repo, "d", "old.txt"), "o\n");
    const store = await openStore();
    const tree = (await store.track())!;
    writeFileSync(join(repo, "d", "new.txt"), "n\n");
    expect(await store.restore(tree)).toEqual(["d/new.txt"]);
    expect(existsSync(join(repo, "d", "old.txt"))).toBe(true);
    expect(existsSync(join(repo, "d", "new.txt"))).toBe(false);
  });

  test("restore handles a file replaced by a directory and back", async () => {
    writeFileSync(join(repo, "thing"), "file\n");
    const store = await openStore();
    const fileTree = (await store.track())!;
    rmSync(join(repo, "thing"));
    mkdirSync(join(repo, "thing"));
    writeFileSync(join(repo, "thing", "inner.txt"), "inner\n");
    const dirTree = (await store.track())!;

    expect(await store.restore(fileTree)).toEqual(["thing", "thing/inner.txt"]);
    expect(readFileSync(join(repo, "thing"), "utf8")).toBe("file\n");

    expect(await store.restore(dirTree)).toEqual(["thing", "thing/inner.txt"]);
    expect(readFileSync(join(repo, "thing", "inner.txt"), "utf8")).toBe("inner\n");
  });

  test("restore with no changes is a no-op", async () => {
    const store = await openStore();
    const tree = (await store.track())!;
    expect(await store.restore(tree)).toEqual([]);
  });

  test("restore throws for an unknown tree and touches nothing", async () => {
    const store = await openStore();
    writeFileSync(join(repo, "a.txt"), "mine\n");
    await expect(store.restore("0".repeat(40))).rejects.toThrow();
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("mine\n");
  });

  test("inherited GIT_* variables cannot redirect the store at the real repo", async () => {
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = join(repo, ".git");
    process.env.GIT_INDEX_FILE = join(repo, ".git", "index");
    try {
      const store = await openStore();
      const indexBefore = readFileSync(join(repo, ".git", "index"));
      const tree = (await store.track())!;
      writeFileSync(join(repo, "x.txt"), "x\n");
      await store.restore(tree);
      expect(readFileSync(join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
      expect(existsSync(join(repo, "x.txt"))).toBe(false);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.index === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved.index;
    }
  });

  test("concurrent operations are serialized", async () => {
    const store = await openStore();
    const results = await Promise.all([store.track(), store.track(), store.track()]);
    expect(results.every((r) => r !== null && r === results[0])).toBe(true);
  });
});

describe("track failure", () => {
  test("returns null when git fails", async () => {
    const store = await openStore();
    // A store whose objects directory is unwritable makes write-tree / add fail.
    rmSync(join(store.dir, "objects"), { recursive: true, force: true });
    writeFileSync(join(store.dir, "objects"), "not a dir");
    writeFileSync(join(repo, "new.txt"), "n\n");
    expect(await store.track()).toBeNull();
  });
});

describe("prune", () => {
  test("runs gc once and then skips within a day", async () => {
    const store = await openStore();
    await store.track();
    const stamp = join(store.dir, "tropos-last-prune");
    expect(existsSync(stamp)).toBe(false);
    await store.prune();
    expect(existsSync(stamp)).toBe(true);
    const first = readFileSync(stamp, "utf8");
    await Bun.sleep(5);
    await store.prune();
    expect(readFileSync(stamp, "utf8")).toBe(first);
    // An old stamp lets it run again.
    const old = new Date(Date.now() - 2 * 24 * 3600_000);
    utimesSync(stamp, old, old);
    await store.prune();
    expect(readFileSync(stamp, "utf8")).not.toBe(first);
  });
});

describe("nested repositories", () => {
  test("restore never deletes a nested repository created since the snapshot", async () => {
    const store = await openStore();
    const tree = (await store.track())!;
    const nested = join(repo, "vendor");
    mkdirSync(nested);
    git(nested, "init", "-q");
    writeFileSync(join(nested, "lib.txt"), "lib\n");
    git(nested, "add", "-A");
    git(nested, "commit", "-qm", "n");
    writeFileSync(join(repo, "a.txt"), "edited\n");
    const changed = await store.restore(tree);
    expect(changed).toEqual(["a.txt", "vendor"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(nested, "lib.txt"), "utf8")).toBe("lib\n");
  });
});
