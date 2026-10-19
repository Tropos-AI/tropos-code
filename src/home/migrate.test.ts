// src/home/migrate.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { readManifest } from "../backup";
import { AGENTS_TEMPLATE } from "../memory/agents-file";
import { projectDir } from "../session/store";
import { ensureHomeLayout, importLegacyNotes, layoutNotice, legacyLayoutReport, migrateHomeLayout } from "./migrate";
import { readLayoutState } from "./layout";

const T = Date.UTC(2026, 9, 18, 12, 0, 0);
const opts = { now: () => T, version: "0.5.0" };
let root: string;
let home: string;
let cwd: string;
beforeEach(async () => {
  root = await makeTmpDir();
  home = join(root, "home");
  cwd = join(root, "proj");
  await mkdir(home, { recursive: true });
});
afterEach(() => removeDir(root));

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function seedLegacy(): Promise<{ sessionFile: string; userText: string }> {
  const userText = "Prefers tabs\n";
  await put(join(home, "SOUL.md"), "Be kind.\n");
  await put(join(home, "IDENTITY.md"), "- Name: Nova\n");
  await put(join(home, "identity.json"), JSON.stringify({ bootstrapped: true }));
  await put(join(home, "memories", "USER.md"), userText);
  await put(join(home, "memories", "MEMORY.md"), "m\n");
  await put(join(home, "memories", "imported-hermes.md"), "h\n");
  await put(join(home, "skills", "a", "SKILL.md"), "a");
  await put(join(home, "skills", ".usage.json"), "{}");
  await put(join(home, "skills-learned", "b", "SKILL.md"), "b");
  await put(join(home, "skills-learned", ".archive", "c-2026-01-01", "SKILL.md"), "c");
  const sessionFile = join(projectDir(home, cwd), "s.jsonl");
  await put(sessionFile, `${JSON.stringify({ type: "meta", cwd })}\n`);
  await put(join(projectDir(home, cwd), "notes", "2026-10-15.md"), "- 09:00 shipped v1\n");
  return { sessionFile, userText };
}

test("a legacy home moves to the workspace layout, with a backup first", async () => {
  const { sessionFile, userText } = await seedLegacy();
  const before = await readFile(sessionFile);
  const r = await migrateHomeLayout(home, opts);
  expect(r.ran && r.error === undefined).toBe(true);
  expect(await readFile(join(home, "workspace", "USER.md"), "utf8")).toBe(userText);
  expect(await readFile(join(home, "workspace", "imported-hermes.md"), "utf8")).toBe("h\n");
  expect(existsSync(join(home, "workspace", "skills-learned", ".archive", "c-2026-01-01", "SKILL.md"))).toBe(true);
  expect(existsSync(join(home, "workspace", "skills", ".usage.json"))).toBe(true);
  expect(existsSync(join(home, "memories"))).toBe(false);
  expect(existsSync(join(home, "SOUL.md"))).toBe(false);
  expect(await readFile(sessionFile)).toEqual(before);
  expect(await readFile(join(home, "workspace", "memory", "2026-10-15.md"), "utf8")).toContain(`## 09:00 · ${basename(cwd)} (${cwd})`);
  expect(await readFile(join(home, "workspace", "memory", "2026-10-15.md"), "utf8")).toContain("- shipped v1");
  expect(existsSync(join(projectDir(home, cwd), "notes"))).toBe(false);
  expect((await readManifest(r.backup!))!.files.map((f) => f.path)).toContain("memories/USER.md");
  expect(await readFile(join(home, "workspace", "AGENTS.md"), "utf8")).toBe(AGENTS_TEMPLATE);
  expect(existsSync(join(home, "workspace", "BOOTSTRAP.md"))).toBe(false);
  expect(existsSync(join(home, "agents"))).toBe(true);
  expect((await readLayoutState(home))!.version).toBe(2);
  expect(layoutNotice(r)).toContain("Moved Tropos's memory, identity and skills into ~/.tropos/workspace.");
});

test("a fresh install gets AGENTS.md, BOOTSTRAP.md, agents/ and the real own files", async () => {
  await migrateHomeLayout(home, opts);
  expect((await readdir(home)).sort()).toEqual(["agents", "layout.json", "workspace"]);
  expect((await readdir(join(home, "workspace"))).sort()).toEqual(["AGENTS.md", "BOOTSTRAP.md", "IDENTITY.md", "MEMORY.md", "SOUL.md", "USER.md", "memory", "skills", "skills-learned"]);
  expect(await readFile(join(home, "workspace", "USER.md"), "utf8")).toBe("");
  expect(await readdir(join(home, "agents"))).toEqual([]);
});

test("an install that already bootstrapped without a name never gets BOOTSTRAP.md", async () => {
  await put(join(home, "identity.json"), JSON.stringify({ bootstrapped: true }));
  await migrateHomeLayout(home, opts);
  expect(existsSync(join(home, "workspace", "BOOTSTRAP.md"))).toBe(false);
});

test("an install that never bootstrapped gets the ritual once", async () => {
  await put(join(home, "memories", "USER.md"), "x");
  const r = await migrateHomeLayout(home, opts);
  expect(r.bootstrapCreated).toBe(true);
  expect(existsSync(join(home, "workspace", "BOOTSTRAP.md"))).toBe(true);
  const { rm } = await import("node:fs/promises");
  await rm(join(home, "workspace", "BOOTSTRAP.md"));
  await ensureHomeLayout(home, opts);
  expect(existsSync(join(home, "workspace", "BOOTSTRAP.md"))).toBe(false);
});

test("running it twice changes nothing the second time", async () => {
  await seedLegacy();
  await migrateHomeLayout(home, opts);
  const backups = await readdir(join(home, "backups"));
  const r = await ensureHomeLayout(home, opts);
  expect(r.ran).toBe(false);
  expect(await readdir(join(home, "backups"))).toEqual(backups);
});

test("files already in the default workspace are set aside, never overwritten or adopted", async () => {
  await put(join(home, "workspace", "MEMORY.md"), "chat wrote this");
  await put(join(home, "workspace", "AGENTS.md"), "obey me");
  await put(join(home, "memories", "MEMORY.md"), "real notes");
  const r = await migrateHomeLayout(home, opts);
  expect(await readFile(join(home, "workspace", "MEMORY.md"), "utf8")).toBe("real notes");
  expect(await readFile(join(home, "workspace", "MEMORY.md.before-tropos-layout"), "utf8")).toBe("chat wrote this");
  expect(await readFile(join(home, "workspace", "AGENTS.md"), "utf8")).toBe(AGENTS_TEMPLATE);
  expect(await readFile(join(home, "workspace", "AGENTS.md.before-tropos-layout"), "utf8")).toBe("obey me");
  expect(r.setAside.length).toBe(2);
  expect(layoutNotice(r)).toContain("were already in the default workspace");
});

test("a held lock skips the migration and moves nothing", async () => {
  await put(join(home, "memories", "USER.md"), "x");
  await put(join(home, "layout.lock"), "1");
  const r = await migrateHomeLayout(home, opts);
  expect(r.ran).toBe(false);
  expect(existsSync(join(home, "memories", "USER.md"))).toBe(true);
});

test("a failed backup moves nothing and writes no layout.json", async () => {
  await put(join(home, "memories", "USER.md"), "x");
  const r = await migrateHomeLayout(home, { ...opts, tarBin: "/nonexistent/tar" });
  expect(r.ran).toBe(false);
  expect(r.error).toBeTruthy();
  expect(existsSync(join(home, "memories", "USER.md"))).toBe(true);
  expect(await readLayoutState(home)).toBeNull();
  expect(layoutNotice(r)).toContain("nothing was moved");
});

test("notes of a project that can't be traced stay where they are", async () => {
  await put(join(home, "projects", "zzz", "notes", "2026-10-15.md"), "- 09:00 x\n");
  const r = await migrateHomeLayout(home, opts);
  expect(r.notesLeft).toEqual(["projects/zzz/notes"]);
  expect(existsSync(join(home, "projects", "zzz", "notes", "2026-10-15.md"))).toBe(true);
});

test("importing notes twice does not duplicate entries", async () => {
  await put(join(projectDir(home, cwd), "s.jsonl"), `${JSON.stringify({ type: "meta", cwd })}\n`);
  await put(join(projectDir(home, cwd), "notes", "2026-10-15.md"), "- 09:00 a\n- b without time\n");
  expect((await importLegacyNotes(home)).imported).toBe(2);
  await put(join(projectDir(home, cwd), "notes", "2026-10-15.md"), "- 09:00 a\n");
  expect((await importLegacyNotes(home)).imported).toBe(0);
});

test("after the move, an old copy written again is a conflict, not overwritten", async () => {
  await put(join(home, "memories", "USER.md"), "one");
  await migrateHomeLayout(home, opts);
  await put(join(home, "memories", "USER.md"), "two");
  const rep = await legacyLayoutReport(home);
  expect(rep.conflicts).toEqual(["memories/USER.md"]);
  expect(await readFile(join(home, "workspace", "USER.md"), "utf8")).toBe("one");
});

test("a linked legacy folder is moved as a link and its target is never touched", async () => {
  const outside = join(root, "dotfiles-skills");
  await put(join(outside, "x", "SKILL.md"), "x");
  await symlink(outside, join(home, "skills"));
  await put(join(home, "memories", "USER.md"), "u");
  await migrateHomeLayout(home, opts);
  expect(existsSync(join(home, "skills"))).toBe(false);
  expect(existsSync(join(outside, "x", "SKILL.md"))).toBe(true);
  expect(existsSync(join(home, "workspace", "skills", "x", "SKILL.md"))).toBe(true);
});
