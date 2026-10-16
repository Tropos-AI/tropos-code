// src/learning/review.test.ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { FakeModel, reply, textBlock, toolUseBlock } from "../../test/helpers/fake-model";
import { makeToolContext } from "../../test/helpers/tool-context";
import { settle, waitFor } from "../../test/helpers/wait";
import type { AgentHooks } from "../agent/agent";
import type { Mode } from "../config/constants";
import { compileRules } from "../permissions/engine";
import type { MessageParam } from "../session/store";
import { toolToApi } from "../api/model";
import { defineTool, type Actor, type AnyTool } from "../tools/types";
import { FINAL_PROMPT, FLUSH_PROMPT, MEMORY_REVIEW_PROMPT, NOTHING, REVIEW_ALLOWED_TOOLS, REVIEW_WRITE_TOOLS } from "./review-prompts";
import {
  LearningLoop,
  REVIEW_PROMPTS,
  flushWindow,
  learnedNotice,
  reviewAskPermission,
  reviewToolGate,
  runReviewAgent,
  type LearningLoopDeps,
  type ReviewKind,
  type ReviewResult,
  type RunReviewAgentOptions,
} from "./review";
import type { LearningCounters } from "./counters";

// --- fake tools -------------------------------------------------------------------------------------------

interface Ran {
  name: string;
  input: Record<string, unknown>;
  actor?: Actor;
}

function makeTools(ran: Ran[]): AnyTool[] {
  const tool = (name: string, kind: "read" | "edit" | "exec", path?: string) =>
    defineTool({
      name,
      kind,
      description: `${name} tool`,
      schema: z.object({ action: z.string().optional(), text: z.string().optional() }),
      summarize: (i) => `${i.action ?? "run"} ${i.text ?? ""}`.trim(),
      subject: (i) => (kind === "exec" ? { paths: [], command: i.text ?? "" } : { paths: path ? [path] : [] }),
      run: async (input, ctx) => {
        ran.push({ name, input, actor: ctx.actor });
        return { content: `${name} ok` };
      },
    }) as AnyTool;
  return [
    tool("Bash", "exec"),
    tool("Read", "read"),
    tool("Memory", "edit", "/h/.tropos/memories/MEMORY.md"),
    tool("Write", "edit", "/work/a.ts"),
    tool("SkillManage", "edit", "/h/.tropos/skills/x/SKILL.md"),
    tool("DailyNote", "edit", "/h/.tropos/daily/today.md"),
  ];
}

const history: MessageParam[] = [
  { role: "user", content: "fix the build, and please always use bun" },
  { role: "assistant", content: [{ type: "text", text: "Done: the build is fixed." }] },
];

function options(model: FakeModel, ran: Ran[], over: Partial<RunReviewAgentOptions> & { mode?: Mode; deny?: string[]; ask?: string[] } = {}): RunReviewAgentOptions {
  const { mode = "default", deny = [], ask = [], ...rest } = over;
  return {
    model,
    tools: makeTools(ran),
    system: "SYSTEM",
    config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
    permissions: () => ({ mode, rules: compileRules({ allow: [], ask, deny }).rules, cwd: "/work", home: "/h", allowedDirs: ["/work"] }),
    toolContext: makeToolContext({ root: "/work" }),
    history,
    prompt: MEMORY_REVIEW_PROMPT,
    signal: new AbortController().signal,
    ...rest,
  };
}

// --- runReviewAgent ---------------------------------------------------------------------------------------

describe("runReviewAgent", () => {
  test("an empty conversation never reaches the model", async () => {
    const model = new FakeModel([]);
    const result = await runReviewAgent(options(model, [], { history: [] }));
    expect(result).toEqual({ changes: [], reply: "" });
    expect(model.requests).toHaveLength(0);
  });

  test("saves through the allowed tools, refuses the rest, and reports what changed", async () => {
    const ran: Ran[] = [];
    const model = new FakeModel([
      () =>
        reply(
          [
            toolUseBlock("t1", "Memory", { action: "add", text: "user prefers bun" }),
            toolUseBlock("t2", "Bash", { text: "rm -rf /" }),
            toolUseBlock("t3", "Write", { text: "x" }),
            toolUseBlock("t4", "Read", { text: "README.md" }),
          ],
          "tool_use",
        ),
      () =>
        reply(
          [
            toolUseBlock("t5", "SkillManage", { action: "delete", text: "old" }),
            toolUseBlock("t6", "SkillManage", { action: "patch", text: "bun-build" }),
          ],
          "tool_use",
        ),
      () => reply([textBlock("Saved a preference and patched a skill.")]),
    ]);
    const input = [...history];
    const result = await runReviewAgent(options(model, ran, { history: input }));

    expect(result.changes).toEqual([
      { tool: "Memory", summary: "Memory add user prefers bun" },
      { tool: "SkillManage", summary: "SkillManage patch bun-build" },
    ]);
    expect(result.reply).toBe("Saved a preference and patched a skill.");
    expect(result.costUsd).toBeGreaterThan(0);
    // Only allowed tools ran, all as the review.
    expect(ran.map((r) => r.name)).toEqual(["Memory", "Read", "SkillManage"]);
    expect(ran.every((r) => r.actor === "review")).toBe(true);

    // Same system prompt and the same tool definitions in the same order: the prompt cache is shared.
    const first = model.requests[0]!;
    expect(first.system).toBe("SYSTEM");
    expect(first.tools.map(toolToApi)).toEqual(makeTools([]).map(toolToApi));
    // The history is continued with one user message carrying the review prompt; the caller's copy is untouched.
    expect(first.messages.slice(0, 2)).toEqual(history);
    expect(first.messages).toHaveLength(3);
    const last = first.messages[2]!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("Learning review");
    expect(input).toEqual(history);

    const results = model.requests[1]!.messages.at(-1)!.content as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
    expect(results.find((r) => r.tool_use_id === "t2")).toMatchObject({ content: "Bash isn't available during the learning review.", is_error: true });
    expect(results.find((r) => r.tool_use_id === "t3")).toMatchObject({ content: "Write isn't available during the learning review.", is_error: true });
    const second = model.requests[2]!.messages.at(-1)!.content as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
    expect(second.find((r) => r.tool_use_id === "t5")).toMatchObject({ is_error: true });
  });

  test("deny rules still win", async () => {
    const ran: Ran[] = [];
    const model = new FakeModel([
      () => reply([toolUseBlock("t1", "Memory", { action: "add", text: "x" })], "tool_use"),
      () => reply([textBlock(NOTHING)]),
    ]);
    const result = await runReviewAgent(options(model, ran, { deny: ["Memory"] }));
    expect(result.changes).toEqual([]);
    expect(ran).toEqual([]);
    expect(result.reply).toBe(NOTHING);
  });

  test("plan mode doesn't stop the review's own writes; bypass doesn't let it delete or step outside", async () => {
    for (const mode of ["plan", "bypass", "acceptEdits"] as const) {
      const ran: Ran[] = [];
      const model = new FakeModel([
        () =>
          reply(
            [
              toolUseBlock("t1", "DailyNote", { action: "append", text: "decided X" }),
              toolUseBlock("t2", "SkillManage", { action: "delete", text: "old" }),
            ],
            "tool_use",
          ),
        () => reply([textBlock("ok")]),
      ]);
      const result = await runReviewAgent(options(model, ran, { mode }));
      expect(result.changes).toEqual([{ tool: "DailyNote", summary: "DailyNote append decided X" }]);
      expect(ran.map((r) => r.name)).toEqual(["DailyNote"]);
    }
  });

  test("the reply is the review's own text, never the conversation's", async () => {
    const model = new FakeModel([
      () => reply([toolUseBlock("t1", "Read", { text: "a" })], "tool_use"),
      () => reply([], "end_turn"),
    ]);
    const result = await runReviewAgent(options(model, []));
    expect(result.reply).toBe("");
  });

  test("stops after maxTurns (16 by default)", async () => {
    const steps = Array.from({ length: 20 }, (_, i) => () => reply([toolUseBlock(`t${i}`, "Read", { text: "a" })], "tool_use"));
    const model = new FakeModel(steps);
    await runReviewAgent(options(model, []));
    expect(model.requests).toHaveLength(16);
    const model2 = new FakeModel([...steps]);
    await runReviewAgent(options(model2, [], { maxTurns: 2 }));
    expect(model2.requests).toHaveLength(2);
  });

  test("an aborted review returns what it saved so far", async () => {
    const controller = new AbortController();
    const model = new FakeModel([
      () => reply([toolUseBlock("t1", "Memory", { action: "add", text: "x" })], "tool_use"),
      () => {
        controller.abort();
        throw new Error("aborted");
      },
    ]);
    const result = await runReviewAgent(options(model, [], { signal: controller.signal }));
    expect(result.changes.map((c) => c.tool)).toEqual(["Memory"]);
  });

  test("only tool hooks fire for the review", async () => {
    const asked: string[] = [];
    const hooks: AgentHooks = {
      has: (event) => {
        asked.push(event);
        return true;
      },
      run: async (event) => ({ additionalContext: [], messages: [], errors: [], ...(event === "PreToolUse" ? { blocked: "no" } : {}) }),
    };
    const ran: Ran[] = [];
    const model = new FakeModel([
      () => reply([toolUseBlock("t1", "Memory", { action: "add", text: "x" })], "tool_use"),
      () => reply([textBlock("done")]),
    ]);
    const result = await runReviewAgent(options(model, ran, { hooks }));
    // The PreToolUse hook blocked the write; UserPromptSubmit and Stop never ran.
    expect(ran).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(asked).not.toContain("UserPromptSubmit");
    expect(asked).not.toContain("Stop");
    expect(asked).toContain("PreToolUse");
  });

  test("the user's ask rules count as deny: nobody is there to answer", async () => {
    const ran: Ran[] = [];
    const model = new FakeModel([
      () => reply([toolUseBlock("t1", "Memory", { action: "add", text: "x" }), toolUseBlock("t2", "DailyNote", { text: "y" })], "tool_use"),
      () => reply([textBlock("done")]),
    ]);
    const result = await runReviewAgent(options(model, ran, { ask: ["Memory"] }));
    expect(ran.map((r) => r.name)).toEqual(["DailyNote"]);
    expect(result.changes.map((c) => c.tool)).toEqual(["DailyNote"]);
  });

  test("a hook's ask becomes a deny, and hooks never see calls to tools the review can't run", async () => {
    const seen: Array<string | undefined> = [];
    const hooks: AgentHooks = {
      has: () => true,
      run: async (event, _input, match) => {
        seen.push(`${event}:${match}`);
        return { additionalContext: [], messages: [], errors: [], ...(event === "PreToolUse" && match === "Memory" ? { permission: "ask" as const } : {}) };
      },
    };
    const ran: Ran[] = [];
    const model = new FakeModel([
      () =>
        reply(
          [toolUseBlock("t1", "Memory", { action: "add", text: "x" }), toolUseBlock("t2", "Bash", { text: "ls" }), toolUseBlock("t3", "DailyNote", { text: "y" })],
          "tool_use",
        ),
      () => reply([textBlock("done")]),
    ]);
    const result = await runReviewAgent(options(model, ran, { hooks }));
    expect(ran.map((r) => r.name)).toEqual(["DailyNote"]);
    expect(result.changes.map((c) => c.tool)).toEqual(["DailyNote"]);
    expect(seen.some((s) => s?.endsWith(":Bash"))).toBe(false);
    expect(seen).toContain("PreToolUse:Memory");
  });
});

// --- reviewToolGate / reviewAskPermission -----------------------------------------------------------------

describe("reviewToolGate", () => {
  const ctx = makeToolContext({ root: "/work" });

  test("keeps names, descriptions, schemas and order; gated tools refuse without a prompt", async () => {
    const tools = makeTools([]);
    const mcp = { ...tools[0]!, name: "mcp__x__y", inputSchema: { type: "object" as const, properties: { q: { type: "string" } } } } as AnyTool;
    const all = [...tools, mcp];
    const gated = reviewToolGate(all);
    expect(gated.map((t) => [t.name, t.description, t.schema])).toEqual(all.map((t) => [t.name, t.description, t.schema]));
    expect(gated.map(toolToApi)).toEqual(all.map(toolToApi));

    const bash = gated[0]!;
    expect(bash.kind).toBe("meta");
    expect(bash.subject({ text: "rm" }, "/work")).toEqual({ paths: [] });
    expect(bash.summarize({ text: "ls" })).toBe("run ls");
    expect(await bash.run({}, ctx)).toEqual({ content: "Bash isn't available during the learning review.", isError: true });
    expect(gated.at(-1)!.inputSchema).toEqual(mcp.inputSchema);
    expect("inputSchema" in bash).toBe(false);

    // Allowed tools pass through untouched, except the writers the review may only use in part.
    expect(gated[1]).toBe(all[1]!);
    expect(gated[5]).toBe(all[5]!);
    expect(gated[2]).not.toBe(all[2]!);
  });

  test("Memory may add, replace and consolidate during the review; a lone remove is refused", async () => {
    const ran: Ran[] = [];
    const memory = reviewToolGate(makeTools(ran)).find((t) => t.name === "Memory")!;
    expect(memory.kind).toBe("edit");
    expect(memory.subject({ action: "add" }, "/work")).toEqual({ paths: ["/h/.tropos/memories/MEMORY.md"] });
    for (const ok of [{ action: "add" }, { action: "replace" }, { operations: [{ action: "remove" }, { action: "add" }] }]) expect(await memory.run(ok, ctx)).toEqual({ content: "Memory ok" });
    for (const bad of [{ action: "remove" }, { operations: [{ action: "remove" }] }, { operations: [] }, null]) expect(await memory.run(bad, ctx)).toMatchObject({ isError: true });
    expect(await memory.run({ action: "remove" }, ctx)).toEqual({ content: "The learning review can't only remove notes; replace or merge them instead.", isError: true });
    expect(ran).toHaveLength(3);
    expect(reviewAskPermission({ toolName: "Memory", kind: "edit", summary: "", input: { action: "replace" } })).toEqual({ kind: "allow" });
    expect(reviewAskPermission({ toolName: "Memory", kind: "edit", summary: "", input: { action: "remove" } })).toMatchObject({ kind: "deny" });
  });

  test("the memory rules tell the review to replace and consolidate, never only remove", () => {
    expect(MEMORY_REVIEW_PROMPT).toContain("Never only remove");
  });

  test("an override runs under the same name, description and schema", async () => {
    const ran: Ran[] = [];
    const tools = makeTools(ran);
    const gated = reviewToolGate(tools, undefined, {
      SkillManage: { subject: () => ({ paths: ["/h/.tropos/skills-learned/x/SKILL.md"] }), run: async () => ({ content: "learned ok" }) },
    });
    const skill = gated.find((t) => t.name === "SkillManage")!;
    expect(toolToApi(skill)).toEqual(toolToApi(tools.find((t) => t.name === "SkillManage")!));
    expect(skill.subject({ action: "create" }, "/work")).toEqual({ paths: ["/h/.tropos/skills-learned/x/SKILL.md"] });
    expect(await skill.run({ action: "create" }, ctx)).toEqual({ content: "learned ok" });
    expect(await skill.run({ action: "delete" }, ctx)).toMatchObject({ isError: true });
    expect(ran).toEqual([]);
  });

  test("SkillManage keeps its kind and paths but never deletes", async () => {
    const ran: Ran[] = [];
    const skill = reviewToolGate(makeTools(ran)).find((t) => t.name === "SkillManage")!;
    expect(skill.kind).toBe("edit");
    expect(skill.subject({ action: "patch" }, "/work")).toEqual({ paths: ["/h/.tropos/skills/x/SKILL.md"] });
    expect(await skill.run({ action: "delete" }, ctx)).toMatchObject({ isError: true });
    expect(await skill.run({ action: "patch" }, ctx)).toEqual({ content: "SkillManage ok" });
    expect(ran.map((r) => r.input.action)).toEqual(["patch"]);
  });

  test("a custom allowlist", () => {
    const gated = reviewToolGate(makeTools([]), ["Read"]);
    expect(gated.filter((t) => t.kind === "meta").map((t) => t.name)).toEqual(["Bash", "Memory", "Write", "SkillManage", "DailyNote"]);
  });
});

describe("reviewAskPermission", () => {
  const prompt = (toolName: string, input: unknown = {}) => ({ toolName, kind: "edit" as const, summary: "", input });
  test("approves the review's writes, never a delete, never anything else", () => {
    for (const name of REVIEW_WRITE_TOOLS) expect(reviewAskPermission(prompt(name, { action: "add" }))).toEqual({ kind: "allow" });
    expect(reviewAskPermission(prompt("SkillManage", { action: "delete" })).kind).toBe("deny");
    expect(reviewAskPermission(prompt("SkillManage", null)).kind).toBe("allow");
    expect(reviewAskPermission(prompt("Read")).kind).toBe("deny");
    expect(reviewAskPermission(prompt("Bash")).kind).toBe("deny");
  });
});

// --- LearningLoop -----------------------------------------------------------------------------------------

interface Call {
  kind: ReviewKind;
  prompt: string;
  history: MessageParam[];
  signal: AbortSignal;
  resolve(result: ReviewResult): void;
  reject(err: unknown): void;
}

function harness(settings: Partial<ReturnType<LearningLoopDeps["settings"]>> = {}, extra: Partial<LearningLoopDeps> = {}) {
  const calls: Call[] = [];
  const notices: string[] = [];
  const config = { review: true, interval: 3, flushAt: 0.7, ...settings };
  const loop = new LearningLoop({
    settings: () => config,
    runReview: (kind, prompt, h, signal) =>
      new Promise<ReviewResult>((resolve, reject) => {
        calls.push({ kind, prompt, history: h, signal, resolve, reject });
      }),
    notice: (text) => notices.push(text),
    now: () => 42,
    ...extra,
  });
  const done = (r: Partial<ReviewResult> = {}) => calls.at(-1)!.resolve({ changes: [], reply: NOTHING, ...r });
  return { loop, calls, notices, config, done };
}

const turns = (loop: LearningLoop, n: number, reason: "end_turn" | "aborted" = "end_turn") => {
  for (let i = 0; i < n; i++) loop.afterTurn(reason, history);
};

describe("LearningLoop", () => {
  test("a memory review after `interval` user turns, with a copy of the history", async () => {
    const { loop, calls, done } = harness();
    turns(loop, 2);
    expect(calls).toHaveLength(0);
    turns(loop, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("memory");
    expect(calls[0]!.prompt).toBe(REVIEW_PROMPTS.memory);
    expect(calls[0]!.history).toEqual(history);
    expect(calls[0]!.history).not.toBe(history);
    expect(loop.running).toBe(true);
    expect(loop.last).toEqual({ kind: "memory", startedAt: 42, changes: 0 });
    done();
    await loop.whenIdle();
    expect(loop.running).toBe(false);
    // The counter restarted.
    turns(loop, 2);
    expect(calls).toHaveLength(1);
    turns(loop, 1);
    expect(calls).toHaveLength(2);
  });

  test("a skill review after `interval` tool calls; both due means combined", async () => {
    const { loop, calls, done } = harness();
    for (let i = 0; i < 3; i++) loop.onToolEnd("Read", "done");
    loop.afterTurn("end_turn", history);
    expect(calls.map((c) => c.kind)).toEqual(["skill"]);
    done();
    await loop.whenIdle();

    turns(loop, 1);
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 3; i++) loop.onToolEnd("Bash", i === 0 ? "error" : "denied");
    turns(loop, 1);
    expect(calls.map((c) => c.kind)).toEqual(["skill", "combined"]);
    expect(calls[1]!.prompt).toBe(REVIEW_PROMPTS.combined);
  });

  test("the main agent's own saves postpone the matching review; failed ones don't", () => {
    const { loop, calls } = harness();
    turns(loop, 2);
    loop.onToolEnd("Memory", "done");
    turns(loop, 1);
    expect(calls).toHaveLength(0);
    for (let i = 0; i < 2; i++) loop.onToolEnd("Read", "done");
    loop.onToolEnd("SkillManage", "done");
    loop.onToolEnd("Memory", "error");
    loop.onToolEnd("SkillManage", "denied");
    turns(loop, 1);
    expect(calls).toHaveLength(0);
    loop.onToolEnd("Read", "done");
    turns(loop, 1);
    expect(calls.map((c) => c.kind)).toEqual(["combined"]);
  });

  test("only after a turn that ended normally, and only when reviews are on", () => {
    const { loop, calls, config } = harness();
    turns(loop, 5, "aborted");
    expect(calls).toHaveLength(0);
    config.review = false;
    turns(loop, 1);
    expect(calls).toHaveLength(0);
    loop.afterTurn("end_turn", []);
    expect(calls).toHaveLength(0);
    config.review = true;
    turns(loop, 1);
    expect(calls.map((c) => c.kind)).toEqual(["memory"]);
  });

  test("at most one review at a time; a skipped one runs on a later turn", async () => {
    const { loop, calls, done } = harness({ interval: 2 });
    turns(loop, 2);
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 2; i++) loop.onToolEnd("Read", "done");
    turns(loop, 2);
    expect(calls).toHaveLength(1);
    done();
    await loop.whenIdle();
    turns(loop, 1);
    expect(calls.map((c) => c.kind)).toEqual(["memory", "combined"]);
  });

  test("flush: once per compaction cycle, ahead of a due review, re-armed when the context shrinks", async () => {
    const { loop, calls, done } = harness();
    loop.onUsage(140_000, 200_000);
    loop.afterTurn("end_turn", history);
    expect(calls.map((c) => c.kind)).toEqual(["flush"]);
    expect(calls[0]!.prompt).toBe(FLUSH_PROMPT);
    done();
    await loop.whenIdle();

    // Still above the threshold: no second flush; the memory review comes due as usual.
    loop.onUsage(150_000, 200_000);
    turns(loop, 2);
    expect(calls.map((c) => c.kind)).toEqual(["flush", "memory"]);
    done();
    await loop.whenIdle();

    // Compaction brought it to 40% (above 35%): still disarmed.
    loop.onUsage(80_000, 200_000);
    loop.onUsage(150_000, 200_000);
    turns(loop, 1);
    expect(calls).toHaveLength(2);
    // Below half the threshold re-arms it.
    loop.onUsage(60_000, 200_000);
    loop.onUsage(145_000, 200_000);
    turns(loop, 1);
    expect(calls.map((c) => c.kind)).toEqual(["flush", "memory", "flush"]);
  });

  test("a flush while a review runs waits for a later turn; a zero window is ignored", async () => {
    const { loop, calls, done } = harness();
    loop.onUsage(10, 0);
    turns(loop, 3);
    expect(calls.map((c) => c.kind)).toEqual(["memory"]);
    loop.onUsage(190_000, 200_000);
    turns(loop, 1);
    expect(calls).toHaveLength(1);
    done();
    await loop.whenIdle();
    turns(loop, 1);
    expect(calls.map((c) => c.kind)).toEqual(["memory", "flush"]);
  });

  test("a review that changed something leaves one notice line, clipped to 160 chars", async () => {
    const { loop, notices, done } = harness({ interval: 2 });
    turns(loop, 2);
    done({ changes: [{ tool: "Memory", summary: "Memory add user: prefers bun" }, { tool: "SkillManage", summary: "SkillManage patch release" }] });
    await loop.whenIdle();
    expect(notices).toEqual(["💡 Learned: Memory add user: prefers bun; SkillManage patch release"]);
    expect(loop.last?.changes).toBe(2);

    turns(loop, 2);
    done({ changes: [] });
    await loop.whenIdle();
    expect(notices).toHaveLength(1);

    const long = learnedNotice(Array.from({ length: 20 }, (_, i) => ({ tool: "Memory", summary: `Memory add memory: fact number ${i}` })));
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
  });

  test("cancel aborts the running review; saves made before the cancel are still announced", async () => {
    const { loop, calls, notices } = harness();
    loop.cancel();
    turns(loop, 3);
    loop.cancel();
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.resolve({ changes: [{ tool: "Memory", summary: "Memory add x" }], reply: "" });
    await loop.whenIdle();
    expect(notices).toEqual(["💡 Learned: Memory add x"]);
    expect(loop.last?.aborted).toBe(true);
    expect(loop.running).toBe(false);
  });

  test("a review cancelled before saving anything, or one that fails, is tried again on the next turn", async () => {
    const { loop, calls } = harness();
    turns(loop, 3);
    expect(calls).toHaveLength(1);
    loop.cancel();
    calls[0]!.resolve({ changes: [], reply: "" });
    await loop.whenIdle();
    turns(loop, 1);
    expect(calls).toHaveLength(2);
    calls[1]!.reject(new Error("model down"));
    await loop.whenIdle();
    turns(loop, 1);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.kind).toBe(calls[0]!.kind);
  });

  test("a failed review gives back only the counters it consumed", async () => {
    const { loop, calls } = harness({ interval: 3 });
    for (let i = 0; i < 2; i++) loop.onToolEnd("Read", "done");
    turns(loop, 3); // memory review fires (3 turns); skill counter is 2 tools, below interval
    expect(calls[0]!.kind).toBe("memory");
    calls[0]!.reject(new Error("down"));
    await loop.whenIdle();
    turns(loop, 1); // memory counter is back at 3; a doubled skill counter (4) would make this "combined"
    expect(calls[1]!.kind).toBe("memory");
  });

  test("errors are swallowed, sync or async, aborted or not", async () => {
    const { loop, calls, notices } = harness();
    turns(loop, 3);
    calls[0]!.reject(new Error("boom"));
    await loop.whenIdle();
    expect(loop.last).toMatchObject({ kind: "memory", failed: true });

    turns(loop, 3);
    loop.cancel();
    calls[1]!.reject(new Error("aborted"));
    await loop.whenIdle();
    expect(loop.last).toMatchObject({ aborted: true });
    expect(loop.last?.failed).toBeUndefined();

    const sync = new LearningLoop({
      settings: () => ({ review: true, interval: 2, flushAt: 0.7 }),
      runReview: () => {
        throw new Error("sync boom");
      },
      notice: (t) => notices.push(t),
    });
    turns(sync, 2);
    await sync.whenIdle();
    expect(sync.last).toMatchObject({ failed: true });
    expect(typeof sync.last?.startedAt).toBe("number");

    const loud = new LearningLoop({
      settings: () => ({ review: true, interval: 2, flushAt: 0.7 }),
      runReview: async () => ({ changes: [{ tool: "Memory", summary: "Memory add x" }], reply: "" }),
      notice: () => {
        throw new Error("ui gone");
      },
    });
    turns(loud, 2);
    await loud.whenIdle();
    expect(loud.last?.failed).toBe(true);
    expect(notices).toEqual([]);
  });
});

describe("LearningLoop.finish", () => {
  test("finish runs one final review on the last history when the session has unreviewed work, then resets the counters", async () => {
    const h = harness();
    turns(h.loop, 2);
    expect(h.loop.finalDue).toBe(true);
    const done = h.loop.finish(1000);
    h.done({ changes: [{ tool: "DailyNote", summary: "DailyNote noted" }] });
    await done;
    expect(h.calls.map((c) => c.kind)).toEqual(["final"]);
    expect(h.calls[0]!.prompt).toBe(REVIEW_PROMPTS.final);
    expect(h.calls[0]!.history).toEqual(history);
    expect(h.notices).toEqual(["💡 Learned: DailyNote noted"]);
    expect(h.loop.counters).toEqual({ turnsSinceMemory: 0, toolsSinceSkill: 0 });
    expect(h.loop.finalDue).toBe(false);
  });

  test("finish does nothing below 2 turns and 5 tool calls, or when no turn ended in this loop", async () => {
    const below = harness({ interval: 10 });
    for (let i = 0; i < 4; i++) below.loop.onToolEnd("Read", "done");
    turns(below.loop, 1);
    expect(below.loop.finalDue).toBe(false);
    await below.loop.finish(1000);
    expect(below.calls).toEqual([]);
    // The fifth tool call makes it due.
    below.loop.onToolEnd("Read", "done");
    expect(below.loop.finalDue).toBe(true);

    // Counters carried in from an earlier session, but nothing happened in this one.
    const idle = harness({ interval: 10 }, { initial: { turnsSinceMemory: 7, toolsSinceSkill: 9 } });
    expect(idle.loop.finalDue).toBe(false);
    await idle.loop.finish(1000);
    expect(idle.calls).toEqual([]);
    expect(idle.loop.counters).toEqual({ turnsSinceMemory: 7, toolsSinceSkill: 9 });

    // Reviews switched off: no final review either.
    const off = harness({ interval: 10, review: false });
    turns(off.loop, 3);
    expect(off.loop.finalDue).toBe(false);
    await off.loop.finish(1000);
    expect(off.calls).toEqual([]);
  });

  test("finish waits for a running review first and never starts two", async () => {
    const h = harness({ interval: 2 });
    turns(h.loop, 2);
    expect(h.calls.map((c) => c.kind)).toEqual(["memory"]);
    // Two more turns while the memory review runs: unreviewed work for the final review.
    turns(h.loop, 2);
    const first = h.loop.finish(1000);
    const second = h.loop.finish(1000);
    await settle();
    expect(h.calls).toHaveLength(1);
    h.calls[0]!.resolve({ changes: [], reply: NOTHING });
    await waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls.map((c) => c.kind)).toEqual(["memory", "final"]);
    h.done();
    await Promise.all([first, second]);
    await h.loop.finish(1000);
    expect(h.calls).toHaveLength(2);
  });

  test("finish aborts a review still running after the timeout and resolves", async () => {
    const h = harness();
    turns(h.loop, 2);
    await h.loop.finish(20);
    expect(h.calls.map((c) => c.kind)).toEqual(["final"]);
    expect(h.calls[0]!.signal.aborted).toBe(true);
    // Not finished, so the work stays unreviewed.
    expect(h.loop.counters).toEqual({ turnsSinceMemory: 2, toolsSinceSkill: 0 });
    // Saves the aborted review made before it stopped are kept and announced.
    h.calls[0]!.resolve({ changes: [{ tool: "DailyNote", summary: "DailyNote half" }], reply: "" });
    await h.loop.whenIdle();
    expect(h.notices).toEqual(["💡 Learned: DailyNote half"]);
  });

  test("cancel during finish resolves it at once, even when the review ignores the abort, and no final review starts after", async () => {
    const h = harness({ interval: 2 });
    turns(h.loop, 2);
    turns(h.loop, 2);
    // A regular review is running; finish waits for it.
    const done = h.loop.finish(60_000);
    h.loop.cancel();
    await done;
    expect(h.calls[0]!.signal.aborted).toBe(true);
    h.calls[0]!.resolve({ changes: [], reply: "" });
    await h.loop.whenIdle();
    await settle();
    expect(h.calls.map((c) => c.kind)).toEqual(["memory"]);

    const idle = harness();
    turns(idle.loop, 2);
    const final = idle.loop.finish(60_000);
    idle.loop.cancel();
    await final;
    expect(idle.calls[0]!.signal.aborted).toBe(true);
  });

  test("finish never rejects, even when the final review throws", async () => {
    const h = harness();
    turns(h.loop, 2);
    const done = h.loop.finish(1000);
    h.calls[0]!.reject(new Error("model down"));
    await done;
    expect(h.loop.last).toMatchObject({ kind: "final", failed: true });
    expect(h.loop.counters).toEqual({ turnsSinceMemory: 2, toolsSinceSkill: 0 });
  });

  test("counters start from initial and every change is saved", async () => {
    const saved: LearningCounters[] = [];
    const h = harness({ interval: 3 }, { initial: { turnsSinceMemory: 1, toolsSinceSkill: 0 }, saveCounters: (c) => saved.push(c) });
    expect(h.loop.counters).toEqual({ turnsSinceMemory: 1, toolsSinceSkill: 0 });
    turns(h.loop, 1);
    h.loop.onToolEnd("Read", "done");
    h.loop.onToolEnd("Memory", "done");
    expect(saved).toEqual([
      { turnsSinceMemory: 2, toolsSinceSkill: 0 },
      { turnsSinceMemory: 2, toolsSinceSkill: 1 },
      { turnsSinceMemory: 0, toolsSinceSkill: 2 },
    ]);
    // The third turn starts a memory review, which consumes the turn counter; a failed one gives it back.
    turns(h.loop, 3);
    expect(h.calls.map((c) => c.kind)).toEqual(["memory"]);
    expect(saved.at(-1)).toEqual({ turnsSinceMemory: 0, toolsSinceSkill: 2 });
    h.calls[0]!.reject(new Error("down"));
    await h.loop.whenIdle();
    expect(saved.at(-1)).toEqual({ turnsSinceMemory: 3, toolsSinceSkill: 2 });
    // A finished final review saves zeros.
    const done = h.loop.finish(1000);
    h.done();
    await done;
    expect(saved.at(-1)).toEqual({ turnsSinceMemory: 0, toolsSinceSkill: 0 });
    // Saved values are copies, never the loop's live state.
    expect(saved[0]).toEqual({ turnsSinceMemory: 2, toolsSinceSkill: 0 });
  });

  test("flushWindow: known models cap at the compaction trigger; unknown ones use 128,000", () => {
    expect(flushWindow("claude-opus-5-5")).toBe(150_000);
    expect(flushWindow("ollama/llama3")).toBe(128_000);
  });
});

describe("review prompts", () => {
  test("the final prompt says the session is ending and covers the journal, memory and skills", () => {
    expect(REVIEW_PROMPTS.final).toBe(FINAL_PROMPT);
    expect(FINAL_PROMPT).toContain("session is ending");
    for (const tool of ["DailyNote", "Memory", "SkillManage"]) expect(FINAL_PROMPT).toContain(tool);
    expect(FINAL_PROMPT).toContain("Never only remove");
    expect(FINAL_PROMPT).toContain("Never save:");
    expect(FINAL_PROMPT).toContain(`exactly ${NOTHING}`);
  });

  test("every kind has a prompt that says when to reply NOTHING", () => {
    for (const prompt of Object.values(REVIEW_PROMPTS)) expect(prompt).toContain(`exactly ${NOTHING}`);
    expect(REVIEW_PROMPTS.flush).toContain("DailyNote");
    expect(REVIEW_PROMPTS.memory).not.toContain("SkillManage");
    expect(REVIEW_PROMPTS.skill).toContain("SkillManage");
    expect(REVIEW_PROMPTS.combined).toContain("Memory");
    expect(REVIEW_PROMPTS.combined).toContain("SkillManage");
  });

  test("the write tools are a subset of the allowed tools", () => {
    for (const name of REVIEW_WRITE_TOOLS) expect(REVIEW_ALLOWED_TOOLS).toContain(name);
  });
});
