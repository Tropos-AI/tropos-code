// src/tools/agent/agent-tool.ts
import { z } from "zod";
import { AGENT_TOOL_NAME, type SubagentDefinition } from "../../agent/subagent";
import { defineTool, type AnyTool, type ToolContext, type ToolOutput } from "../types";

const schema = z.object({
  description: z.string().min(1).describe("A short (3-6 word) description of the task."),
  prompt: z.string().min(1).describe("The full task for the agent: what to do, the context it needs, and what to report back."),
  subagent_type: z.string().optional().describe("Which agent to use (default general-purpose)."),
});

/** `task` is the Agent call's `description`, for the run log. */
export type RunSubagent = (def: SubagentDefinition, prompt: string, ctx: ToolContext, task: string) => Promise<ToolOutput>;

function listing(agents: SubagentDefinition[]): string {
  return agents
    .map((a) => {
      const tools = a.tools && !(a.tools.length === 1 && a.tools[0] === "*") ? a.tools.join(", ") : "all tools";
      return `- ${a.name}: ${a.description.replace(/\s+/g, " ").trim()} (Tools: ${tools})`;
    })
    .join("\n");
}

/**
 * The Agent tool: hands a self-contained task to a subagent with its own context window and returns
 * its final report. Its description lists the agents known at the start, fixed for the session (prompt
 * caching); `agents` is read at call time, and `reload` refreshes it from disk when a name is unknown,
 * so an agent created mid-session (AgentManage) can be started right away.
 */
export function createAgentTool(agents: SubagentDefinition[], run: RunSubagent, reload?: () => Promise<void>): AnyTool {
  const find = (name: string) => agents.find((a) => a.name === name);
  const initial = [...agents];
  return defineTool({
    name: AGENT_TOOL_NAME,
    kind: "meta",
    description:
      "Launch a subagent to handle a task on its own, with a fresh context window. Use it for broad searches across many files, " +
      "research whose details you don't need to keep, or independent pieces of work that can run in parallel (several Agent calls in one response run concurrently). " +
      "The agent can't see this conversation: put everything it needs in the prompt, and say what to report back. " +
      "Its tool calls go through the same permission checks as yours. Its final message comes back as the result; relay what matters to the user.\n\n" +
      "When a specialist fits, delegate to it; when none does, do the work yourself. Every handoff states: the objective, the inputs (files, links, facts from this conversation), where results go, how to verify them, and the limits (what not to touch, what needs the user's approval). " +
      "A report is a claim, not proof: check it against evidence (the diff, test output, the files) before telling the user. If it doesn't hold up, retry once with a clarified task, then tell the user what failed. Up to 4 specialists run at once.\n\n" +
      `Available agents:\n${listing(initial)}`,
    schema,
    summarize: (input) => {
      const name = input.subagent_type ?? "general-purpose";
      const emoji = find(name)?.emoji;
      return `${emoji ? `${emoji} ` : ""}${name}: ${input.description}`;
    },
    subject: (input) => ({ paths: [], target: input.subagent_type ?? "general-purpose" }),
    async run(input, ctx) {
      const name = input.subagent_type ?? "general-purpose";
      let def = find(name);
      if (!def && reload) {
        await reload().catch(() => {});
        def = find(name);
      }
      if (!def) return { content: `Unknown agent "${name}". Available: ${agents.map((a) => a.name).join(", ")}.`, isError: true };
      return run(def, input.prompt, ctx, input.description);
    },
  }) as AnyTool;
}
