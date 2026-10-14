// src/agent/agent-hooks.test.ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { FakeModel, assertToolPairs, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { makeToolContext } from "../../test/helpers/tool-context";
import type { HookEvent } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { defineTool, type AnyTool } from "../tools/types";
import { Agent, appendToContent, hookContext, type AgentHooks, type AgentOptions, type HookResult } from "./agent";
import type { AgentEvent, PermissionPrompt } from "./events";

const echo = defineTool({
  name: "Echo",
  kind: "read",
  description: "echo",
  schema: z.object({ text: z.string() }),
  summarize: (i) => i.text,
  subject: () => ({ paths: [] }),
  run: async (i) => ({ content: `echo:${i.text}` }),
});
const writer = defineTool({
  name: "Writer",
  kind: "edit",
  description: "write",
  schema: z.object({ path: z.string() }),
  summarize: (i) => i.path,
  subject: (i) => ({ paths: [i.path] }),
  run: async (i) => (i.path.includes("fail") ? { content: "boom", isError: true } : { content: `wrote ${i.path}` }),
});

type Script = Partial<Record<HookEvent, (input: Record<string, unknown>, match?: string) => Partial<HookResult>>>;

function fakeHooks(script: Script): AgentHooks & { calls: Array<{ event: HookEvent; input: Record<string, unknown>; match?: string }> } {
  const calls: Array<{ event: HookEvent; input: Record<string, unknown>; match?: string }> = [];
  return {
    calls,
    has: (event) => event in script,
    run: async (event, input, match) => {
      calls.push({ event, input, match });
      return { additionalContext: [], messages: [], errors: [], ...script[event]!(input, match) };
    },
  };
}

function make(steps: Step[], over: Partial<AgentOptions> & { allow?: string[] } = {}) {
  const model = new FakeModel(steps);
  const events: AgentEvent[] = [];
  const prompts: PermissionPrompt[] = [];
  const agent = new Agent({
    model,
    tools: [echo, writer] as AnyTool[],
    system: "sys",
    config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
    permissions: () => ({ mode: "default", rules: compileRules({ allow: over.allow ?? [], ask: [], deny: [] }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
    askPermission: async (p) => {
      prompts.push(p);
      return { kind: "allow" };
    },
    contextText: async () => "<context></context>",
    persist: async () => {},
    toolContext: makeToolContext({ root: "/work" }),
    emit: (e) => events.push(e),
    ...over,
  });
  return { agent, model, events, prompts };
}

const signal = () => new AbortController().signal;
const lastUserText = (model: FakeModel, i: number) => JSON.stringify(model.requests[i]!.messages.at(-1));

describe("UserPromptSubmit", () => {
  test("adds context before the prompt", async () => {
    const hooks = fakeHooks({ UserPromptSubmit: () => ({ additionalContext: ["branch: main"], messages: ["hi from hook"] }) });
    const { agent, model, events } = make([() => reply([textBlock("ok")])], { hooks });
    expect(await agent.run("go", signal())).toBe("end_turn");
    const content = model.requests[0]!.messages.at(-1)!.content as Array<{ text: string }>;
    expect(content.map((b) => b.text)).toEqual(["<context></context>", hookContext("UserPromptSubmit", ["branch: main"]), "go"]);
    expect(hooks.calls[0]!.input).toEqual({ prompt: "go" });
    expect(events).toContainEqual({ type: "notice", level: "info", text: "hi from hook" });
  });

  test("a block stops the turn before any request", async () => {
    const hooks = fakeHooks({ UserPromptSubmit: () => ({ blocked: "no secrets", errors: ["slow"] }) });
    const { agent, model, events } = make([], { hooks });
    expect(await agent.run("go", signal())).toBe("blocked");
    expect(model.requests).toHaveLength(0);
    expect(agent.messages).toHaveLength(0);
    expect(events.some((e) => e.type === "notice" && e.text.includes("no secrets"))).toBe(true);
    expect(events).toContainEqual({ type: "notice", level: "warn", text: "UserPromptSubmit hook: slow" });
  });
});

describe("PreToolUse", () => {
  const callWriter = (path: string): Step => () => reply([toolUseBlock("t1", "Writer", { path })], "tool_use");

  test("block denies with the reason; match is the tool name", async () => {
    const hooks = fakeHooks({ PreToolUse: () => ({ blocked: "not on main" }) });
    const { agent, model } = make([callWriter("/work/a"), () => reply([textBlock("done")])], { hooks });
    await agent.run("go", signal());
    expect(lastUserText(model, 1)).toContain("Blocked by a PreToolUse hook: not on main");
    expect(hooks.calls[0]!.match).toBe("Writer");
    expect(hooks.calls[0]!.input).toMatchObject({ tool_name: "Writer", tool_input: { path: "/work/a" }, tool_use_id: "t1" });
    assertToolPairs(agent.messages);
  });

  test("deny decision, with and without a reason", async () => {
    for (const [reason, text] of [["policy", "Denied by a PreToolUse hook: policy"], [undefined, "Denied by a PreToolUse hook."]] as const) {
      const hooks = fakeHooks({ PreToolUse: () => ({ permission: "deny", permissionReason: reason }) });
      const { agent, model } = make([callWriter("/work/a"), () => reply([textBlock("done")])], { hooks });
      await agent.run("go", signal());
      expect(lastUserText(model, 1)).toContain(text);
    }
  });

  test("allow skips the prompt; ask forces one", async () => {
    const allow = make([callWriter("/work/a"), () => reply([textBlock("done")])], { hooks: fakeHooks({ PreToolUse: () => ({ permission: "allow" }) }) });
    await allow.agent.run("go", signal());
    expect(allow.prompts).toHaveLength(0);
    const ask = make([() => reply([toolUseBlock("t1", "Echo", { text: "x" })], "tool_use"), () => reply([textBlock("done")])], {
      hooks: fakeHooks({ PreToolUse: () => ({ permission: "ask" }) }),
    });
    await ask.agent.run("go", signal());
    expect(ask.prompts[0]!.reason).toBe("a PreToolUse hook asked for confirmation");
  });

  test("updatedInput is re-validated and used", async () => {
    const ok = make([callWriter("/work/a"), () => reply([textBlock("done")])], {
      hooks: fakeHooks({ PreToolUse: () => ({ updatedInput: { path: "/work/b" }, permission: "allow" }) }),
    });
    await ok.agent.run("go", signal());
    expect(lastUserText(ok.model, 1)).toContain("wrote /work/b");
    // The allow came with a rewrite, so the rewritten call still asked.
    expect(ok.prompts.map((p) => p.toolName)).toEqual(["Writer"]);
    const bad = make([callWriter("/work/a"), () => reply([textBlock("done")])], { hooks: fakeHooks({ PreToolUse: () => ({ updatedInput: { nope: 1 } }) }) });
    await bad.agent.run("go", signal());
    expect(lastUserText(bad.model, 1)).toContain("rewrote the input into something invalid");
  });

  test("continue:false stops the turn after the tool batch", async () => {
    const hooks = fakeHooks({ PreToolUse: () => ({ stop: "enough" }) });
    const { agent, events } = make([callWriter("/work/a")], { hooks });
    expect(await agent.run("go", signal())).toBe("blocked");
    expect(events.some((e) => e.type === "notice" && e.text === "A hook stopped the turn: enough")).toBe(true);
    assertToolPairs(agent.messages);
  });
});

describe("PostToolUse and postWrite", () => {
  test("formatter/LSP text and hook context are appended; failures go to PostToolUseFailure", async () => {
    const hooks = fakeHooks({
      PostToolUse: (input) => ({ additionalContext: [`saw ${String(input.tool_response)}`] }),
      PostToolUseFailure: (input) => ({ blocked: `fix ${String(input.error)}` }),
    });
    const postWrite = async (paths: string[]) => `(formatted ${paths.join(",")})`;
    const { agent, model } = make(
      [
        () => reply([toolUseBlock("t1", "Writer", { path: "/work/a" }), toolUseBlock("t2", "Writer", { path: "/work/fail" })], "tool_use"),
        () => reply([textBlock("done")]),
      ],
      { hooks, postWrite, allow: ["Writer"] },
    );
    await agent.run("go", signal());
    const results = JSON.stringify(model.requests[1]!.messages.at(-1));
    expect(results).toContain("wrote /work/a\\n\\n(formatted /work/a)");
    expect(results).toContain("saw wrote /work/a");
    expect(results).toContain("fix boom");
    expect(results).not.toContain("(formatted /work/fail)");
  });

  test("beforeChange runs once per turn, only for edit/exec tools", async () => {
    let calls = 0;
    const beforeChange = async () => {
      calls++;
    };
    const { agent } = make(
      [
        () => reply([toolUseBlock("t0", "Echo", { text: "x" })], "tool_use"),
        () => reply([toolUseBlock("t1", "Writer", { path: "/work/a" }), toolUseBlock("t2", "Writer", { path: "/work/b" })], "tool_use"),
        () => reply([textBlock("done")]),
        () => reply([toolUseBlock("t3", "Writer", { path: "/work/c" })], "tool_use"),
        () => reply([textBlock("done")]),
      ],
      { beforeChange, allow: ["Writer"] },
    );
    await agent.run("one", signal());
    expect(calls).toBe(1);
    await agent.run("two", signal());
    expect(calls).toBe(2);
  });
});

describe("Stop", () => {
  test("a block sends the model back to work, at most three times", async () => {
    const hooks = fakeHooks({ Stop: (input) => ({ blocked: `tests fail (${String(input.stop_hook_active)})` }) });
    const steps = Array.from({ length: 4 }, (_, i) => () => reply([textBlock(`try ${i}`)]));
    const { agent, model } = make(steps, { hooks });
    expect(await agent.run("go", signal())).toBe("end_turn");
    expect(model.requests).toHaveLength(4);
    expect(lastUserText(model, 1)).toContain("tests fail (false)");
    expect(lastUserText(model, 2)).toContain("tests fail (true)");
    expect(hooks.calls[0]!.input.last_assistant_message).toBe("try 0");
  });

  test("continue:false or no block ends the turn", async () => {
    const { agent, model } = make([() => reply([textBlock("a")])], { hooks: fakeHooks({ Stop: () => ({ stop: "x", blocked: "y" }) }) });
    expect(await agent.run("go", signal())).toBe("end_turn");
    expect(model.requests).toHaveLength(1);
  });

  test("subagents fire SubagentStop matched by agent type", async () => {
    const hooks = fakeHooks({ SubagentStop: () => ({}) });
    const { agent } = make([() => reply([textBlock("a")])], { hooks, stopEvent: { event: "SubagentStop", agentType: "explore" } });
    await agent.run("go", signal());
    expect(hooks.calls[0]).toMatchObject({ event: "SubagentStop", match: "explore", input: { agent_type: "explore" } });
  });
});

test("reminders ride on the next user message", async () => {
  const { agent, model } = make([() => reply([textBlock("ok")])], { startTurn: () => ["<reminder>undone</reminder>"] });
  await agent.run("go", signal());
  expect(lastUserText(model, 0)).toContain("<reminder>undone</reminder>");
});

test("tools can report progress", async () => {
  const progressTool = defineTool({
    name: "Prog",
    kind: "meta",
    description: "p",
    schema: z.object({}),
    summarize: () => "",
    subject: () => ({ paths: [] }),
    run: async (_i, ctx) => {
      ctx.progress?.("halfway");
      return { content: `id ${ctx.toolUseId}` };
    },
  });
  const { agent, events } = make([() => reply([toolUseBlock("t9", "Prog", {})], "tool_use"), () => reply([textBlock("ok")])], {
    tools: [progressTool] as AnyTool[],
  });
  await agent.run("go", signal());
  expect(events).toContainEqual({ type: "tool_progress", id: "t9", text: "halfway" });
});

test("appendToContent handles strings and block lists", () => {
  expect(appendToContent("a", "\n\nb")).toBe("a\n\nb");
  expect(appendToContent([{ type: "text", text: "a" }], "\n\nb")).toEqual([
    { type: "text", text: "a" },
    { type: "text", text: "b" },
  ]);
});

test("Esc during a PreToolUse hook or the snapshot means the tool never starts", async () => {
  for (const which of ["hook", "snapshot"] as const) {
    let ran = false;
    const controller = new AbortController();
    const tracked = defineTool({
      name: "Writer",
      kind: "edit",
      description: "w",
      schema: z.object({ path: z.string() }),
      summarize: (i) => i.path,
      subject: (i) => ({ paths: [i.path] }),
      run: async () => {
        ran = true;
        return { content: "wrote" };
      },
    });
    const slow = async () => {
      controller.abort();
    };
    const { agent } = make([() => reply([toolUseBlock("t1", "Writer", { path: "/work/a" })], "tool_use")], {
      tools: [tracked] as AnyTool[],
      allow: ["Writer"],
      ...(which === "hook"
        ? { hooks: fakeHooks({ PreToolUse: () => (controller.abort(), {}) }) }
        : { beforeChange: slow }),
    });
    expect(await agent.run("go", controller.signal)).toBe("aborted");
    expect(ran).toBe(false);
    assertToolPairs(agent.messages);
  }
});

test("addCost folds a subagent's spend in; an unknown price makes the total unknown", () => {
  const { agent } = make([]);
  agent.addCost(0.5);
  expect(agent.totalCostUsd).toBe(0.5);
  agent.addCost(undefined);
  expect(agent.totalCostUsd).toBeUndefined();
  agent.addCost(1);
  expect(agent.totalCostUsd).toBeUndefined();
});
