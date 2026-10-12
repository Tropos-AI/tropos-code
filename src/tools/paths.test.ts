// src/tools/paths.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { resolveToolPath } from "./paths";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "proj", "src"), { recursive: true });
  await mkdir(join(dir, "outside"));
  await writeFile(join(dir, "outside", "secret.txt"), "s");
  await symlink(join(dir, "outside"), join(dir, "proj", "link"));
  await symlink(join(dir, "outside", "secret.txt"), join(dir, "proj", "file-link"));
  await symlink(join(dir, "outside", "missing.txt"), join(dir, "proj", "dangling"));
});
afterAll(() => removeDir(dir));

describe("resolveToolPath", () => {
  test("relative paths resolve against cwd", () => {
    expect(resolveToolPath("src/a.ts", join(dir, "proj"))).toBe(join(dir, "proj", "src", "a.ts"));
  });
  test("absolute paths stay absolute", () => {
    expect(resolveToolPath(join(dir, "proj", "src"), "/")).toBe(join(dir, "proj", "src"));
  });
  test("a symlinked directory resolves to its target, even for new files", () => {
    expect(resolveToolPath("link/new/deep.ts", join(dir, "proj"))).toBe(join(dir, "outside", "new", "deep.ts"));
  });
  test("a symlinked file resolves to its target", () => {
    expect(resolveToolPath("file-link", join(dir, "proj"))).toBe(join(dir, "outside", "secret.txt"));
  });
  test("a dangling symlink resolves to where it points", () => {
    expect(resolveToolPath("dangling", join(dir, "proj"))).toBe(join(dir, "outside", "missing.txt"));
  });
  test("~ expands to the home directory", () => {
    expect(resolveToolPath("~/x", "/")).toEndWith("/x");
  });
});
