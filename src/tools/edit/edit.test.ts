import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { busyBackend, recordingBackend, swappingBackend } from "../../../test/helpers/swap-backend";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { readTool } from "../read/read";
import { editTool } from "./edit";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

async function prepared(content: string) {
  await writeFile(join(dir, "f.ts"), content);
  const ctx = makeToolContext({ root: dir });
  await readTool.run({ file_path: "f.ts" }, ctx);
  return ctx;
}
const file = () => readFile(join(dir, "f.ts"), "utf8");

describe("Edit", () => {
  test("replaces a unique string", async () => {
    const ctx = await prepared("const a = 1;\nconst b = 2;\n");
    const out = await editTool.run({ file_path: "f.ts", old_string: "b = 2", new_string: "b = 3" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await file()).toBe("const a = 1;\nconst b = 3;\n");
    expect(out.display).toMatchObject({ kind: "diff", added: 1, removed: 1 });
  });

  test("rejects a non-unique string unless replace_all", async () => {
    const ctx = await prepared("x x x");
    const out = await editTool.run({ file_path: "f.ts", old_string: "x", new_string: "y" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("appears 3 times");
    const all = await editTool.run({ file_path: "f.ts", old_string: "x", new_string: "y", replace_all: true }, ctx);
    expect(all.isError).toBeUndefined();
    expect(await file()).toBe("y y y");
  });

  test("not found", async () => {
    const ctx = await prepared("hello");
    const out = await editTool.run({ file_path: "f.ts", old_string: "bye", new_string: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("not found");
  });

  test("identical strings are rejected", async () => {
    const ctx = await prepared("hello");
    expect((await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "hello" }, ctx)).isError).toBe(true);
  });

  test("requires a prior read", async () => {
    await writeFile(join(dir, "f.ts"), "hello");
    const out = await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "bye" }, makeToolContext({ root: dir }));
    expect(out.isError).toBe(true);
    expect(await file()).toBe("hello");
  });

  test("inserts dollar patterns literally", async () => {
    const ctx = await prepared("price = X;\n");
    await editTool.run({ file_path: "f.ts", old_string: "X", new_string: "`$&` + $1 + $$ + $'" }, ctx);
    expect(await file()).toBe("price = `$&` + $1 + $$ + $';\n");
  });

  test("inserts dollar patterns literally with replace_all", async () => {
    const ctx = await prepared("X X");
    await editTool.run({ file_path: "f.ts", old_string: "X", new_string: "$&", replace_all: true }, ctx);
    expect(await file()).toBe("$& $&");
  });

  test("edits CRLF files with LF strings and keeps CRLF", async () => {
    const ctx = await prepared("one\r\ntwo\r\nthree\r\n");
    const out = await editTool.run({ file_path: "f.ts", old_string: "one\ntwo", new_string: "uno\ndos" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await file()).toBe("uno\r\ndos\r\nthree\r\n");
  });

  test("empty old_string creates a missing file", async () => {
    const ctx = makeToolContext({ root: dir });
    const out = await editTool.run({ file_path: "new.ts", old_string: "", new_string: "fresh\n" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await readFile(join(dir, "new.ts"), "utf8")).toBe("fresh\n");
  });

  test("empty old_string on an existing file is rejected", async () => {
    const ctx = await prepared("content");
    expect((await editTool.run({ file_path: "f.ts", old_string: "", new_string: "x" }, ctx)).isError).toBe(true);
  });

  test("consecutive edits work without re-reading", async () => {
    const ctx = await prepared("a b");
    await editTool.run({ file_path: "f.ts", old_string: "a", new_string: "A" }, ctx);
    const out = await editTool.run({ file_path: "f.ts", old_string: "b", new_string: "B" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await file()).toBe("A B");
  });

  test("refuses a path that resolves differently from the approved one", async () => {
    const ctx = await prepared("hello");
    ctx.approvedPaths = [join(dir, "other.ts")];
    const out = await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "bye" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("changed after it was approved");
    expect(await file()).toBe("hello");
  });

  test("edits normally when the resolved path is the approved one", async () => {
    const ctx = await prepared("hello");
    ctx.approvedPaths = [join(dir, "f.ts")];
    const out = await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "bye" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await file()).toBe("bye");
  });

  test("creates a missing file when the resolved path is the approved one", async () => {
    const ctx = makeToolContext({ root: dir, approvedPaths: [join(dir, "new.ts")] });
    const out = await editTool.run({ file_path: "new.ts", old_string: "", new_string: "fresh\n" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await readFile(join(dir, "new.ts"), "utf8")).toBe("fresh\n");
  });

  // Root ignores file modes, so the permission case can only be exercised as a normal user.
  const permissionTest = process.getuid?.() === 0 ? test.skip : test;
  permissionTest("a write the OS refuses returns an error result instead of throwing", async () => {
    const ctx = await prepared("hello");
    await chmod(join(dir, "f.ts"), 0o444);
    try {
      const out = await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "bye" }, ctx);
      expect(out.isError).toBe(true);
      expect(out.content).toStartWith(`Cannot write ${join(dir, "f.ts")}: `);
    } finally {
      await chmod(join(dir, "f.ts"), 0o644);
    }
  });
});

describe("Edit: a folder swapped for a link while the file is opened", () => {
  test("an existing file behind a swapped parent is left untouched and its text isn't shown", async () => {
    const outside = await makeTmpDir();
    try {
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "rc"), "hello");
      await writeFile(join(outside, "rc"), "hello precious");
      // Both files get the same mtime, so the freshness check alone can't tell them apart.
      const then = new Date(2020, 0, 1);
      await utimes(join(dir, "sub", "rc"), then, then);
      await utimes(join(outside, "rc"), then, then);
      const ctx = makeToolContext({ root: dir });
      await readTool.run({ file_path: "sub/rc" }, ctx);
      ctx.exec = swappingBackend(join(dir, "sub"), outside);
      const out = await editTool.run({ file_path: "sub/rc", old_string: "hello", new_string: "pwned" }, ctx);
      expect(out.isError).toBe(true);
      expect(String(out.content)).toContain("changed while it was being opened");
      expect(JSON.stringify(out)).not.toContain("precious");
      expect(await readFile(join(outside, "rc"), "utf8")).toBe("hello precious");
    } finally {
      await removeDir(outside);
    }
  });

  test("creating a file under a swapped parent creates nothing outside", async () => {
    const outside = await makeTmpDir();
    try {
      await mkdir(join(dir, "sub"));
      const ctx = makeToolContext({ root: dir, exec: swappingBackend(join(dir, "sub"), outside) });
      const out = await editTool.run({ file_path: "sub/new.ts", old_string: "", new_string: "x" }, ctx);
      expect(out.isError).toBe(true);
      expect(await stat(join(outside, "new.ts")).catch(() => null)).toBeNull();
    } finally {
      await removeDir(outside);
    }
  });

  test("the sandbox is held while the file is edited and released afterwards, also when the edit fails", async () => {
    const ctx = await prepared("hello");
    const events: string[] = [];
    ctx.exec = recordingBackend(events);
    expect((await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "bye" }, ctx)).isError).toBeUndefined();
    expect((await editTool.run({ file_path: "f.ts", old_string: "absent", new_string: "x" }, ctx)).isError).toBe(true);
    expect(events).toEqual(["held", "released", "held", "released"]);
  });

  test("while the sandbox still runs a command, nothing is edited", async () => {
    const ctx = await prepared("hello");
    ctx.exec = busyBackend("A background command is still running.");
    const out = await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "bye" }, ctx);
    expect(out).toEqual({ content: "A background command is still running.", isError: true });
    expect(await file()).toBe("hello");
  });
});
