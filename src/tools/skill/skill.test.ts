import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { makeToolContext } from "../../../test/helpers/tool-context";
import type { Skill } from "../../extensions/skills";
import { createSkillTool } from "./skill";

let dir: string;
let skills: Skill[];
beforeEach(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "deploy"));
  await writeFile(join(dir, "deploy", "SKILL.md"), "x");
  const base = { source: "user" as const, userInvocable: true, body: "Deploy from ${TROPOS_SKILL_DIR}" };
  skills = [
    { ...base, name: "deploy", description: "Deploy", dir: join(dir, "deploy"), path: join(dir, "deploy", "SKILL.md"), modelInvocable: true },
    { ...base, name: "secret", description: "User only", dir: join(dir, "secret"), path: join(dir, "secret", "SKILL.md"), modelInvocable: false },
  ];
});
afterEach(() => removeDir(dir));

test("the Skill tool is a meta tool whose permission target is the skill name", () => {
  const tool = createSkillTool(skills);
  expect(tool.name).toBe("Skill");
  expect(tool.kind).toBe("meta");
  expect(tool.description).not.toContain("deploy");
  expect(tool.subject({ skill: "/deploy" }, dir)).toEqual({ paths: [], target: "deploy" });
  expect(tool.summarize({ skill: "deploy" })).toBe("deploy");
  expect(tool.schema.safeParse({ skill: "" }).success).toBe(false);
});

test("renders a known skill with its arguments", async () => {
  const out = await createSkillTool(skills).run({ skill: "deploy", args: "prod" }, makeToolContext({ root: dir }));
  expect(out.isError).toBeUndefined();
  expect(out.content).toBe(`<skill name="deploy" source="user" dir="${join(dir, "deploy")}">\nDeploy from ${join(dir, "deploy")}\n</skill>\n\nArguments: prod`);
  expect(out.summary).toBe("loaded deploy");
});

test("refuses unknown and user-only skills, listing the available ones", async () => {
  const tool = createSkillTool(skills);
  const ctx = makeToolContext({ root: dir });
  const unknown = await tool.run({ skill: "nope" }, ctx);
  expect(unknown).toEqual({ content: 'Unknown skill "nope". Available skills: deploy', isError: true });
  const userOnly = await tool.run({ skill: "secret" }, ctx);
  expect(userOnly.isError).toBe(true);
  expect(userOnly.content).toBe('Skill "secret" can only be run by the user (/secret). Available skills: deploy');
  const none = await createSkillTool([]).run({ skill: "x" }, ctx);
  expect(none.content).toBe('Unknown skill "x". No skills are available.');
});

test("a skill that fails to render is an error result", async () => {
  const broken = { ...skills[0]!, body: null as unknown as string };
  const out = await createSkillTool([broken]).run({ skill: "deploy" }, makeToolContext({ root: dir }));
  expect(out.isError).toBe(true);
  expect(out.content).toStartWith("Cannot load skill deploy:");
});
