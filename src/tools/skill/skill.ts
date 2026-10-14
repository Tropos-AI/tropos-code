// src/tools/skill/skill.ts
import { z } from "zod";
import { errorText } from "../../error-text";
import { renderSkill, type Skill } from "../../extensions/skills";
import { defineTool, type AnyTool } from "../types";

const schema = z.object({
  skill: z.string().min(1).describe('The skill\'s exact name from the <skills> list, e.g. "deploy" or "my-plugin:review".'),
  args: z.string().optional().describe("Optional arguments for the skill, as the user would type them after /name."),
});

/**
 * The Skill tool: loads a skill's instructions into the conversation on demand. Its description
 * never names the skills; they are listed in the first message's <context>, so the tool list (and
 * the prompt cache) stays the same whatever skills are installed. Skills that opt out of model
 * invocation are refused here as well as left out of the listing.
 */
export function createSkillTool(skills: Skill[]): AnyTool {
  const byName = new Map(skills.filter((s) => s.modelInvocable).map((s) => [s.name, s]));
  const userOnly = new Set(skills.filter((s) => !s.modelInvocable).map((s) => s.name));
  const strip =(name: string) => name.trim().replace(/^\//, "");
  return defineTool({
    name: "Skill",
    kind: "meta",
    description:
      "Load a skill: packaged instructions (and sometimes scripts or reference files) for a specific kind of task. " +
      "The available skills are listed in the <skills> block of the first message's context. " +
      "When a task matches a skill's description, call this before starting the work and follow the instructions it returns. " +
      "Pass the exact name; don't call it for a skill that is already loaded in this conversation.",
    schema,
    summarize: (input) => strip(input.skill),
    subject: (input) => ({ paths: [], target: strip(input.skill) }),
    async run(input) {
      const name = strip(input.skill);
      const skill = byName.get(name);
      if (!skill) {
        const available = [...byName.keys()].sort();
        const list = available.length > 0 ? `Available skills: ${available.join(", ")}` : "No skills are available.";
        const why = userOnly.has(name) ? `Skill "${name}" can only be run by the user (/${name}).` : `Unknown skill "${name}".`;
        return { content: `${why} ${list}`, isError: true };
      }
      try {
        return { content: await renderSkill(skill, input.args), summary: `loaded ${skill.name}` };
      } catch (err) {
        return { content: `Cannot load skill ${skill.name}: ${errorText(err)}`, isError: true };
      }
    },
  }) as AnyTool;
}
