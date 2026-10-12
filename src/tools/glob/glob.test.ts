import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { globTool } from "./glob";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "src", "deep"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "src", "old.ts"), "");
  await writeFile(join(dir, "src", "deep", "new.ts"), "");
  await writeFile(join(dir, "node_modules", "pkg", "index.ts"), "");
  await writeFile(join(dir, "readme.md"), "");
  const past = new Date(Date.now() - 60_000);
  await utimes(join(dir, "src", "old.ts"), past, past);
});
afterAll(() => removeDir(dir));

describe("Glob", () => {
  test("finds files, newest first, skipping node_modules", async () => {
    const out = await globTool.run({ pattern: "**/*.ts" }, makeToolContext({ root: dir }));
    expect(String(out.content).split("\n")).toEqual([join(dir, "src", "deep", "new.ts"), join(dir, "src", "old.ts")]);
    expect(out.summary).toBe("2 files");
  });

  test("node_modules is searched when the pattern names it", async () => {
    const out = await globTool.run({ pattern: "node_modules/**/*.ts" }, makeToolContext({ root: dir }));
    expect(out.content).toBe(join(dir, "node_modules", "pkg", "index.ts"));
  });

  test("path narrows the search", async () => {
    const out = await globTool.run({ pattern: "*.ts", path: "src/deep" }, makeToolContext({ root: dir }));
    expect(out.content).toBe(join(dir, "src", "deep", "new.ts"));
  });

  test("no matches", async () => {
    expect((await globTool.run({ pattern: "*.py" }, makeToolContext({ root: dir }))).content).toBe("No files matched.");
  });

  test("missing directory is an error", async () => {
    expect((await globTool.run({ pattern: "*", path: "nope" }, makeToolContext({ root: dir }))).isError).toBe(true);
  });

  test("a symlink loop as path returns an error result instead of throwing", async () => {
    const loopDir = await makeTmpDir();
    try {
      await symlink(join(loopDir, "loopB"), join(loopDir, "loopA"));
      await symlink(join(loopDir, "loopA"), join(loopDir, "loopB"));
      const out = await globTool.run({ pattern: "*", path: "loopA" }, makeToolContext({ root: loopDir }));
      expect(out.isError).toBe(true);
    } finally {
      await removeDir(loopDir);
    }
  });
});
