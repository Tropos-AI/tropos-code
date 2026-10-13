// src/providers/chat.test.ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { anthropicHistory } from "../api/model";
import type { MessageParam } from "../session/store";
import { defineTool, type AnyTool } from "../tools/types";
import { ChatAccumulator, MalformedToolCallError, safeToolId, sseJson, toChatMessages, toChatTools } from "./chat";

const history: MessageParam[] = [
  { role: "user", content: [{ type: "text", text: "<context>x</context>" }, { type: "text", text: "list files" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "let me look", signature: "sig" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*" } },
      { type: "tool_use", id: "toolu_2", name: "Read", input: { path: "a" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" },
      { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "denied" }], is_error: true },
      { type: "text", text: "<mode>plan</mode>" },
    ],
  },
  { role: "assistant", content: [{ type: "compaction", content: "we listed files" } as never, { type: "text", text: "Done." }] },
];

describe("toChatMessages", () => {
  test("system first, tool results as tool messages right after the calls, thinking dropped", () => {
    expect(toChatMessages("SYS", history)).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "<context>x</context>\n\nlist files" },
      {
        role: "assistant",
        content: "Looking.",
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "Glob", arguments: '{"pattern":"*"}' } },
          { id: "toolu_2", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "a\nb" },
      { role: "tool", tool_call_id: "toolu_2", content: "Error: denied" },
      { role: "user", content: "<mode>plan</mode>" },
      { role: "assistant", content: "[Summary of the earlier conversation]\nwe listed files\n\nDone." },
    ]);
  });

  test("keepReasoning sends reasoning back; images become a note; string content works", () => {
    const msgs = toChatMessages(
      "S",
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "" }, { type: "tool_use", id: "c1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] },
      ],
      { keepReasoning: true },
    );
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
    expect(msgs[2]).toMatchObject({ role: "assistant", content: null, reasoning_content: "hmm" });
    expect((msgs[3] as { content: string }).content).toContain("image omitted");
  });
});

test("toChatTools uses the JSON schema of each tool", () => {
  const tool = defineTool({
    name: "Echo",
    kind: "read",
    description: "echo text",
    schema: z.object({ text: z.string() }),
    summarize: () => "",
    subject: () => ({ paths: [] }),
    run: async () => ({ content: "" }),
  }) as AnyTool;
  const [chat] = toChatTools([tool]);
  expect(chat).toMatchObject({ type: "function", function: { name: "Echo", description: "echo text", parameters: { type: "object", required: ["text"] } } });
});

describe("ChatAccumulator", () => {
  const collect = () => {
    const text: string[] = [];
    const thinking: string[] = [];
    return { text, thinking, handlers: { onText: (d: string) => text.push(d), onThinking: (d: string) => thinking.push(d) } };
  };

  test("assembles text, reasoning and interleaved tool-call deltas", () => {
    const c = collect();
    const acc = new ChatAccumulator("deepseek/deepseek-chat", c.handlers);
    acc.push({ id: "x", choices: [{ delta: { reasoning_content: "think" } }] });
    acc.push({ choices: [{ delta: { content: "Hel" } }] });
    acc.push({ choices: [{ delta: { content: "lo" } }] });
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "functions.Read:0", function: { name: "Read", arguments: '{"pa' } }] } }] });
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "Glob", arguments: "{}" } }] } }] });
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: "tool_calls" }] });
    acc.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } });
    const m = acc.finalMessage();
    expect(c.text.join("")).toBe("Hello");
    expect(c.thinking).toEqual(["think"]);
    expect(m.model).toBe("deepseek/deepseek-chat");
    expect(m.stop_reason).toBe("tool_use");
    expect(m.content).toEqual([
      { type: "text", text: "Hello", citations: null },
      { type: "tool_use", id: "functions_Read_0", name: "Read", input: { path: "a" }, caller: null },
      { type: "tool_use", id: "c2", name: "Glob", input: {}, caller: null },
    ] as never);
    expect(m.usage).toMatchObject({ input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 });
  });

  test("keepReasoning stores an unsigned thinking block, which the Anthropic path drops again", () => {
    const acc = new ChatAccumulator("m", collect().handlers);
    acc.push({ choices: [{ delta: { reasoning: "r" } }] });
    acc.push({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
    const m = acc.finalMessage({ keepReasoning: true });
    expect(m.content[0]).toEqual({ type: "thinking", thinking: "r", signature: "", tropos: { field: "reasoning" } } as never);
    const [cleaned] = anthropicHistory([{ role: "assistant", content: m.content as never }]);
    expect(cleaned!.content).toEqual([{ type: "text", text: "ok", citations: null }] as never);
  });

  test("stop reasons, DeepSeek cache hits and OpenRouter cost", () => {
    const run = (finish: string, usage?: object) => {
      const acc = new ChatAccumulator("m", collect().handlers);
      acc.push({ choices: [{ delta: { content: "x" }, finish_reason: finish }], usage: usage as never });
      return acc.finalMessage();
    };
    expect(run("stop").stop_reason).toBe("end_turn");
    expect(run("length").stop_reason).toBe("max_tokens");
    expect(run("content_filter").stop_reason).toBe("refusal");
    expect(run("stop", { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 4 }).usage).toMatchObject({ input_tokens: 6, cache_read_input_tokens: 4 });
    expect(run("stop", { prompt_tokens: 10, completion_tokens: 1, cost: 0.0123 }).usage).toMatchObject({ cost_usd: 0.0123 });
  });

  test("a tool call ending with stop still counts as tool_use", () => {
    const acc = new ChatAccumulator("m", collect().handlers);
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: "{}" } }] }, finish_reason: "stop" }] });
    expect(acc.finalMessage().stop_reason).toBe("tool_use");
  });

  test("broken arguments: a malformed-call error, unless the output limit cut them off", () => {
    const broken = (finish: string) => {
      const acc = new ChatAccumulator("m", collect().handlers);
      acc.push({ choices: [{ delta: { content: "x", tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: '{"pa' } }] }, finish_reason: finish }] });
      return () => acc.finalMessage();
    };
    expect(broken("tool_calls")).toThrow(MalformedToolCallError);
    const cut = broken("length")();
    expect(cut.stop_reason).toBe("max_tokens");
    expect(cut.content.some((b) => b.type === "tool_use")).toBe(false);
  });
});

describe("provider-specific reasoning", () => {
  const quiet = { onText() {}, onThinking() {} };

  test("reasoning goes back in the field it arrived in", () => {
    const acc = new ChatAccumulator("m", quiet);
    acc.push({ choices: [{ delta: { reasoning: "plan", tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    const m = acc.finalMessage({ keepReasoning: true });
    const chat = toChatMessages("S", [{ role: "user", content: "x" }, { role: "assistant", content: m.content as never }], { keepReasoning: true, reasoningField: "reasoning_content" });
    expect(chat[2]).toMatchObject({ role: "assistant", reasoning: "plan" });
    expect(chat[2]).not.toHaveProperty("reasoning_content");
  });

  test("without keepReasoning, reasoning is shown but not stored or sent", () => {
    const acc = new ChatAccumulator("m", quiet);
    acc.push({ choices: [{ delta: { reasoning_content: "plan", content: "hi" }, finish_reason: "stop" }] });
    expect(acc.finalMessage().content).toEqual([{ type: "text", text: "hi", citations: null }] as never);
  });

  test("Gemini thought signatures are kept even without keepReasoning and go back on their calls", () => {
    const acc = new ChatAccumulator("gemini/g", quiet);
    acc.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "a", function: { name: "Read", arguments: "{}" }, extra_content: { google: { thought_signature: "SIG" } } },
              { index: 1, id: "b", function: { name: "Glob", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const m = acc.finalMessage();
    expect(m.content[0]).toEqual({ type: "thinking", thinking: "", signature: "", tropos: { toolSignatures: { a: "SIG" } } } as never);
    const chat = toChatMessages("S", [{ role: "user", content: "x" }, { role: "assistant", content: m.content as never }]);
    const calls = (chat[2] as { tool_calls: Array<{ id: string; extra_content?: unknown }> }).tool_calls;
    expect(calls[0]!.extra_content).toEqual({ google: { thought_signature: "SIG" } });
    expect(calls[1]!.extra_content).toBeUndefined();
    expect(chat[2]).not.toHaveProperty("reasoning_content");
  });

  test("Mistral-style content lists split into text and thinking", () => {
    const seen: string[] = [];
    const acc = new ChatAccumulator("mistral/m", { onText: (d) => seen.push(`text:${d}`), onThinking: (d) => seen.push(`think:${d}`) });
    acc.push({ choices: [{ delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "hmm" }] }] } }] });
    acc.push({ choices: [{ delta: { content: [{ type: "text", text: "A" }] } }] });
    acc.push({ choices: [{ delta: { content: "B" }, finish_reason: "stop" }] });
    expect(seen).toEqual(["think:hmm", "text:A", "text:B"]);
    expect(acc.finalMessage().content).toEqual([{ type: "text", text: "AB", citations: null }] as never);
  });
});

test("safeToolId", () => {
  expect(safeToolId("call_abc-1", 0)).toBe("call_abc-1");
  expect(safeToolId("functions.read:0", 0)).toBe("functions_read_0");
  expect(safeToolId("", 3)).toBe("call_3");
});

test("sseJson yields data payloads across chunk boundaries and stops at [DONE]", async () => {
  const parts = ['data: {"a":1}\n\n: keep-alive\n\ndata: {"b"', ':2}\r\n\nevent: x\ndata: [DONE]\n\ndata: {"c":3}\n'];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
      controller.close();
    },
  });
  const seen: unknown[] = [];
  for await (const v of sseJson(body)) seen.push(v);
  expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
});
