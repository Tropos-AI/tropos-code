// src/tools/setup/switch-project-tool.ts — "work on Y" in a chat: points the chat at another project by a fuzzy name.
// Kind "meta": it changes which project the chat's next message opens, nothing on disk. The chat's own project list
// is all it sees, so a guest can neither find nor enter a project the owner didn't share.
import { z } from "zod";
import { matchProjects } from "../../gateway/project-match";
import type { Project } from "../../gateway/projects";
import type { ChatProjects } from "../../gateway/types";
import { defineTool, type AnyTool, type ToolOutput } from "../types";

const schema = z.object({
  project: z.string().describe("The project's id or name, as the user said it (a partial or slightly misspelled name is fine)."),
});

const label = (p: Project): string => `${p.name} (${p.id})`;

export function createSwitchProjectTool(deps: { chatKey: string; projects: ChatProjects }): AnyTool {
  const { chatKey, projects } = deps;
  return defineTool({
    name: "SwitchProject",
    kind: "meta",
    description:
      'Switch this chat to another project when the user says "work on <name>" or similar. It matches the name loosely; when several ' +
      "projects match, it lists them and switches to none, so ask the user which one. The switch applies from the user's next message: " +
      "finish your answer in the current project. To create a new project, use TroposSetup project.create instead.",
    schema,
    summarize: (input) => `switch to ${input.project}`,
    subject: () => ({ paths: [], target: "project:switch" }),
    async run(input): Promise<ToolOutput> {
      const visible = await projects.list(chatKey);
      const { match, candidates } = matchProjects(input.project, visible);
      if (!match) {
        if (candidates.length > 1) return { content: `Several projects match "${input.project}": ${candidates.map(label).join(", ")}. Ask which one; I switched to none.` };
        return { content: `No project matches "${input.project}". Projects here: ${visible.map(label).join(", ")}. I switched to none.` };
      }
      const current = await projects.current(chatKey);
      if (current.id === match.id) return { content: `Already in ${label(match)}.` };
      try {
        const next = await projects.select(chatKey, match.id);
        return { content: `Switched to ${label(next)}. The user's next message continues there.` };
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
    },
  });
}
