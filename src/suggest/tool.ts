// src/suggest/tool.ts — the agent records what happened to a suggestion it made. Kind "meta": it writes one small
// bookkeeping file in Tropos's own folder and nothing the user owns.
import { z } from "zod";
import { defineTool, type AnyTool, type ToolOutput } from "../tools/types";
import type { SuggestionStore } from "./store";

const schema = z.object({
  id: z.string().min(1).max(100).describe("The id in the <suggestions> block, without the brackets, such as setup:telegram."),
  outcome: z
    .enum(["mentioned", "declined", "accepted"])
    .describe("mentioned: you raised it. declined: the owner said no (it won't come back). accepted: they took it up."),
});

export function createSuggestionTool(store: SuggestionStore): AnyTool {
  return defineTool({
    name: "Suggestion",
    kind: "meta",
    description:
      "Record what happened to a suggestion from the <suggestions> block: call it with outcome mentioned when you raise one, declined when the owner says no, accepted when they take it up.",
    schema,
    summarize: (input) => `${input.outcome} ${input.id}`,
    subject: () => ({ paths: [], target: "suggestion" }),
    async run(input): Promise<ToolOutput> {
      await store.mark(input.id, input.outcome);
      return { content: `Recorded: ${input.id} ${input.outcome}.` };
    },
  });
}
