// src/tools/read/read.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
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
});
afterAll(() => removeDir(dir));

const run = (input: Parameters<typeof readTool.run>[0], ctx = makeToolContext({ root: dir })) => readTool.run(input, ctx);

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

  test("subject and schema", () => {
    expect(readTool.subject({ file_path: "a.ts" }, dir)).toEqual({ paths: [join(dir, "a.ts")] });
    const schema = toInputSchema(readTool.schema);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["file_path"]);
    expect("$schema" in schema).toBe(false);
  });
});
