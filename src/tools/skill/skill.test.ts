import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { makeToolContext } from "../../../test/helpers/tool-context";
import type { Skill } from "../../extensions/skills";
import { SkillTracker } from "../../learning/skill-tracker";
import { readSkillUsage } from "../../learning/skill-usage";
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

test("a successful load marks the skill viewed and records its use; failures don't", async () => {
  const tracker = new SkillTracker();
  const tool = createSkillTool(skills, { home: dir, tracker });
  await tool.run({ skill: "deploy" }, makeToolContext({ root: dir }));
  expect(tracker.hasViewed("deploy")).toBe(true);
  // The usage write is fire-and-forget: poll until it lands.
  let uses: number | undefined;
  for (let i = 0; i < 200 && uses === undefined; i++) {
    uses = (await readSkillUsage(dir)).deploy?.uses;
    if (uses === undefined) await Bun.sleep(5);
  }
  expect(uses).toBe(1);
  await tool.run({ skill: "secret" }, makeToolContext({ root: dir }));
  expect(tracker.hasViewed("secret")).toBe(false);
});

test("a usage write that fails never fails the tool", async () => {
  await mkdir(join(dir, "skills", ".usage.json"), { recursive: true });
  const out = await createSkillTool(skills, { home: dir }).run({ skill: "deploy" }, makeToolContext({ root: dir }));
  expect(out.isError).toBeUndefined();
});

test("a load by the learning review counts only in its own tracker, and not as a use", async () => {
  const tracker = new SkillTracker();
  const reviewTracker = new SkillTracker();
  const tool = createSkillTool(skills, { home: dir, tracker, reviewTracker });
  const out = await tool.run({ skill: "deploy" }, { ...makeToolContext({ root: dir }), actor: "review" });
  expect(out.isError).toBeUndefined();
  expect(reviewTracker.hasViewed("deploy")).toBe(true);
  expect(tracker.hasViewed("deploy")).toBe(false);
  await Bun.sleep(30);
  expect((await readSkillUsage(dir)).deploy).toBeUndefined();
});
