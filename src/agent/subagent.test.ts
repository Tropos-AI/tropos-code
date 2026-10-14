// src/agent/subagent.test.ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { FakeModel, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { makeToolContext } from "../../test/helpers/tool-context";
import { compileRules } from "../permissions/engine";
import { defineTool, type AnyTool, type ToolContext } from "../tools/types";
import type { PermissionAnswer, PermissionPrompt } from "./events";
import { filterTools, resolveAgentModel, runSubagent, serializeAsks, subagentSystem, type SubagentDeps } from "./subagent";

const tool = (name: string, kind: "read" | "exec" = "read") =>
  defineTool({
    name,
    kind,
    description: name,
    schema: z.object({ x: z.string().optional() }),
    summarize: (i) => i.x ?? "",
    subject: () => (kind === "exec" ? { paths: [], command: "rm -rf x" } : { paths: [] }),
    run: async (_i, ctx) => {
      if (name === "Cd") ctx.setCwd("/elsewhere");
      return { content: `${name} ran in ${ctx.cwd()}` };
    },
  }) as AnyTool;

const tools = [tool("Read"), tool("Grep"), tool("Bash", "exec"), tool("Agent"), tool("mcp__gh__a"), tool("mcp__gh__b"), tool("Cd")];
const def = { name: "explore", description: "d", prompt: "Look around." };

function deps(steps: Step[], over: Partial<SubagentDeps> = {}): SubagentDeps & { model: FakeModel } {
  return {
    model: new FakeModel(steps),
    tools,
    system: "BASE",
    config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
    permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
    askPermission: async () => ({ kind: "deny" }),
    contextText: async () => "<context>ctx</context>",
    ...over,
  } as SubagentDeps & { model: FakeModel };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext & { progressed: string[] } {
  const progressed: string[] = [];
  return { ...makeToolContext({ root: "/work" }), progress: (t) => progressed.push(t), progressed, ...over } as ToolContext & { progressed: string[] };
}

describe("filterTools", () => {
  const names = (list: AnyTool[]) => list.map((t) => t.name);
  test("all tools but Agent by default and for *", () => {
    expect(names(filterTools(tools, {}))).toEqual(["Read", "Grep", "Bash", "mcp__gh__a", "mcp__gh__b", "Cd"]);
    expect(names(filterTools(tools, { tools: ["*"] }))).toEqual(names(filterTools(tools, {})));
  });
  test("named tools, prefixes and disallowed ones", () => {
    expect(names(filterTools(tools, { tools: ["Read", "mcp__gh__*", "Agent"] }))).toEqual(["Read", "mcp__gh__a", "mcp__gh__b"]);
    expect(names(filterTools(tools, { disallowedTools: ["Bash", "mcp__*"] }))).toEqual(["Read", "Grep", "Cd"]);
  });
});

test("model aliases and inherit", () => {
  expect(resolveAgentModel(undefined, "p")).toBe("p");
  expect(resolveAgentModel("inherit", "p")).toBe("p");
  expect(resolveAgentModel("Haiku", "p")).toBe("claude-haiku-5-5");
  expect(resolveAgentModel("openai/gpt-x", "p")).toBe("openai/gpt-x");
});

test("system prompt carries the agent's instructions", () => {
  const text = subagentSystem("BASE", def);
  expect(text.startsWith("BASE\n\n# Agent: explore\n")).toBe(true);
  expect(text.endsWith("Look around.")).toBe(true);
});

describe("runSubagent", () => {
  test("returns the final text with a footer and reports progress", async () => {
    const d = deps([() => reply([toolUseBlock("t1", "Read", { x: "src/a.ts" })], "tool_use"), () => reply([textBlock("Found it in src/a.ts.")])]);
    const c = ctx();
    const out = await runSubagent({ ...def, model: "haiku", tools: ["Read"] }, "find a", d, c);
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe("Found it in src/a.ts.\n\n(explore · 1 tool use · 2 turns)");
    expect(out.summary).toBe("1 tool use");
    expect(c.progressed).toEqual(["Read src/a.ts"]);
    const req = d.model.requests[0]!;
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.tools.map((t) => t.name)).toEqual(["Read"]);
    expect(JSON.stringify(req.messages[0])).toContain("<context>ctx</context>");
  });

  test("the child's cd doesn't move the parent", async () => {
    const d = deps([() => reply([toolUseBlock("t1", "Cd", {})], "tool_use"), () => reply([textBlock("ok")])]);
    const c = ctx();
    await runSubagent(def, "go", d, c);
    expect(c.cwd()).toBe("/work");
  });

  test("permission asks go through the shared function", async () => {
    const asked: PermissionPrompt[] = [];
    const d = deps([() => reply([toolUseBlock("t1", "Bash", {})], "tool_use"), () => reply([textBlock("could not")])], {
      askPermission: async (p) => {
        asked.push(p);
        return { kind: "deny" };
      },
    });
    const out = await runSubagent(def, "go", d, ctx());
    expect(asked[0]!.toolName).toBe("Bash");
    expect(out.content).toContain("could not");
  });

  test("an aborted run is interrupted; a failed one is an error with the reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await runSubagent(def, "go", deps([]), ctx({ signal: controller.signal }));
    expect(aborted).toEqual({ content: "[interrupted by user]", isError: true });
    const failed = await runSubagent(def, "go", deps([() => reply([textBlock("partial")], "refusal")]), ctx());
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("The explore agent did not finish: The model declined");
    expect(failed.content).toContain("Last reply:\npartial");
    const maxed = await runSubagent({ ...def, maxTurns: 1 }, "go", deps([() => reply([toolUseBlock("t1", "Read", {})], "tool_use")]), ctx());
    expect(maxed.content).toContain("it stopped early (max_turns)");
  });

  test("empty replies and UserPromptSubmit hooks", async () => {
    const seen: string[] = [];
    const hooks = {
      has: () => true,
      run: async (event: string) => {
        seen.push(event);
        return { additionalContext: [], messages: [], errors: [] };
      },
    };
    const out = await runSubagent(def, "go", deps([() => reply([])], { hooks }), ctx());
    expect(out.content).toContain("(the agent returned no text)");
    expect(seen).toEqual(["SubagentStop"]);
  });
});

test("serializeAsks never overlaps prompts and skips aborted ones", async () => {
  let open = 0;
  let maxOpen = 0;
  const ask = serializeAsks(async (): Promise<PermissionAnswer> => {
    open++;
    maxOpen = Math.max(maxOpen, open);
    await Bun.sleep(5);
    open--;
    return { kind: "allow" };
  });
  const prompt = { toolName: "Bash", kind: "exec", summary: "", input: {} } as PermissionPrompt;
  const aborted = new AbortController();
  aborted.abort();
  const answers = await Promise.all([ask(prompt, new AbortController().signal), ask(prompt, aborted.signal), ask(prompt, new AbortController().signal)]);
  expect(maxOpen).toBe(1);
  expect(answers.map((a) => a.kind)).toEqual(["allow", "deny", "allow"]);
});

test("a subagent reports its cost and saves 'don't ask again' rules", async () => {
  const costs: Array<number | undefined> = [];
  const rules: string[] = [];
  const d = deps([() => reply([toolUseBlock("t1", "Bash", {})], "tool_use"), () => reply([textBlock("ok")])], {
    askPermission: async () => ({ kind: "allow_always", rule: "Bash(rm:*)" }),
    onAllowAlways: (rule) => {
      rules.push(rule);
    },
    recordCost: (c) => costs.push(c),
  });
  await runSubagent(def, "go", d, ctx());
  expect(rules).toEqual(["Bash(rm:*)"]);
  expect(costs).toHaveLength(2);
  expect(costs.every((c) => typeof c === "number" && c > 0)).toBe(true);
});
