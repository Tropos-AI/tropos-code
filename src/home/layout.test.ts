// src/home/layout.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { LAYOUT_VERSION, legacyToCurrent, readLayoutState, resolveLayoutPath, workspaceOwnPaths, writeLayoutState } from "./layout";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

test("resolveLayoutPath falls back only when the legacy path alone exists", async () => {
  expect(resolveLayoutPath(home, "USER.md")).toBe(join(home, "workspace", "USER.md"));
  await put(join(home, "memories", "USER.md"), "x");
  expect(resolveLayoutPath(home, "USER.md")).toBe(join(home, "memories", "USER.md"));
  await put(join(home, "workspace", "USER.md"), "y");
  expect(resolveLayoutPath(home, "USER.md")).toBe(join(home, "workspace", "USER.md"));
});

test("resolveLayoutPath covers root files and skill folders", async () => {
  await put(join(home, "SOUL.md"), "s");
  await put(join(home, "skills-learned", "a", "SKILL.md"), "k");
  expect(resolveLayoutPath(home, "SOUL.md")).toBe(join(home, "SOUL.md"));
  expect(resolveLayoutPath(home, "skills-learned")).toBe(join(home, "skills-learned"));
  expect(resolveLayoutPath(home, "skills")).toBe(join(home, "workspace", "skills"));
  expect(resolveLayoutPath(home, "IDENTITY.md")).toBe(join(home, "workspace", "IDENTITY.md"));
});

test("legacyToCurrent", () => {
  expect(legacyToCurrent("memories/USER.md")).toBe("workspace/USER.md");
  expect(legacyToCurrent("memories/imported-hermes.md")).toBe("workspace/imported-hermes.md");
  // Nothing else in memories/ may be mapped onto an instruction file.
  expect(legacyToCurrent("memories/AGENTS.md")).toBeUndefined();
  expect(legacyToCurrent("memories/BOOTSTRAP.md")).toBeUndefined();
  expect(legacyToCurrent("SOUL.md")).toBe("workspace/SOUL.md");
  expect(legacyToCurrent("SOUL.imported.md")).toBe("workspace/SOUL.imported.md");
  expect(legacyToCurrent("skills/a/SKILL.md")).toBe("workspace/skills/a/SKILL.md");
  expect(legacyToCurrent("skills-learned/.archive/b-2026-01-01/SKILL.md")).toBe("workspace/skills-learned/.archive/b-2026-01-01/SKILL.md");
  expect(legacyToCurrent("TROPOS.md")).toBeUndefined();
  expect(legacyToCurrent("projects/k/notes/2026-10-15.md")).toBeUndefined();
});

test("workspaceOwnPaths never includes the workspace itself", () => {
  expect(workspaceOwnPaths("/h")).not.toContain("/h/workspace");
  expect(workspaceOwnPaths("/h")).toHaveLength(9);
});

test("layout state round-trips, owner-only; a corrupt file reads as null", async () => {
  expect(await readLayoutState(home)).toBeNull();
  const state = { version: LAYOUT_VERSION, migratedAt: "2026-10-16T00:00:00.000Z", backup: "backups/x.tar.gz" };
  await writeLayoutState(home, state);
  expect(await readLayoutState(home)).toEqual(state);
  expect(((await Bun.file(join(home, "layout.json")).stat()).mode & 0o777)).toBe(0o600);
  await writeFile(join(home, "layout.json"), "{nope");
  expect(await readLayoutState(home)).toBeNull();
});
