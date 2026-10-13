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

function harness(steps: Step[], over: {
    mode?: Mode;
    answer?: PermissionAnswer;
    deny?: string[];
    maxTurns?: number;
    ask?: AgentOptions["askPermission"];
    persist?: AgentOptions["persist"];
    onAllowAlways?: AgentOptions["onAllowAlways"];
    emit?: (e: AgentEvent) => void;
    tools?: AnyTool[];
  } = {}): Harness {
  const model = new FakeModel(steps);
  const events: AgentEvent[] = [];
  const prompts: PermissionPrompt[] = [];
  const persisted: unknown[] = [];
  const allowedAlways: string[] = [];
  const toolContext = makeToolContext({ root: "/work" });
  const agent = new Agent({
    model,
    tools: over.tools ?? ([echo, sleeper] as AnyTool[]),
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
    onAllowAlways:
      over.onAllowAlways ??
      ((rule) => {
        allowedAlways.push(rule);
      }),
    contextText: async () => "<context>\nctx\n</context>",
    persist:
      over.persist ??
      (async (m) => {
        persisted.push(m);
      }),
    toolContext,
    maxTurns: over.maxTurns,
    emit: (e) => {
      events.push(e);
      over.emit?.(e);
    },
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

  test("max_tokens on a text reply ends the turn as max_tokens, not end_turn", async () => {
    const h = harness([() => reply([textBlock("half an ans")], "max_tokens")]);
    expect(await run(h)).toBe("max_tokens");
    expect(h.events.some((e) => e.type === "notice" && e.level === "error" && e.text.includes("cut off"))).toBe(true);
    expect(h.events.at(-1)).toEqual({ type: "turn_end", reason: "max_tokens" });
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

  test("a wrapped missing-credentials error ends the turn at once with the credentials notice", async () => {
    const h = harness([
      () => {
        throw new Anthropic.AnthropicError("Could not resolve authentication method. Expected one of apiKey, authToken…");
      },
    ]);
    expect(await run(h)).toBe("error");
    expect(h.model.requests).toHaveLength(1);
    const notices = h.events.filter((e) => e.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: "error", text: expect.stringContaining("No API credentials found") });
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

  test("a tool with no kind is treated as a side effect and never runs in the parallel batch", async () => {
    let running = 0;
    let maxRunning = 0;
    const kindless = (name: string) =>
      ({
        name,
        description: "x",
        schema: z.object({}),
        summarize: () => name,
        subject: () => ({ paths: [] }),
        run: async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await Bun.sleep(10);
          running--;
          return { content: name };
        },
      }) as unknown as AnyTool;
    const h = harness(
      [() => reply([toolUseBlock("k1", "K1", {}), toolUseBlock("k2", "K2", {})], "tool_use"), () => reply([textBlock("ok")])],
      { mode: "bypass", tools: [kindless("K1"), kindless("K2")] },
    );
    await run(h);
    expect(maxRunning).toBe(1);
    expect((h.agent.messages[2]!.content as Array<{ content: string }>).map((r) => r.content)).toEqual(["K1", "K2"]);
  });

  test("a tool with no kind is refused in plan mode like any command", async () => {
    let ran = false;
    const kindless = {
      name: "K",
      description: "x",
      schema: z.object({}),
      summarize: () => "k",
      subject: () => ({ paths: [] }),
      run: async () => {
        ran = true;
        return { content: "ran" };
      },
    } as unknown as AnyTool;
    const h = harness([() => reply([toolUseBlock("k", "K", {})], "tool_use"), () => reply([textBlock("ok")])], { mode: "plan", tools: [kindless] });
    await run(h);
    expect(ran).toBe(false);
    expect((h.agent.messages[2]!.content as Array<{ content: string }>)[0]!.content).toBe(PLAN_MODE_REASON);
  });

  test("permission prompts never overlap", async () => {
    // Two parallel read tools whose paths fall outside allowedDirs: each one asks at the same time.
    const outside = (name: string) =>
      defineTool({
        name,
        kind: "read",
        description: "x",
        schema: z.object({}),
        summarize: () => name,
        subject: () => ({ paths: [`/elsewhere/${name}`] }),
        run: async () => ({ content: name }),
      });
    let open = 0;
    let maxOpen = 0;
    const h = harness(
      [() => reply([toolUseBlock("r1", "R1", {}), toolUseBlock("r2", "R2", {})], "tool_use"), () => reply([textBlock("ok")])],
      {
        tools: [outside("R1"), outside("R2")] as AnyTool[],
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
    const results = h.agent.messages[2]!.content as Array<{ content: string }>;
    expect(results.map((r) => r.content)).toEqual(["R1", "R2"]);
  });

  test("usage events accumulate cost", async () => {
    const h = harness([() => reply([textBlock("a")])]);
    await run(h);
    const usage = h.events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, contextTokens: 100 });
    expect(h.agent.totalCostUsd).toBeCloseTo((100 * 4 + 20 * 20) / 1_000_000, 9);
  });

  test("a reply from a model with no known price makes the session cost unknown, not $0", async () => {
    const h = harness([() => reply([textBlock("a")], "end_turn", "mystery-model"), () => reply([textBlock("b")])]);
    await run(h, "one");
    expect(h.agent.totalCostUsd).toBeUndefined();
    expect(h.events.find((e) => e.type === "usage")).toMatchObject({ costUsd: undefined, totalCostUsd: undefined });
    await run(h, "two");
    expect(h.agent.totalCostUsd).toBeUndefined();
  });
});

describe("Agent failure paths keep history valid", () => {
  const toolTurn = () => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "tool_use");

  test("persist rejecting does not escape run()", async () => {
    const h = harness([toolTurn, () => reply([textBlock("ok")]), () => reply([textBlock("again")])], {
      mode: "bypass",
      persist: async (m) => {
        if (m.role === "assistant") throw new Error("disk full");
      },
    });
    expect(await run(h)).toBe("end_turn");
    assertToolPairs(h.agent.messages);
    expect(h.events.some((e) => e.type === "notice" && e.level === "error" && e.text.startsWith("Could not save the session: disk full"))).toBe(true);
    expect(await run(h, "next")).toBe("end_turn");
    assertToolPairs(h.agent.messages);
    assertToolPairs(h.model.requests[2]!.messages);
  });

  test("a dangling tool_use at the start of run() is closed first", async () => {
    const history = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      { role: "assistant" as const, content: [toolUseBlock("old", "Echo", { text: "x" })] },
    ] as never;
    const model = new FakeModel([() => reply([textBlock("ok")])]);
    const agent = new Agent(
      {
        model,
        tools: [echo] as AnyTool[],
        system: "s",
        config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
        permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
        askPermission: async () => ({ kind: "allow" }),
        contextText: async () => "c",
        persist: async () => {},
        toolContext: makeToolContext({ root: "/work" }),
        emit: () => {},
      },
      history,
    );
    await agent.run("go", new AbortController().signal);
    assertToolPairs(agent.messages);
    expect(agent.messages[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "old", is_error: true }] });
  });

  test("onAllowAlways rejecting becomes an error result", async () => {
    sleeperRuns = 0;
    const h = harness([toolTurn, () => reply([textBlock("ok")])], {
      answer: { kind: "allow_always", rule: "Sleep(sleep:*)" },
      onAllowAlways: async () => {
        throw new Error("settings not writable");
      },
    });
    expect(await run(h)).toBe("end_turn");
    assertToolPairs(h.agent.messages);
    const result = (h.agent.messages[2]!.content as Array<{ content: string; is_error: boolean }>)[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("settings not writable");
    expect(sleeperRuns).toBe(0);
  });

  test("emit throwing on tool_start does not break the loop", async () => {
    const h = harness([() => reply([toolUseBlock("a", "Echo", { text: "1" })], "tool_use"), () => reply([textBlock("done")])], {
      emit: (e) => {
        if (e.type === "tool_start") throw new Error("listener bug");
      },
    });
    expect(await run(h)).toBe("end_turn");
    assertToolPairs(h.agent.messages);
    expect(h.agent.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "echo:1" }] });
  });

  test("summarize throwing becomes an error result", async () => {
    const bad = defineTool({
      name: "Bad",
      kind: "read",
      description: "x",
      schema: z.object({}),
      summarize: () => {
        throw new Error("no summary");
      },
      subject: () => ({ paths: [] }),
      run: async () => ({ content: "ran" }),
    });
    const h = harness([() => reply([toolUseBlock("b", "Bad", {})], "tool_use"), () => reply([textBlock("ok")])], { tools: [bad] as AnyTool[] });
    expect(await run(h)).toBe("end_turn");
    assertToolPairs(h.agent.messages);
    const result = (h.agent.messages[2]!.content as Array<{ content: string; is_error: boolean }>)[0]!;
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain("Bad failed: no summary");
  });

  test("abort unblocks an open permission prompt", async () => {
    const controller = new AbortController();
    const h = harness([toolTurn, () => reply([textBlock("ok")])], { ask: () => new Promise<PermissionAnswer>(() => {}) });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    expect(await run(h, "go", controller.signal)).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(300);
    assertToolPairs(h.agent.messages);

  });

  test("the same agent prompts again after an aborted prompt", async () => {
    let calls = 0;
    const h = harness([toolTurn, toolTurn, () => reply([textBlock("ok")])], {
      ask: (_p, signal) => {
        calls++;
        if (calls === 1) return new Promise<PermissionAnswer>(() => {}); // never answers
        expect(signal.aborted).toBe(false);
        return Promise.resolve({ kind: "allow" });
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(await run(h, "one", controller.signal)).toBe("aborted");
    expect(await run(h, "two")).toBe("end_turn");
    expect(calls).toBe(2);
    assertToolPairs(h.agent.messages);
  });

  test("an empty assistant reply is not recorded", async () => {
    for (const stop of ["refusal", "end_turn"]) {
      const h = harness([() => reply([], stop), () => reply([textBlock("hi")])]);
      await run(h);
      expect(h.agent.messages.some((m) => m.role === "assistant" && m.content.length === 0)).toBe(false);
      expect(await run(h, "again")).toBe("end_turn");
      expect(h.model.requests[1]!.messages.every((m) => m.content.length > 0)).toBe(true);
      assertToolPairs(h.agent.messages);
    }
  });

  test("isDenied checks a read of the path", async () => {
    let seen: ((p: string) => boolean) | undefined;
    const probe = defineTool({
      name: "Probe",
      kind: "read",
      description: "x",
      schema: z.object({}),
      summarize: () => "probe",
      subject: () => ({ paths: [] }),
      run: async (_i, ctx) => {
        seen = ctx.isDenied;
        return { content: "ok" };
      },
    });
    const h = harness([() => reply([toolUseBlock("p", "Probe", {})], "tool_use"), () => reply([textBlock("ok")])], {
      tools: [probe] as AnyTool[],
      deny: ["Read(secret.txt)"],
    });
    await run(h);
    expect(seen?.("/work/secret.txt")).toBe(true);
    expect(seen?.("/work/other.txt")).toBe(false);
  });

  test("context window exceeded with tool calls: not run, turn ends", async () => {
    sleeperRuns = 0;
    const h = harness([() => reply([toolUseBlock("s", "Sleep", { ms: 1 })], "model_context_window_exceeded")], { mode: "bypass" });
    expect(await run(h)).toBe("context_exceeded");
    expect(sleeperRuns).toBe(0);
    assertToolPairs(h.agent.messages);
    const result = (h.agent.messages[2]!.content as Array<{ content: string; is_error: boolean }>)[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("no longer fits");
    expect(h.events.some((e) => e.type === "notice" && e.level === "error")).toBe(true);
    expect(h.model.requests).toHaveLength(1);
  });

  test("isDenied honours tool-specific and Read deny rules", async () => {
    let seen: ((p: string) => boolean) | undefined;
    const grep = defineTool({
      name: "Grep",
      kind: "read",
      description: "x",
      schema: z.object({}),
      summarize: () => "grep",
      subject: () => ({ paths: [] }),
      run: async (_i, ctx) => {
        seen = ctx.isDenied;
        return { content: "ok" };
      },
    });
    const h = harness([() => reply([toolUseBlock("g", "Grep", {})], "tool_use"), () => reply([textBlock("ok")])], {
      tools: [grep] as AnyTool[],
      deny: ["Grep(secrets/**)", "Read(x.txt)"],
    });
    await run(h);
    expect(seen?.("/work/secrets/a")).toBe(true);
    expect(seen?.("/work/x.txt")).toBe(true);
    expect(seen?.("/work/other.txt")).toBe(false);
  });

  test("contextText throwing ends the turn with an error instead of rejecting", async () => {
    const h = harness([() => reply([textBlock("never")])]);
    const broken = new Agent({
      model: h.model,
      tools: [],
      system: "s",
      config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
      permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
      askPermission: async () => ({ kind: "allow" }),
      contextText: async () => {
        throw new Error("no git");
      },
      persist: async () => {},
      toolContext: makeToolContext({ root: "/work" }),
      emit: (e) => h.events.push(e),
    });
    expect(await broken.run("go", new AbortController().signal)).toBe("error");
    expect(h.events.find((e) => e.type === "notice")).toMatchObject({ level: "error", text: expect.stringContaining("no git") });
    expect(h.events.at(-1)).toEqual({ type: "turn_end", reason: "error" });
    expect(h.model.requests).toHaveLength(0);
  });

  test("config throwing after tool results were pushed keeps history valid", async () => {
    let calls = 0;
    const events: AgentEvent[] = [];
    const model = new FakeModel([() => reply([toolUseBlock("a", "Echo", { text: "1" })], "tool_use")]);
    const agent = new Agent({
      model,
      tools: [echo] as AnyTool[],
      system: "s",
      config: () => {
        if (++calls === 2) throw new Error("bad settings");
        return { model: "claude-opus-5-5", effort: "high", refusalFallback: true };
      },
      permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
      askPermission: async () => ({ kind: "allow" }),
      contextText: async () => "c",
      persist: async () => {},
      toolContext: makeToolContext({ root: "/work" }),
      emit: (e) => events.push(e),
    });
    expect(await agent.run("go", new AbortController().signal)).toBe("error");
    assertToolPairs(agent.messages);
    expect(events.find((e) => e.type === "notice")).toMatchObject({ level: "error", text: expect.stringContaining("bad settings") });
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "error" });
  });

  test("a stuck tool does not hang an aborted turn", async () => {
    const stuck = defineTool({
      name: "Stuck",
      kind: "exec",
      description: "x",
      schema: z.object({}),
      summarize: () => "stuck",
      subject: () => ({ command: "stuck", paths: [] }),
      run: () => new Promise<never>(() => {}),
    });
    const controller = new AbortController();
    const h = harness([() => reply([toolUseBlock("k", "Stuck", {})], "tool_use")], { mode: "bypass", tools: [stuck] as AnyTool[] });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    expect(await run(h, "go", controller.signal)).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(300);
    assertToolPairs(h.agent.messages);
    expect((h.agent.messages.at(-1)!.content as Array<{ content: string }>)[0]!.content).toBe("[interrupted by user]");
  });
  test("a tool that rejects after an abort during onAllowAlways causes no unhandled rejection", async () => {
    const late = defineTool({
      name: "Late",
      kind: "exec",
      description: "x",
      schema: z.object({}),
      summarize: () => "late",
      subject: () => ({ command: "late", paths: [] }),
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("late failure");
      },
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const controller = new AbortController();
      const h = harness([() => reply([toolUseBlock("l", "Late", {})], "tool_use")], {
        tools: [late] as AnyTool[],
        answer: { kind: "allow_always", rule: "Late(x)" },
        onAllowAlways: () => controller.abort(),
      });
      expect(await run(h, "go", controller.signal)).toBe("aborted");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("a failure that throws a non-Error value ends the turn with an error instead of rejecting", async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model: new FakeModel([() => reply([textBlock("never")])]),
      tools: [echo] as AnyTool[],
      system: "s",
      config: () => {
        throw null;
      },
      permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
      askPermission: async () => ({ kind: "allow" }),
      contextText: async () => "c",
      persist: async () => {},
      toolContext: makeToolContext({ root: "/work" }),
      emit: (e) => events.push(e),
    });
    expect(await agent.run("go", new AbortController().signal)).toBe("error");
    expect(events.find((e) => e.type === "notice")).toMatchObject({ level: "error", text: expect.stringContaining("null") });
  });

  test("a failure that throws an unprintable value still ends the turn with an error", async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model: new FakeModel([() => reply([textBlock("never")])]),
      tools: [echo] as AnyTool[],
      system: "s",
      config: () => {
        throw Object.create(null);
      },
      permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
      askPermission: async () => ({ kind: "allow" }),
      contextText: async () => "c",
      persist: async () => {},
      toolContext: makeToolContext({ root: "/work" }),
      emit: (e) => events.push(e),
    });
    expect(await agent.run("go", new AbortController().signal)).toBe("error");
    expect(events.find((e) => e.type === "notice")).toMatchObject({ level: "error", text: expect.stringContaining("[object Object]") });
  });

  test("a tool that rejects with a non-Error value becomes an error result", async () => {
    const odd = defineTool({
      name: "Odd",
      kind: "read",
      description: "x",
      schema: z.object({}),
      summarize: () => "odd",
      subject: () => ({ paths: [] }),
      run: () => Promise.reject("plain string"),
    });
    const h = harness([() => reply([toolUseBlock("o", "Odd", {})], "tool_use"), () => reply([textBlock("ok")])], { tools: [odd] as AnyTool[] });
    expect(await run(h)).toBe("end_turn");
    const result = (h.agent.messages[2]!.content as Array<{ content: string; is_error: boolean }>)[0]!;
    expect(result).toMatchObject({ is_error: true, content: "Odd failed: plain string" });
  });
});
