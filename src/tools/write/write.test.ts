import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { busyBackend, swappingBackend } from "../../../test/helpers/swap-backend";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { writeFileNoFollow } from "../file-guard";
import { readTool } from "../read/read";
import { writeTool } from "./write";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

describe("Write", () => {
  test("creates a new file and its parent directories", async () => {
    const ctx = makeToolContext({ root: dir });
    const out = await writeTool.run({ file_path: "a/b/new.ts", content: "x\ny\n" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await readFile(join(dir, "a/b/new.ts"), "utf8")).toBe("x\ny\n");
    expect(out.display).toMatchObject({ kind: "diff", added: 2, removed: 0 });
  });

  test("refuses to overwrite a file that was never read", async () => {
    await writeFile(join(dir, "f.txt"), "old");
    const out = await writeTool.run({ file_path: "f.txt", content: "new" }, makeToolContext({ root: dir }));
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Read it");
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("old");
  });

  test("overwrites after a read and shows a diff", async () => {
    await writeFile(join(dir, "f.txt"), "old\n");
    const ctx = makeToolContext({ root: dir });
    await readTool.run({ file_path: "f.txt" }, ctx);
    const out = await writeTool.run({ file_path: "f.txt", content: "new\n" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.display).toMatchObject({ kind: "diff", added: 1, removed: 1 });
  });

  test("refuses when the file changed since it was read", async () => {
    await writeFile(join(dir, "f.txt"), "old");
    const ctx = makeToolContext({ root: dir });
    await readTool.run({ file_path: "f.txt" }, ctx);
    const later = new Date(Date.now() + 5000);
    await utimes(join(dir, "f.txt"), later, later);
    const out = await writeTool.run({ file_path: "f.txt", content: "new" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("changed on disk");
  });

  test("a second write without re-reading is allowed (read state is refreshed)", async () => {
    const ctx = makeToolContext({ root: dir });
    await writeTool.run({ file_path: "f.txt", content: "1" }, ctx);
    const out = await writeTool.run({ file_path: "f.txt", content: "2" }, ctx);
    expect(out.isError).toBeUndefined();
  });

  // Root ignores directory modes, so the permission case can only be exercised as a normal user.
  const permissionTest = process.getuid?.() === 0 ? test.skip : test;
  permissionTest("a write the OS refuses returns an error result instead of throwing", async () => {
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o555);
    try {
      const out = await writeTool.run({ file_path: "locked/new.txt", content: "x" }, makeToolContext({ root: dir }));
      expect(out.isError).toBe(true);
      expect(out.content).toStartWith(`Cannot write ${join(dir, "locked/new.txt")}: `);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  test("a symlink loop returns an error result instead of throwing", async () => {
    await symlink(join(dir, "loop2"), join(dir, "loop"));
    await symlink(join(dir, "loop"), join(dir, "loop2"));
    const out = await writeTool.run({ file_path: "loop", content: "x" }, makeToolContext({ root: dir }));
    expect(out.isError).toBe(true);
    expect(String(out.content)).toStartWith("Cannot write ");
  });

  test("refuses a path that resolves differently from the approved one", async () => {
    const ctx = makeToolContext({ root: dir, approvedPaths: [join(dir, "other.txt")] });
    const out = await writeTool.run({ file_path: "f.txt", content: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("changed after it was approved");
    expect(await exists(join(dir, "f.txt"))).toBe(false);
  });

  test("writes normally when the resolved path is the approved one", async () => {
    const ctx = makeToolContext({ root: dir, approvedPaths: [join(dir, "f.txt")] });
    const out = await writeTool.run({ file_path: "f.txt", content: "x" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("x");
  });

  test("writeFileNoFollow never writes through a symlinked leaf", async () => {
    const project = join(dir, "project");
    await mkdir(project);
    await writeFile(join(dir, "target-outside"), "untouched");
    await symlink(join(dir, "target-outside"), join(project, "leaf"));
    await expect(writeFileNoFollow(join(project, "leaf"), "pwned")).rejects.toThrow();
    expect(await readFile(join(dir, "target-outside"), "utf8")).toBe("untouched");
  });
});

describe("Write: a folder swapped for a link while the file is opened", () => {
  let outside: string;
  beforeEach(async () => {
    outside = await makeTmpDir();
    await mkdir(join(dir, "sub"));
  });
  afterEach(() => removeDir(outside));

  test("an existing file behind a swapped parent is neither truncated nor overwritten, and its text isn't shown", async () => {
    await writeFile(join(dir, "sub", "agent.plist"), "decoy");
    await writeFile(join(outside, "agent.plist"), "precious");
    // Both files get the same mtime, so the freshness check alone can't tell them apart.
    const then = new Date(2020, 0, 1);
    await utimes(join(dir, "sub", "agent.plist"), then, then);
    await utimes(join(outside, "agent.plist"), then, then);
    const ctx = makeToolContext({ root: dir });
    await readTool.run({ file_path: "sub/agent.plist" }, ctx);
    ctx.exec = swappingBackend(join(dir, "sub"), outside);
    const out = await writeTool.run({ file_path: "sub/agent.plist", content: "pwned" }, ctx);
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("changed while it was being opened");
    expect(JSON.stringify(out)).not.toContain("precious");
    expect(await readFile(join(outside, "agent.plist"), "utf8")).toBe("precious");
  });

  test("a new file under a swapped parent is not created outside", async () => {
    const ctx = makeToolContext({ root: dir, exec: swappingBackend(join(dir, "sub"), outside) });
    const out = await writeTool.run({ file_path: "sub/evil.plist", content: "pwned" }, ctx);
    expect(out.isError).toBe(true);
    expect(await exists(join(outside, "evil.plist"))).toBe(false);
  });

  test("missing folders under a swapped parent are not created outside", async () => {
    const ctx = makeToolContext({ root: dir, exec: swappingBackend(join(dir, "sub"), outside) });
    const out = await writeTool.run({ file_path: "sub/a/b/evil.plist", content: "pwned" }, ctx);
    expect(out.isError).toBe(true);
    expect(await exists(join(outside, "a"))).toBe(false);
  });

  test("while the sandbox still runs a command, nothing is written", async () => {
    const ctx = makeToolContext({ root: dir, exec: busyBackend("A background command is still running.") });
    const out = await writeTool.run({ file_path: "f.txt", content: "x" }, ctx);
    expect(out).toEqual({ content: "A background command is still running.", isError: true });
    expect(await exists(join(dir, "f.txt"))).toBe(false);
  });

  test("overwriting keeps the file's mode and replaces all of its old text", async () => {
    await writeFile(join(dir, "run.sh"), "a much longer original text\n");
    await chmod(join(dir, "run.sh"), 0o755);
    const ctx = makeToolContext({ root: dir });
    await readTool.run({ file_path: "run.sh" }, ctx);
    const out = await writeTool.run({ file_path: "run.sh", content: "short\n" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await readFile(join(dir, "run.sh"), "utf8")).toBe("short\n");
    expect((await stat(join(dir, "run.sh"))).mode & 0o777).toBe(0o755);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
