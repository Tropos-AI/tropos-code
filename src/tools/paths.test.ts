// src/tools/paths.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { PathResolutionError, resolveToolPath } from "./paths";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "proj", "src"), { recursive: true });
  await mkdir(join(dir, "outside"));
  await writeFile(join(dir, "outside", "secret.txt"), "s");
  await writeFile(join(dir, "proj", "plain.txt"), "p");
  await symlink(join(dir, "outside"), join(dir, "proj", "link"));
  await symlink(join(dir, "outside", "secret.txt"), join(dir, "proj", "file-link"));
  await symlink(join(dir, "outside", "missing.txt"), join(dir, "proj", "dangling"));
  // Relative links: a dir link into outside/, and a dangling link whose relative target only makes sense from outside/.
  await symlink("../outside", join(dir, "proj", "dirlink"));
  await symlink("../rel-ghost", join(dir, "outside", "relghost"));
  // A 12-link chain whose last hop is an absolute target outside the project.
  for (let i = 0; i < 11; i++) await symlink(`chain${i + 1}`, join(dir, "proj", `chain${i}`));
  await symlink(join(dir, "outside", "end.txt"), join(dir, "proj", "chain11"));
  // A two-link loop.
  await symlink("loopB", join(dir, "proj", "loopA"));
  await symlink("loopA", join(dir, "proj", "loopB"));
});
afterAll(() => removeDir(dir));

describe("resolveToolPath", () => {
  test("relative paths resolve against cwd", () => {
    expect(resolveToolPath("src/a.ts", join(dir, "proj"))).toBe(join(dir, "proj", "src", "a.ts"));
  });
  test("absolute paths stay absolute", () => {
    expect(resolveToolPath(join(dir, "proj", "src"), "/")).toBe(join(dir, "proj", "src"));
  });
  test("'.' and empty segments are skipped, '..' without links is lexical", () => {
    expect(resolveToolPath("./src//../src/./a.ts", join(dir, "proj"))).toBe(join(dir, "proj", "src", "a.ts"));
    expect(resolveToolPath("../outside/secret.txt", join(dir, "proj"))).toBe(join(dir, "outside", "secret.txt"));
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
  test("'..' after a symlink climbs from the link's target, as the OS does", () => {
    expect(resolveToolPath("link/../x", join(dir, "proj"))).toBe(join(dir, "x"));
  });
  test("a relative dangling link inside a symlinked dir resolves from its real parent", () => {
    expect(resolveToolPath("dirlink/relghost", join(dir, "proj"))).toBe(join(dir, "rel-ghost"));
  });
  test("a dangling chain longer than 10 links still resolves to its final target", () => {
    expect(resolveToolPath("chain0", join(dir, "proj"))).toBe(join(dir, "outside", "end.txt"));
  });
  test("a symlink loop throws PathResolutionError", () => {
    expect(() => resolveToolPath("loopA", join(dir, "proj"))).toThrow(PathResolutionError);
  });
  test("a non-ENOENT lstat failure throws PathResolutionError", () => {
    expect(() => resolveToolPath("plain.txt/child", join(dir, "proj"))).toThrow(PathResolutionError);
  });
  test("~ expands to the home directory", () => {
    expect(resolveToolPath("~/x", "/")).toBe(join(homedir(), "x"));
  });
});
