import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { createSkillManageTool, MAX_SKILL_FILE_CHARS } from "./skill-manage";

let home: string;
let outside: string;

const SKILL = "---\ndescription: Release the app.\n---\n# Release\n1. Bump version\n2. Tag\n";

beforeEach(async () => {
  home = await makeTmpDir();
  outside = await makeTmpDir();
});

afterEach(async () => {
  await removeDir(home);
  await removeDir(outside);
});

const ctx = () => makeToolContext();

async function make(name = "release") {
  const tool = createSkillManageTool({ home });
  const out = await tool.run({ action: "create", name, content: SKILL }, ctx());
  expect(out.isError).toBeUndefined();
  return tool;
}

test("metadata, name validation and subject paths", () => {
  const tool = createSkillManageTool({ home });
  expect(tool.name).toBe("SkillManage");
  expect(tool.kind).toBe("edit");
  expect(tool.summarize({ action: "write_file", name: "x", file_path: "a.sh" })).toBe("write_file x/a.sh");
  expect(tool.summarize({ action: "delete", name: "x" })).toBe("delete x");
  expect(tool.schema.safeParse({ action: "create", name: "Bad_Name" }).success).toBe(false);
  expect(tool.schema.safeParse({ action: "create", name: "a--b" }).success).toBe(false);
  expect(tool.schema.safeParse({ action: "create", name: "a".repeat(65) }).success).toBe(false);
  expect(tool.schema.safeParse({ action: "create", name: "ok-2" }).success).toBe(true);
  expect(tool.subject({ action: "create", name: "ok" }, "/")).toEqual({ paths: [join(home, "skills", "ok", "SKILL.md")] });
  expect(tool.subject({ action: "patch", name: "ok", file_path: "ref/a.md" }, "/")).toEqual({ paths: [join(home, "skills", "ok", "ref", "a.md")] });
  expect(tool.subject({ action: "delete", name: "ok" }, "/")).toEqual({ paths: [join(home, "skills", "ok")] });
  expect(tool.subject({ action: "write_file", name: "ok", file_path: "../x" }, "/")).toEqual({ paths: [join(home, "skills", "ok")] });
});

test("create writes SKILL.md and refuses an existing skill", async () => {
  const tool = await make();
  expect(await readFile(join(home, "skills", "release", "SKILL.md"), "utf8")).toBe(SKILL);
  const again = await tool.run({ action: "create", name: "release", content: SKILL }, ctx());
  expect(again.isError).toBe(true);
  expect(again.content).toContain("already exists");
});

test("create validates content", async () => {
  const tool = createSkillManageTool({ home });
  expect((await tool.run({ action: "create", name: "a" }, ctx())).content).toContain("needs content");
  const noFm = await tool.run({ action: "create", name: "a", content: "# just a body" }, ctx());
  expect(noFm.content).toContain("non-empty description");
  const empty = await tool.run({ action: "create", name: "a", content: "---\ndescription: \n---\nbody" }, ctx());
  expect(empty.isError).toBe(true);
  const huge = await tool.run({ action: "create", name: "a", content: `---\ndescription: x\n---\n${"y".repeat(MAX_SKILL_FILE_CHARS)}` }, ctx());
  expect(huge.content).toContain("over");
  expect(existsSync(join(home, "skills", "a"))).toBe(false);
});

test("patch replaces uniquely or all, and keeps SKILL.md valid", async () => {
  const tool = await make();
  const out = await tool.run({ action: "patch", name: "release", old_string: "Tag", new_string: "Tag and push" }, ctx());
  expect(out.content).toContain("1 replacement");
  expect(out.display).toMatchObject({ kind: "diff", added: 1, removed: 1 });
  expect(await readFile(join(home, "skills", "release", "SKILL.md"), "utf8")).toContain("2. Tag and push");

  const dup = await tool.run({ action: "patch", name: "release", old_string: "Re", new_string: "re" }, ctx());
  expect(dup.content).toContain("appears");
  const all = await tool.run({ action: "patch", name: "release", old_string: "Re", new_string: "R$&e", replace_all: true }, ctx());
  expect(all.content).toContain("2 replacements");
  expect(await readFile(join(home, "skills", "release", "SKILL.md"), "utf8")).toContain("R$&elease the app.");

  const broken = await tool.run({ action: "patch", name: "release", old_string: "description:", new_string: "summary:" }, ctx());
  expect(broken.content).toStartWith("Not saved:");

  expect((await tool.run({ action: "patch", name: "release", old_string: "nope", new_string: "x" }, ctx())).content).toContain("not found");
  expect((await tool.run({ action: "patch", name: "release", old_string: "x" }, ctx())).content).toContain("needs old_string and new_string");
  expect((await tool.run({ action: "patch", name: "release", old_string: "", new_string: "x" }, ctx())).content).toContain("empty");
  expect((await tool.run({ action: "patch", name: "release", old_string: "x", new_string: "x" }, ctx())).content).toContain("identical");
  const big = await tool.run({ action: "patch", name: "release", old_string: "Bump", new_string: "b".repeat(MAX_SKILL_FILE_CHARS) }, ctx());
  expect(big.content).toContain("over");
});

test("patch on a missing skill or file", async () => {
  const tool = createSkillManageTool({ home });
  const out = await tool.run({ action: "patch", name: "ghost", old_string: "a", new_string: "b" }, ctx());
  expect(out.content).toContain("No skill named ghost");
  await make();
  const missing = await tool.run({ action: "patch", name: "release", file_path: "x.md", old_string: "a", new_string: "b" }, ctx());
  expect(missing.content).toContain("x.md does not exist");
});

test("write_file creates nested files inside the skill only", async () => {
  const tool = await make();
  const out = await tool.run({ action: "write_file", name: "release", file_path: "scripts/./bump.sh", file_content: "echo hi\n" }, ctx());
  expect(out.isError).toBeUndefined();
  expect(await readFile(join(home, "skills", "release", "scripts", "bump.sh"), "utf8")).toBe("echo hi\n");
  const patched = await tool.run({ action: "patch", name: "release", file_path: "scripts/bump.sh", old_string: "hi", new_string: "bye" }, ctx());
  expect(patched.isError).toBeUndefined();

  for (const bad of ["../other/x", "/etc/passwd", "~/x", "", "a/../..", "dir/"]) {
    const res = await tool.run({ action: "write_file", name: "release", file_path: bad, file_content: "x" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toStartWith("Cannot write_file skill release:");
  }
  expect((await tool.run({ action: "write_file", name: "release", file_path: "a" }, ctx())).content).toContain("needs file_path");
  expect((await tool.run({ action: "write_file", name: "nope", file_path: "a", file_content: "x" }, ctx())).content).toContain("No skill");
  const huge = await tool.run({ action: "write_file", name: "release", file_path: "a", file_content: "x".repeat(MAX_SKILL_FILE_CHARS + 1) }, ctx());
  expect(huge.content).toContain("over");
});

test("write_file to SKILL.md must keep the description", async () => {
  const tool = await make();
  const bad = await tool.run({ action: "write_file", name: "release", file_path: "SKILL.md", file_content: "plain" }, ctx());
  expect(bad.content).toStartWith("Not saved:");
  const good = await tool.run({ action: "write_file", name: "release", file_path: "SKILL.md", file_content: SKILL.replace("Release the app", "Ship") }, ctx());
  expect(good.display).toMatchObject({ kind: "diff", added: 1, removed: 1 });
});

test("symlinks out of the skill folder are refused", async () => {
  const tool = await make();
  await symlink(outside, join(home, "skills", "release", "link"));
  const out = await tool.run({ action: "write_file", name: "release", file_path: "link/x.txt", file_content: "x" }, ctx());
  expect(out.content).toContain("resolves outside the skill folder");
  expect(existsSync(join(outside, "x.txt"))).toBe(false);

  await writeFile(join(outside, "SKILL.md"), SKILL);
  await symlink(outside, join(home, "skills", "linked"));
  const del = await tool.run({ action: "delete", name: "linked" }, ctx());
  expect(del.content).toContain("resolves outside");
  expect(existsSync(join(outside, "SKILL.md"))).toBe(true);
});

test("a symlinked skill folder inside the skills root is not deleted", async () => {
  const tool = await make();
  await symlink(join(home, "skills", "release"), join(home, "skills", "alias"));
  const out = await tool.run({ action: "delete", name: "alias" }, ctx());
  expect(out.content).toContain("not a plain skill folder");
  expect(existsSync(join(home, "skills", "release", "SKILL.md"))).toBe(true);
});

test("delete removes the skill, only when it has SKILL.md", async () => {
  const tool = await make();
  await mkdir(join(home, "skills", "junk"), { recursive: true });
  expect((await tool.run({ action: "delete", name: "junk" }, ctx())).content).toContain("No skill named junk");
  const out = await tool.run({ action: "delete", name: "release" }, ctx());
  expect(out.summary).toBe("deleted");
  expect(existsSync(join(home, "skills", "release"))).toBe(false);
});

test("approved paths must match", async () => {
  const tool = createSkillManageTool({ home });
  const out = await tool.run({ action: "create", name: "x", content: SKILL }, makeToolContext({ approvedPaths: ["/elsewhere"] }));
  expect(out.content).toContain("changed after it was approved");
  const ok = await tool.run(
    { action: "create", name: "x", content: SKILL },
    makeToolContext({ approvedPaths: [join(home, "skills", "x", "SKILL.md")] }),
  );
  expect(ok.isError).toBeUndefined();
});

test("disk errors become error results", async () => {
  const tool = await make();
  await mkdir(join(home, "skills", "release", "dir.md"));
  const out = await tool.run({ action: "patch", name: "release", file_path: "dir.md", old_string: "a", new_string: "b" }, ctx());
  expect(out.isError).toBe(true);
  expect(out.content).toStartWith("Cannot patch skill release:");
});
