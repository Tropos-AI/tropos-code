// src/tools/agent/agent-tool.ts
import { z } from "zod";
import { AGENT_TOOL_NAME, type SubagentDefinition } from "../../agent/subagent";
import { defineTool, type AnyTool, type ToolContext, type ToolOutput } from "../types";

const schema = z.object({
  description: z.string().min(1).describe("A short (3-6 word) description of the task."),
  prompt: z.string().min(1).describe("The full task for the agent: what to do, the context it needs, and what to report back."),
  subagent_type: z.string().optional().describe("Which agent to use (default general-purpose)."),
});

export type RunSubagent = (def: SubagentDefinition, prompt: string, ctx: ToolContext) => Promise<ToolOutput>;

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
 * its final report. Its description lists the agents, fixed for the session (prompt caching).
 */
export function createAgentTool(agents: SubagentDefinition[], run: RunSubagent): AnyTool {
  const byName = new Map(agents.map((a) => [a.name, a]));
  return defineTool({
    name: AGENT_TOOL_NAME,
    kind: "meta",
    description:
      "Launch a subagent to handle a task on its own, with a fresh context window. Use it for broad searches across many files, " +
      "research whose details you don't need to keep, or independent pieces of work that can run in parallel (several Agent calls in one response run concurrently). " +
      "The agent can't see this conversation: put everything it needs in the prompt, and say what to report back. " +
      "Its tool calls go through the same permission checks as yours. Its final message comes back as the result; relay what matters to the user.\n\n" +
      `Available agents:\n${listing(agents)}`,
    schema,
    summarize: (input) => `${input.subagent_type ?? "general-purpose"}: ${input.description}`,
    subject: (input) => ({ paths: [], target: input.subagent_type ?? "general-purpose" }),
    async run(input, ctx) {
      const name = input.subagent_type ?? "general-purpose";
      const def = byName.get(name);
      if (!def) return { content: `Unknown agent "${name}". Available: ${agents.map((a) => a.name).join(", ")}.`, isError: true };
      return run(def, input.prompt, ctx);
    },
  }) as AnyTool;
}
