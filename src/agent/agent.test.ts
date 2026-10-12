// src/agent/agent.test.ts
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { FakeModel, assertToolPairs, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { makeToolContext } from "../../test/helpers/tool-context";
import type { Mode } from "../config/constants";
import { PLAN_MODE_REASON, compileRules } from "../permissions/engine";
import { defineTool, type AnyTool } from "../tools/types";
import { Agent, type AgentOptions } from "./agent";
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from "./events";

const echo = defineTool({
  name: "Echo",
  kind: "read",
  description: "echo",
  schema: z.object({ text: z.string() }),
  summarize: (i) => i.text,
  subject: () => ({ paths: [] }),
  run: async (i) => ({ content: `echo:${i.text}` }),
});

let sleeperRuns = 0;
const sleeper = defineTool({
  name: "Sleep",
  kind: "exec",
  description: "sleep",
  schema: z.object({ ms: z.number() }),
  summarize: (i) => `sleep ${i.ms}`,
  subject: (i) => ({ command: `sleep ${i.ms}`, paths: [] }),
  run: async (i, ctx) => {
    sleeperRuns++;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, i.ms);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
    return ctx.signal.aborted ? { content: "[interrupted by user]", isError: true } : { content: "slept" };
  },
});

interface Harness {
  agent: Agent;
  model: FakeModel;
  events: AgentEvent[];
  prompts: PermissionPrompt[];
  persisted: unknown[];
  allowedAlways: string[];
}

function harness(steps: Step[], over: { mode?: Mode; answer?: PermissionAnswer; deny?: string[]; maxTurns?: number; ask?: AgentOptions["askPermission"] } = {}): Harness {
  const model = new FakeModel(steps);
  const events: AgentEvent[] = [];
  const prompts: PermissionPrompt[] = [];
  const persisted: unknown[] = [];
  const allowedAlways: string[] = [];
  const toolContext = makeToolContext({ root: "/work" });
  const agent = new Agent({
    model,
    tools: [echo, sleeper] as AnyTool[],
    system: "sys",
    config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
    permissions: () => ({
      mode: over.mode ?? "default",
      rules: compileRules({ allow: [], ask: [], deny: over.deny ?? [] }).rules,
      cwd: "/work",
      home: "/home/u",
      allowedDirs: ["/work"],
    }),
    askPermission:
      over.ask ??
      (async (p) => {
        prompts.push(p);
        return over.answer ?? { kind: "allow" };
      }),
    onAllowAlways: (rule) => {
      allowedAlways.push(rule);
    },
    contextText: async () => "<context>\nctx\n</context>",
    persist: async (m) => {
      persisted.push(m);
    },
    toolContext,
    maxTurns: over.maxTurns,
    emit: (e) => events.push(e),
  });
  return { agent, model, events, prompts, persisted, allowedAlways };
}

const run = (h: Harness, prompt = "go", signal = new AbortController().signal) => h.agent.run(prompt, signal);

describe("Agent", () => {
  test("a plain text turn", async () => {
    const h = harness([() => reply([textBlock("hello")])]);
    expect(await run(h)).toBe("end_turn");
    expect(h.events.filter((e) => e.type === "text")).toEqual([{ type: "text", delta: "hello" }]);
    expect(h.agent.messages).toHaveLength(2);
    const first = h.agent.messages[0]!.content as Array<{ text: string }>;
    expect(first[0]!.text).toStartWith("<context>");
    expect(first.at(-1)!.text).toBe("go");
    expect(h.persisted).toEqual(h.agent.messages);
  });

  test("context is only sent with the first message", async () => {
    const h = harness([() => reply([textBlock("a")]), () => reply([textBlock("b")])]);
    await run(h, "one");
    await run(h, "two");
    expect(h.agent.messages[2]!.content).toEqual([{ type: "text", text: "two" }]);
  });

  test("parallel read tools return in one message, in order", async () => {
    const h = harness([
      () => reply([toolUseBlock("a", "Echo", { text: "1" }), toolUseBlock("b", "Echo", { text: "2" })], "tool_use"),
      () => reply([textBlock("done")]),
    ]);
    expect(await run(h)).toBe("end_turn");
    expect(h.agent.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "echo:1" },
        { type: "tool_result", tool_use_id: "b", content: "echo:2" },
      ],
    });
    expect(h.model.requests[1]!.messages).toHaveLength(3);
    assertToolPairs(h.agent.messages);
  });

  test("an exec tool asks; a denial with feedback reaches the model", async () => {
    sleeperRuns = 0;
    const h = harness(
      [() => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "tool_use"), () => reply([textBlock("ok")])],
      { answer: { kind: "deny", feedback: "use the test script instead" } },
    );
    await run(h);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toMatchObject({ toolName: "Sleep", summary: "sleep 1", suggestion: "Sleep(sleep:*)" });
    expect(sleeperRuns).toBe(0);
    expect(h.agent.messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "s", content: "The user declined this action and said: use the test script instead", is_error: true },
    ]);
    expect(h.events.find((e) => e.type === "tool_end")).toMatchObject({ status: "denied" });
  });

  test("a deny answer with a message uses it verbatim", async () => {
    const h = harness([() => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "tool_use"), () => reply([textBlock("ok")])], {
      answer: { kind: "deny", message: "Not allowed in print mode." },
    });
    await run(h);
    expect(h.agent.messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "s", content: "Not allowed in print mode.", is_error: true }]);
  });

  test("allow_always records the rule and runs the tool", async () => {
    sleeperRuns = 0;
    const h = harness([() => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "tool_use"), () => reply([textBlock("ok")])], {
      answer: { kind: "allow_always", rule: "Sleep(sleep:*)" },
    });
    await run(h);
    expect(h.allowedAlways).toEqual(["Sleep(sleep:*)"]);
    expect(sleeperRuns).toBe(1);
  });

  test("plan mode: reminder in the user message, exec denied without asking", async () => {
    const h = harness([() => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "tool_use"), () => reply([textBlock("plan")])], { mode: "plan" });
    await run(h);
    const first = h.agent.messages[0]!.content as Array<{ text: string }>;
    expect(first.some((b) => b.text.startsWith("<mode>Plan mode is on"))).toBe(true);
    expect(h.prompts).toHaveLength(0);
    expect(h.agent.messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "s", content: PLAN_MODE_REASON, is_error: true }]);
  });

  test("deny rules block without asking", async () => {
    const h = harness([() => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "tool_use"), () => reply([textBlock("ok")])], { deny: ["Sleep"] });
    await run(h);
    expect(h.prompts).toHaveLength(0);
    expect((h.agent.messages[2]!.content as Array<{ is_error: boolean }>)[0]!.is_error).toBe(true);
  });

  test("invalid tool input and unknown tools become error results", async () => {
    const h = harness([
      () => reply([toolUseBlock("a", "Echo", { text: 5 }), toolUseBlock("b", "Nope", {})], "tool_use"),
      () => reply([textBlock("ok")]),
    ]);
    await run(h);
    const results = h.agent.messages[2]!.content as Array<{ content: string; is_error: boolean }>;
    expect(results[0]!.content).toStartWith("INVALID_INPUT");
    expect(results[1]!.content).toBe("Unknown tool: Nope");
    expect(results.every((r) => r.is_error)).toBe(true);
  });

  test("a tool whose subject() throws is refused, not run", async () => {
    const throwing = defineTool({
      name: "Boom",
      kind: "read",
      description: "x",
      schema: z.object({}),
      summarize: () => "",
      subject: () => {
        throw new Error("cannot resolve path");
      },
      run: async () => ({ content: "ran" }),
    });
    const model = new FakeModel([() => reply([toolUseBlock("b", "Boom", {})], "tool_use"), () => reply([textBlock("ok")])]);
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model,
      tools: [throwing] as AnyTool[],
      system: "s",
      config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
      permissions: () => ({ mode: "bypass", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
      askPermission: async () => ({ kind: "allow" }),
      contextText: async () => "<context></context>",
      persist: async () => {},
      toolContext: makeToolContext({ root: "/work" }),
      emit: (e) => events.push(e),
    });
    await agent.run("go", new AbortController().signal);
    const result = (agent.messages[2]!.content as Array<{ content: string; is_error: boolean }>)[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("cannot resolve path");
  });

  test("refusal: tools not run, history closed, reason refusal", async () => {
    sleeperRuns = 0;
    const h = harness([() => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "refusal")]);
    expect(await run(h)).toBe("refusal");
    expect(sleeperRuns).toBe(0);
    assertToolPairs(h.agent.messages);
    expect(h.events.some((e) => e.type === "notice" && e.level === "error")).toBe(true);
  });

  test("max_tokens with a tool call: not run, error result, loop continues", async () => {
    sleeperRuns = 0;
    const h = harness([() => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "max_tokens"), () => reply([textBlock("smaller steps")])], { mode: "bypass" });
    expect(await run(h)).toBe("end_turn");
    expect(sleeperRuns).toBe(0);
    expect((h.agent.messages[2]!.content as Array<{ content: string }>)[0]!.content).toContain("output limit");
  });

  test("pause_turn continues the loop", async () => {
    const h = harness([() => reply([textBlock("part")], "pause_turn"), () => reply([textBlock("rest")])]);
    expect(await run(h)).toBe("end_turn");
    expect(h.model.requests).toHaveLength(2);
  });

  test("malformed tool JSON is re-requested at most twice", async () => {
    const bad: Step = () => {
      throw new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model.");
    };
    const ok = harness([bad, bad, () => reply([textBlock("fine")])]);
    expect(await run(ok)).toBe("end_turn");
    expect(ok.events.filter((e) => e.type === "notice" && e.level === "warn")).toHaveLength(2);

    const fail = harness([bad, bad, bad]);
    expect(await run(fail)).toBe("error");
  });

  test("other errors (e.g. missing credentials) end the turn without retrying", async () => {
    const h = harness([
      () => {
        throw new Error("Could not resolve authentication method. Expected one of apiKey, authToken…");
      },
    ]);
    expect(await run(h)).toBe("error");
    expect(h.model.requests).toHaveLength(1);
    expect(h.events.find((e) => e.type === "notice")).toMatchObject({ level: "error", text: expect.stringContaining("ANTHROPIC_API_KEY") });
  });

  test("API errors end the turn with an error notice", async () => {
    const h = harness([
      () => {
        throw Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, "bad", new Headers());
      },
    ]);
    expect(await run(h)).toBe("error");
    const notice = h.events.find((e) => e.type === "notice");
    expect(notice).toMatchObject({ level: "error" });
    expect(h.agent.messages).toHaveLength(1); // only the user message
  });

  test("abort during a tool run keeps history valid", async () => {
    const controller = new AbortController();
    const h = harness(
      [() => reply([toolUseBlock("a", "Echo", { text: "x" }), toolUseBlock("s", "Sleep", { ms: 5000 }), toolUseBlock("t", "Sleep", { ms: 5000 })], "tool_use")],
      { mode: "bypass" },
    );
    setTimeout(() => controller.abort(), 50);
    expect(await run(h, "go", controller.signal)).toBe("aborted");
    assertToolPairs(h.agent.messages);
    const results = h.agent.messages.at(-1)!.content as Array<{ tool_use_id: string; content: string }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "s", "t"]);
    expect(results[1]!.content).toBe("[interrupted by user]");
    expect(results[2]!.content).toBe("[interrupted by user]");
  });

  test("abort during streaming appends nothing after the user message", async () => {
    const controller = new AbortController();
    const h = harness([
      (_req, _handlers, signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()))),
    ]);
    setTimeout(() => controller.abort(), 20);
    expect(await run(h, "go", controller.signal)).toBe("aborted");
    expect(h.agent.messages).toHaveLength(1);
  });

  test("max turns", async () => {
    const h = harness([() => reply([toolUseBlock("a", "Echo", { text: "x" })], "tool_use")], { maxTurns: 1 });
    expect(await run(h)).toBe("max_turns");
    assertToolPairs(h.agent.messages);
  });

  test("permission prompts never overlap", async () => {
    let open = 0;
    let maxOpen = 0;
    const h = harness(
      [() => reply([toolUseBlock("s1", "Sleep", { ms: 1 }), toolUseBlock("s2", "Sleep", { ms: 1 })], "tool_use"), () => reply([textBlock("ok")])],
      {
        ask: async () => {
          open++;
          maxOpen = Math.max(maxOpen, open);
          await Bun.sleep(10);
          open--;
          return { kind: "allow" };
        },
      },
    );
    await run(h);
    expect(maxOpen).toBe(1);
  });

  test("usage events accumulate cost", async () => {
    const h = harness([() => reply([textBlock("a")])]);
    await run(h);
    const usage = h.events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, contextTokens: 100 });
    expect(h.agent.totalCostUsd).toBeCloseTo((100 * 4 + 20 * 20) / 1_000_000, 9);
  });
});
