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

test("the description carries the handoff guidance, and run passes the call's description as the task", async () => {
  const tasks: string[] = [];
  const tool = createAgentTool(agents, async (_def, _prompt, _ctx, task) => {
    tasks.push(task);
    return { content: "x" };
  });
  expect(tool.description).toContain("Every handoff states: the objective, the inputs");
  expect(tool.description).toContain("Up to 4 specialists run at once.");
  await tool.run({ description: "review the PR", prompt: "p" }, makeToolContext());
  expect(tasks).toEqual(["review the PR"]);
});

test("an optional model is passed to the run, described, and shown in the summary", async () => {
  const seen: Array<string | undefined> = [];
  const tool = createAgentTool(agents, async (_def, _prompt, _ctx, _task, model) => (seen.push(model), { content: "ok" }));
  await tool.run({ description: "d", prompt: "p", subagent_type: "explore", model: "haiku" }, makeToolContext());
  await tool.run({ description: "d", prompt: "p" }, makeToolContext());
  expect(seen).toEqual(["haiku", undefined]);
  expect(toInputSchema(tool.schema).properties).toHaveProperty("model");
  expect(tool.description).toContain("pass model");
  expect(tool.summarize({ description: "find", prompt: "x", subagent_type: "explore", model: "haiku" })).toBe("explore: find (haiku)");
});
