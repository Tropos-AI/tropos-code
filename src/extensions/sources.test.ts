import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { extensionDirs, projectChain, qualifiedName, staysInProject } from "./sources";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

test("outside git only cwd is searched", () => {
  expect(projectChain(dir)).toEqual([dir]);
});

test("inside git the chain climbs to the root, nearest first", async () => {
  await mkdir(join(dir, "repo", ".git"), { recursive: true });
  await mkdir(join(dir, "repo", "a", "b"), { recursive: true });
  expect(projectChain(join(dir, "repo", "a", "b"))).toEqual([join(dir, "repo", "a", "b"), join(dir, "repo", "a"), join(dir, "repo")]);
});

test("user, then learned (skills only), then project, then plugin directories", () => {
  const dirs = extensionDirs("skills", { cwd: dir, home: "/h", plugins: [{ name: "p", root: "/plugins/p" }] });
  expect(dirs).toEqual([
    { dir: "/h/skills", source: "user" },
    { dir: "/h/skills-learned", source: "learned" },
    { dir: join(dir, ".tropos", "skills"), source: "project", root: dir },
    { dir: join(dir, ".claude", "skills"), source: "project", root: dir },
    { dir: join(dir, ".agents", "skills"), source: "project", root: dir },
    { dir: "/plugins/p/skills", source: "plugin", plugin: "p" },
  ]);
  expect(extensionDirs("commands", { cwd: dir, home: "/h" }).map((d) => d.dir)).toEqual([
    "/h/commands",
    join(dir, ".tropos", "commands"),
    join(dir, ".claude", "commands"),
  ]);
  expect(qualifiedName(dirs[5]!, "x")).toBe("p:x");
  expect(qualifiedName(dirs[0]!, "x")).toBe("x");
});

test("project files must really live inside the project", async () => {
  const project = join(dir, "proj");
  await mkdir(join(project, ".tropos", "commands"), { recursive: true });
  await writeFile(join(dir, "secret"), "s");
  await writeFile(join(project, ".tropos", "commands", "ok.md"), "x");
  await symlink(join(dir, "secret"), join(project, ".tropos", "commands", "leak.md"));
  const projectDir = { dir: join(project, ".tropos", "commands"), source: "project" as const, root: project };
  expect(await staysInProject(projectDir, join(project, ".tropos", "commands", "ok.md"))).toBe(true);
  expect(await staysInProject(projectDir, join(project, ".tropos", "commands", "leak.md"))).toBe(false);
  expect(await staysInProject(projectDir, join(project, "missing.md"))).toBe(false);
  expect(await staysInProject({ dir: "/h", source: "user" }, join(dir, "secret"))).toBe(true);
});
