// src/tools/read/read.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { busyBackend, recordingBackend, swappingBackend } from "../../../test/helpers/swap-backend";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { toInputSchema } from "../schema";
import { readTool } from "./read";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await writeFile(join(dir, "three.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(dir, "crlf.txt"), "one\r\ntwo\r\n");
  await writeFile(join(dir, "empty.txt"), "");
  await writeFile(join(dir, "long.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
  await writeFile(join(dir, "wide.txt"), "x".repeat(3000));
  await writeFile(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  await writeFile(join(dir, "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await mkdir(join(dir, "sub"));
  // 3000 lines of 100 characters: well over the 200,000-character cap before the line limit applies.
  await writeFile(join(dir, "dense.txt"), Array.from({ length: 3000 }, (_, i) => `${String(i + 1).padStart(4, "0")} ${"x".repeat(95)}`).join("\n"));
});
afterAll(() => removeDir(dir));

const run = (input: Parameters<typeof readTool.run>[0], ctx = makeToolContext({ root: dir })) => readTool.run(input, ctx);

describe("Read: approved paths and output cap", () => {
  test("refuses a path that resolves differently from the approved one", async () => {
    const ctx = makeToolContext({ root: dir, approvedPaths: [join(dir, "other.txt")] });
    const out = await readTool.run({ file_path: "three.txt" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("changed after it was approved; nothing was read");
    expect(ctx.readState.check(join(dir, "three.txt"), 0)).toBe("unread");
  });
  test("reads normally when the resolved path is the approved one", async () => {
    const ctx = makeToolContext({ root: dir, approvedPaths: [join(dir, "three.txt")] });
    const out = await readTool.run({ file_path: "three.txt" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("alpha");
  });
  test("caps total text output at 200,000 characters, cutting at a line boundary", async () => {
    const out = await run({ file_path: "dense.txt", limit: 3000 });
    const content = out.content as string;
    const [body, note] = content.split("\n\n[Showing lines");
    expect(body!.length).toBeLessThanOrEqual(200_000);
    const shown = body!.split("\n");
    expect(shown.at(-1)).toMatch(/^ {2}\d{4}\t\d{4} x{95}$/);
    expect(note).toContain(`1-${shown.length} of 3000`);
    expect(note).toContain(`offset ${shown.length + 1}`);
    expect(out.summary).toBe(`${shown.length} lines`);
  });
  test("output under the cap is untouched", async () => {
    const out = await run({ file_path: "long.txt", limit: 2000 });
    expect(out.content as string).toContain("[Showing lines 1-2000 of 2500. Use offset to read more.]");
  });
});

describe("Read", () => {
  test("numbers lines like cat -n", async () => {
    const out = await run({ file_path: "three.txt" });
    expect(out.content).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
    expect(out.summary).toBe("3 lines");
    expect(out.isError).toBeUndefined();
  });

  test("handles CRLF", async () => {
    expect((await run({ file_path: "crlf.txt" })).content).toBe("     1\tone\n     2\ttwo");
  });

  test("offset and limit", async () => {
    const out = await run({ file_path: "long.txt", offset: 10, limit: 2 });
    expect(out.content).toStartWith("    10\tline 10\n    11\tline 11");
    expect(out.content).toContain("Showing lines 10-11 of 2500");
  });

  test("defaults to 2000 lines and says how to continue", async () => {
    const out = await run({ file_path: "long.txt" });
    expect(out.content).toContain("  2000\tline 2000");
    expect(out.content).not.toContain("line 2001");
    expect(out.content).toContain("Showing lines 1-2000 of 2500");
  });

  test("offset past the end is reported, not an error", async () => {
    const out = await run({ file_path: "three.txt", offset: 99 });
    expect(out.content).toContain("has 3 lines");
    expect(out.isError).toBeUndefined();
  });

  test("very long lines are cut", async () => {
    expect(String((await run({ file_path: "wide.txt" })).content)).toContain("[line truncated]");
  });

  test("empty file", async () => {
    expect((await run({ file_path: "empty.txt" })).content).toContain("is empty");
  });

  test("errors: missing, directory, binary", async () => {
    expect((await run({ file_path: "nope.txt" })).isError).toBe(true);
    expect((await run({ file_path: "sub" })).content).toContain("is a directory");
    expect((await run({ file_path: "bin.dat" })).content).toContain("binary");
  });

  test("images come back as image blocks", async () => {
    const out = await run({ file_path: "pixel.png" });
    expect(Array.isArray(out.content)).toBe(true);
    expect((out.content as Array<{ type: string }>)[0]!.type).toBe("image");
  });

  test("records read state with the file's mtime", async () => {
    const ctx = makeToolContext({ root: dir });
    await run({ file_path: "three.txt" }, ctx);
    const path = join(dir, "three.txt");
    expect(ctx.readState.check(path, (await stat(path)).mtimeMs)).toBe("ok");
  });

  // Root ignores file modes, so the unreadable-file case can only be exercised as a normal user.
  const unreadableTest = process.getuid?.() === 0 ? test.skip : test;
  unreadableTest("a file that cannot be read returns an error result instead of throwing", async () => {
    const path = join(dir, "locked.txt");
    await writeFile(path, "secret");
    await chmod(path, 0o000);
    try {
      const out = await run({ file_path: "locked.txt" });
      expect(out.isError).toBe(true);
      expect(out.content).toStartWith(`Cannot read ${path}: `);
    } finally {
      await chmod(path, 0o644);
    }
  });

  test("a path that cannot be resolved returns an error result instead of throwing", async () => {
    const out = await run({ file_path: "three.txt/child" });
    expect(out.isError).toBe(true);
    expect(String(out.content)).toStartWith("Cannot read ");
  });

  test("a missing file keeps the 'File not found' message", async () => {
    const out = await run({ file_path: "nope.txt" });
    expect(String(out.content)).toStartWith("File not found: ");
  });

  test("files over 10 MB are refused with a hint to search instead", async () => {
    await writeFile(join(dir, "huge.txt"), Buffer.alloc(10 * 1024 * 1024 + 1, "a"));
    const out = await run({ file_path: "huge.txt" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("over the 10 MB text limit");
    expect(out.content).toContain("Grep");
  });

  test("subject and schema", () => {
    expect(readTool.subject({ file_path: "a.ts" }, dir)).toEqual({ paths: [join(dir, "a.ts")] });
    const schema = toInputSchema(readTool.schema);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["file_path"]);
    expect("$schema" in schema).toBe(false);
  });
});

describe("Read: a folder swapped for a link while the file is opened", () => {
  test("a parent folder swapped for a link after the path was checked is refused, and nothing outside is read", async () => {
    const root = await makeTmpDir();
    try {
      await mkdir(join(root, "project", "sub"), { recursive: true });
      await mkdir(join(root, "outside"));
      await writeFile(join(root, "project", "sub", "id_ed25519"), "decoy\n");
      await writeFile(join(root, "outside", "id_ed25519"), "PRIVATE KEY\n");
      const ctx = makeToolContext({ root: join(root, "project"), exec: swappingBackend(join(root, "project", "sub"), join(root, "outside")) });
      const out = await run({ file_path: "sub/id_ed25519" }, ctx);
      expect(out.isError).toBe(true);
      expect(String(out.content)).toContain("changed while it was being opened");
      expect(String(out.content)).not.toContain("PRIVATE KEY");
    } finally {
      await removeDir(root);
    }
  });

  test("while the sandbox still runs a command, nothing is read and the reason is given", async () => {
    const out = await run({ file_path: "three.txt" }, makeToolContext({ root: dir, exec: busyBackend("A background command is still running.") }));
    expect(out).toEqual({ content: "A background command is still running.", isError: true });
  });

  test("the sandbox is held while the file is read and released afterwards, also when the read fails", async () => {
    const events: string[] = [];
    const ctx = makeToolContext({ root: dir, exec: recordingBackend(events) });
    expect((await run({ file_path: "three.txt" }, ctx)).isError).toBeUndefined();
    expect((await run({ file_path: "nope.txt" }, ctx)).isError).toBe(true);
    expect(events).toEqual(["held", "released", "held", "released"]);
  });

  test("a FIFO is refused at once instead of hanging the read", async () => {
    const fifo = join(dir, "pipe");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const out = await run({ file_path: "pipe" });
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("not a regular file");
  });
});
