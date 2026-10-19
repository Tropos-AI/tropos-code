import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { makeParentDirs, openVerified, PathSwapError, removeStray, replaceContents, verifyOpened } from "./file-guard";

let dir: string;
let project: string;
let outside: string;
beforeEach(async () => {
  dir = await realpath(await makeTmpDir());
  project = join(dir, "project");
  outside = join(dir, "outside");
  await mkdir(project);
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "precious");
});
afterEach(() => removeDir(dir));

const exists = (path: string) => stat(path).then(() => true, () => false);

const caseInsensitive = await (async () => {
  const probe = await makeTmpDir();
  try {
    await writeFile(join(probe, "Probe"), "");
    return await exists(join(probe, "PROBE"));
  } finally {
    await removeDir(probe);
  }
})();

describe("openVerified", () => {
  test("opens a file whose path has no links, for reading and for an update", async () => {
    await writeFile(join(project, "f.txt"), "hello");
    const read = await openVerified(join(project, "f.txt"), "read");
    try {
      expect(await read.handle.readFile("utf8")).toBe("hello");
      expect(read.info.isFile()).toBe(true);
    } finally {
      await read.handle.close();
    }
    const update = await openVerified(join(project, "f.txt"), "update");
    try {
      await replaceContents(update.handle, "bye");
    } finally {
      await update.handle.close();
    }
    expect(await readFile(join(project, "f.txt"), "utf8")).toBe("bye");
  });

  test("a file whose parent folder became a link to somewhere outside is refused for reading", async () => {
    await symlink(outside, join(project, "sub"));
    await expect(openVerified(join(project, "sub", "secret"), "read")).rejects.toBeInstanceOf(PathSwapError);
  });

  test("a file reached through a swapped parent is never truncated when opened for an update", async () => {
    await symlink(outside, join(project, "sub"));
    await expect(openVerified(join(project, "sub", "secret"), "update")).rejects.toBeInstanceOf(PathSwapError);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("precious");
  });

  test("creating a file under a swapped parent is refused before anything is created outside", async () => {
    await symlink(outside, join(project, "sub"));
    await expect(openVerified(join(project, "sub", "new.txt"), "create")).rejects.toBeInstanceOf(PathSwapError);
    expect(await exists(join(outside, "new.txt"))).toBe(false);
  });

  test("creating a file that appeared in the meantime fails instead of opening it", async () => {
    await writeFile(join(project, "late.txt"), "someone else's");
    await expect(openVerified(join(project, "late.txt"), "create")).rejects.toThrow();
    expect(await readFile(join(project, "late.txt"), "utf8")).toBe("someone else's");
  });

  test("a symlinked leaf is never followed", async () => {
    await symlink(join(outside, "secret"), join(project, "leaf"));
    await expect(openVerified(join(project, "leaf"), "read")).rejects.toThrow();
    await expect(openVerified(join(project, "leaf"), "update")).rejects.toThrow();
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("precious");
  });

  test("with a scope, a file reached through a link that stays inside it is accepted, one that leaves it is not", async () => {
    await mkdir(join(project, "real"));
    await writeFile(join(project, "real", "a.txt"), "inside");
    await symlink(join(project, "real"), join(project, "alias"));
    const opened = await openVerified(join(project, "alias", "a.txt"), "read", { within: [project] });
    try {
      expect(opened.real).toBe(join(project, "real", "a.txt"));
    } finally {
      await opened.handle.close();
    }
    await symlink(outside, join(project, "out"));
    await expect(openVerified(join(project, "out", "secret"), "read", { within: [project] })).rejects.toBeInstanceOf(PathSwapError);
  });

  test("opening a FIFO for reading returns at once instead of waiting for a writer", async () => {
    const fifo = join(project, "pipe");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const opened = await openVerified(fifo, "read");
    try {
      expect(opened.info.isFIFO()).toBe(true);
    } finally {
      await opened.handle.close();
    }
  });

  test.skipIf(!caseInsensitive)("a path typed in another letter case than on disk is accepted on a case-insensitive disk", async () => {
    await mkdir(join(project, "Src"));
    await writeFile(join(project, "Src", "File.ts"), "x");
    const opened = await openVerified(join(project, "src", "file.TS"), "read");
    await opened.handle.close();
  });
});

describe("verifyOpened", () => {
  test("a handle to another file than the one at the path is refused, as when a link was swapped in and back out", async () => {
    await writeFile(join(project, "secret"), "decoy");
    // The handle was opened while `project` led outside; by the check the path is back to its own file.
    const handle = await open(join(outside, "secret"), constants.O_RDONLY);
    try {
      await expect(verifyOpened(handle, join(project, "secret"))).rejects.toBeInstanceOf(PathSwapError);
    } finally {
      await handle.close();
    }
  });
});

describe("removeStray", () => {
  // The file a create made outside the project, through a folder swapped for a link between the check and the open.
  const strayed = async () => {
    const handle = await open(join(outside, "new.plist"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await symlink(outside, join(project, "sub"));
    return handle;
  };

  test("an empty file a create left outside the project is removed again", async () => {
    const handle = await strayed();
    try {
      expect(await removeStray(handle, join(project, "sub", "new.plist"), [project])).toBe(true);
    } finally {
      await handle.close();
    }
    expect(await exists(join(outside, "new.plist"))).toBe(false);
  });

  test("a file that is no longer the handle's is left alone", async () => {
    const handle = await strayed();
    try {
      await rm(join(outside, "new.plist"));
      await writeFile(join(outside, "new.plist"), "someone else's");
      expect(await removeStray(handle, join(project, "sub", "new.plist"), [project])).toBe(false);
    } finally {
      await handle.close();
    }
    expect(await readFile(join(outside, "new.plist"), "utf8")).toBe("someone else's");
  });

  test("a file that landed inside the project is left: a command there could have made it anyway", async () => {
    await mkdir(join(project, "real"));
    const handle = await open(join(project, "real", "x"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await symlink(join(project, "real"), join(project, "sub"));
    try {
      expect(await removeStray(handle, join(project, "sub", "x"), [project])).toBe(false);
    } finally {
      await handle.close();
    }
    expect(await exists(join(project, "real", "x"))).toBe(true);
  });
});

describe("makeParentDirs", () => {
  test("creates the missing folders one at a time", async () => {
    await makeParentDirs(join(project, "a", "b", "c"));
    expect((await stat(join(project, "a", "b", "c"))).isDirectory()).toBe(true);
  });

  test("an existing folder is left as it is", async () => {
    await mkdir(join(project, "a"));
    await makeParentDirs(join(project, "a"));
    expect((await stat(join(project, "a"))).isDirectory()).toBe(true);
  });

  test("a symlinked folder on the way is refused and nothing is created through it", async () => {
    await symlink(outside, join(project, "a"));
    await expect(makeParentDirs(join(project, "a", "b", "c"))).rejects.toBeInstanceOf(PathSwapError);
    expect(await exists(join(outside, "b"))).toBe(false);
  });

  test("an existing folder that became a link is refused too", async () => {
    await symlink(outside, join(project, "a"));
    await expect(makeParentDirs(join(project, "a"))).rejects.toBeInstanceOf(PathSwapError);
  });
});
