import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";
import { projectsHandlers } from "./projects";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.close());
const admin = () => adminWith(kit, projectsHandlers(kit.ctx));

test("list starts with the built-in default; add registers a folder, reloads the gateway and marks git repos", async () => {
  const a = admin();
  const first = (await a.handle("projects.list", undefined)) as any[];
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ id: "default", builtin: true, isDefault: true, gitRepo: false });
  const dir = join(kit.root, "work", "app");
  await mkdir(join(dir, ".git"), { recursive: true });
  const added = (await a.handle("projects.add", { path: dir, name: "My App" })) as any;
  expect(added).toMatchObject({ id: "my-app", name: "My App", path: dir, isDefault: false, gitRepo: true });
  expect(kit.reloads).toBe(1);
  expect(await failure(a, "projects.add", { path: dir })).toContain("already the project");
  expect(await failure(a, "projects.add", { path: join(kit.root, "nope") })).toContain("doesn't exist");
  expect(await failure(a, "projects.add", { path: " " })).toContain("Choose a folder");
});

test("setDefault returns the list with the new default; remove falls back to the built-in", async () => {
  const a = admin();
  const dir = join(kit.root, "w");
  await mkdir(dir, { recursive: true });
  const { id } = (await a.handle("projects.add", { path: dir })) as any;
  const list = (await a.handle("projects.setDefault", { id })) as any[];
  expect(list.find((p) => p.id === id).isDefault).toBe(true);
  expect(list.find((p) => p.id === "default").isDefault).toBe(false);
  expect(await a.handle("projects.remove", { id })).toEqual({ removed: true });
  expect(((await a.handle("projects.list", undefined)) as any[]).find((p) => p.isDefault).id).toBe("default");
  expect(await failure(a, "projects.remove", { id: "default" })).toContain("can't be removed");
  expect(await failure(a, "projects.remove", { id })).toContain("no project");
  expect(await failure(a, "projects.setDefault", { id: "ghost" })).toContain("no project");
  expect(kit.reloads).toBe(3);
});

test("browse lists only real directories, starting at the user's home, hiding dot-folders and symlinks", async () => {
  const a = admin();
  await mkdir(join(kit.userHome, "beta", ".git"), { recursive: true });
  await mkdir(join(kit.userHome, "Alpha"), { recursive: true });
  await mkdir(join(kit.userHome, ".hidden"), { recursive: true });
  await writeFile(join(kit.userHome, "file.txt"), "x");
  await symlink(join(kit.userHome, "Alpha"), join(kit.userHome, "link"));
  const res = (await a.handle("projects.browse", undefined)) as any;
  expect(res.path).toBe(kit.userHome);
  expect(res.parent).toBe(kit.root);
  expect(res.entries).toEqual([
    { name: "Alpha", path: join(kit.userHome, "Alpha"), isGitRepo: false },
    { name: "beta", path: join(kit.userHome, "beta"), isGitRepo: true },
  ]);
});

test("browse canonicalises, refuses files and missing paths, caps at 500 and has no parent at /", async () => {
  const a = admin();
  await mkdir(join(kit.userHome, "d"), { recursive: true });
  await writeFile(join(kit.userHome, "f"), "x");
  const viaDots = (await a.handle("projects.browse", { path: join(kit.userHome, "d", "..", "d") })) as any;
  expect(viaDots.path).toBe(join(kit.userHome, "d"));
  expect(await failure(a, "projects.browse", { path: join(kit.userHome, "f") })).toContain("file");
  expect(await failure(a, "projects.browse", { path: join(kit.userHome, "missing") })).toContain("doesn't exist");
  const many = join(kit.root, "many");
  await mkdir(many);
  await Promise.all(Array.from({ length: 520 }, (_, i) => mkdir(join(many, `d${String(i).padStart(3, "0")}`))));
  expect(((await a.handle("projects.browse", { path: many })) as any).entries).toHaveLength(500);
  expect(((await a.handle("projects.browse", { path: "/" })) as any).parent).toBeNull();
});
