// src/tools/agent/agent-tool.test.ts
import { expect, test } from "bun:test";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { toInputSchema } from "../schema";
import { createAgentTool } from "./agent-tool";

const agents = [
  { name: "general-purpose", description: "Does  anything.", prompt: "p" },
  { name: "explore", description: "Searches.", tools: ["Read", "Grep"], prompt: "p" },
];

test("describes the agents and runs the chosen one", async () => {
  const calls: string[] = [];
  const tool = createAgentTool(agents, async (def, prompt) => {
    calls.push(`${def.name}:${prompt}`);
    return { content: "report" };
  });
  expect(tool.name).toBe("Agent");
  expect(tool.kind).toBe("meta");
  expect(tool.description).toContain("- general-purpose: Does anything. (Tools: all tools)");
  expect(tool.description).toContain("- explore: Searches. (Tools: Read, Grep)");
  expect(toInputSchema(tool.schema).required).toEqual(["description", "prompt"]);
  const ctx = makeToolContext();
  expect(await tool.run({ description: "find", prompt: "look" }, ctx)).toEqual({ content: "report" });
  await tool.run({ description: "find", prompt: "x", subagent_type: "explore" }, ctx);
  expect(calls).toEqual(["general-purpose:look", "explore:x"]);
  expect(tool.summarize({ description: "find", prompt: "x" })).toBe("general-purpose: find");
  expect(tool.subject({ description: "d", prompt: "x", subagent_type: "explore" }, "/w")).toEqual({ paths: [], target: "explore" });
});

test("an unknown agent is an error result", async () => {
  const tool = createAgentTool(agents, async () => ({ content: "x" }));
  const out = await tool.run({ description: "d", prompt: "p", subagent_type: "nope" }, makeToolContext());
  expect(out).toEqual({ content: 'Unknown agent "nope". Available: general-purpose, explore.', isError: true });
});
