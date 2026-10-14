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

test("the summary carries the agent's emoji when it has one", () => {
  const tool = createAgentTool([...agents, { name: "scout", description: "Scouts.", prompt: "p", emoji: "🔎" }], async () => ({ content: "x" }));
  expect(tool.summarize({ description: "find it", prompt: "x", subagent_type: "scout" })).toBe("🔎 scout: find it");
  expect(tool.summarize({ description: "find it", prompt: "x", subagent_type: "explore" })).toBe("explore: find it");
  expect(tool.summarize({ description: "find it", prompt: "x", subagent_type: "nope" })).toBe("nope: find it");
});

test("an agent created mid-session is found after a reload; the description keeps the starting list", async () => {
  const list = [...agents];
  let reloads = 0;
  const tool = createAgentTool(
    list,
    async (def) => ({ content: `ran ${def.name}` }),
    async () => {
      reloads++;
      list.push({ name: "george", description: "Researches.", prompt: "p", emoji: "🔬" } as (typeof list)[number]);
    },
  );
  const ctx = makeToolContext();
  expect(await tool.run({ description: "dig", prompt: "x", subagent_type: "george" }, ctx)).toEqual({ content: "ran george" });
  expect(reloads).toBe(1);
  expect(tool.summarize({ description: "dig", prompt: "x", subagent_type: "george" })).toBe("🔬 george: dig");
  // Prompt caching: the tool's description is what it was when the session started.
  expect(tool.description).not.toContain("george");
  // A known agent needs no reload; an unknown one still fails after it.
  await tool.run({ description: "d", prompt: "x", subagent_type: "explore" }, ctx);
  expect(reloads).toBe(1);
  expect(await tool.run({ description: "d", prompt: "x", subagent_type: "nobody" }, ctx)).toMatchObject({ isError: true });
  expect(reloads).toBe(2);
});
