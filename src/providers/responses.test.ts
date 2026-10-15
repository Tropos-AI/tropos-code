// src/providers/responses.test.ts
import { describe, expect, test } from "bun:test";
import { anthropicHistory, type TurnRequest } from "../api/model";
import type { MessageParam } from "../session/store";
import { MalformedToolCallError } from "./chat";
import { ChatCompletionsModel, type ChatEndpoint } from "./chat-model";
import { ResponsesAccumulator, ResponsesModel, responsesBody, toResponsesInput } from "./responses";

const quiet = { onText() {}, onThinking() {} };

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: "openai/gpt-6-sol",
  effort: "high",
  system: "SYS",
  tools: [],
  messages: [{ role: "user", content: "hi" }],
  refusalFallback: true,
  ...over,
});

const endpoint: ChatEndpoint = {
  id: "openai",
  name: "OpenAI",
  baseURL: "https://api.openai.test/v1",
  capabilities: { maxTokensParam: null, streamUsage: false },
  apiKey: async () => "sk",
  keyRequired: true,
  keyHint: "hint",
};

function sse(...events: object[]): Response {
  return new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
}

describe("toResponsesInput", () => {
  test("messages, calls, outputs and stored reasoning items, in order", () => {
    const history: MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "<context/>" }, { type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "summary", signature: "", tropos: { items: [{ type: "reasoning", id: "rs_1", encrypted_content: "ENC" }] } } as never,
          { type: "thinking", thinking: "anthropic's own", signature: "sig" },
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "call_1", name: "Read", input: { path: "a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "contents", is_error: false }] },
    ];
    expect(toResponsesInput(history)).toEqual([
      { role: "user", content: "<context/>\n\ngo" },
      { type: "reasoning", id: "rs_1", encrypted_content: "ENC" },
      { role: "assistant", content: "Reading." },
      { type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]);
  });
});

test("responsesBody: stateless, encrypted reasoning, clamped effort, and a fallback without reasoning", () => {
  const { body, withoutReasoning } = responsesBody("gpt-6-sol", req({ effort: "max" }), { summaries: true, encryptedReasoning: true });
  expect(body).toMatchObject({ model: "gpt-6-sol", instructions: "SYS", stream: true, store: false, reasoning: { effort: "max", summary: "auto" }, include: ["reasoning.encrypted_content"] });
  expect(withoutReasoning).not.toHaveProperty("reasoning");
  expect(withoutReasoning).not.toHaveProperty("include");
  const xai = responsesBody("grok-4.7", req({ effort: "max" }), { summaries: false, encryptedReasoning: false, efforts: ["low", "medium", "high", "xhigh"] }).body;
  expect(xai.reasoning).toEqual({ effort: "xhigh" });
  expect(xai).not.toHaveProperty("include");
});

describe("ResponsesAccumulator", () => {
  test("text, reasoning summary, function calls and usage", () => {
    const seen: string[] = [];
    const acc = new ResponsesAccumulator("openai/gpt-6-sol", { onText: (d) => seen.push(`t:${d}`), onThinking: (d) => seen.push(`r:${d}`) });
    acc.push({ type: "response.reasoning_summary_text.delta", delta: "plan" });
    acc.push({ type: "response.output_text.delta", delta: "On it." });
    acc.push({ type: "response.output_item.done", item: { type: "reasoning", summary: [{ text: "plan" }], encrypted_content: "ENC" } });
    acc.push({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "On it." }] } });
    acc.push({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_9", name: "Glob", arguments: '{"pattern":"*"}' } });
    acc.push({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } } } });
    const m = acc.finalMessage();
    expect(seen).toEqual(["r:plan", "t:On it."]);
    expect(m.stop_reason).toBe("tool_use");
    expect(m.content).toEqual([
      { type: "thinking", thinking: "plan", signature: "", tropos: { items: [{ type: "reasoning", summary: [{ text: "plan" }], encrypted_content: "ENC" }] } },
      { type: "text", text: "On it.", citations: null },
      { type: "tool_use", id: "call_9", name: "Glob", input: { pattern: "*" }, caller: null },
    ] as never);
    expect(m.usage).toMatchObject({ input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 10 });
    // The Anthropic path never sees the foreign reasoning.
    expect(anthropicHistory([{ role: "assistant", content: m.content as never }])[0]!.content).toHaveLength(2);
  });

  test("reasoning without encrypted content is not kept (it can't be sent back statelessly)", () => {
    const acc = new ResponsesAccumulator("m", quiet);
    acc.push({ type: "response.output_item.done", item: { type: "reasoning", summary: [{ text: "x" }] } });
    acc.push({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "hi" }] } });
    acc.push({ type: "response.completed", response: { status: "completed" } });
    expect(acc.finalMessage().content).toEqual([{ type: "text", text: "hi", citations: null }] as never);
  });

  test("stop reasons: output limit, refusal; xAI cost; failures", () => {
    const limit = new ResponsesAccumulator("m", quiet);
    limit.push({ type: "response.output_item.done", item: { type: "function_call", call_id: "c", name: "Read", arguments: '{"pa' } });
    limit.push({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
    expect(limit.finalMessage()).toMatchObject({ stop_reason: "max_tokens", content: [] });

    const refusal = new ResponsesAccumulator("m", quiet);
    refusal.push({ type: "response.output_item.done", item: { type: "message", content: [{ type: "refusal", refusal: "No." }] } });
    refusal.push({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, cost_in_usd_ticks: 2_500_000_000 } } });
    const r = refusal.finalMessage();
    expect(r.stop_reason).toBe("refusal");
    expect(r.usage).toMatchObject({ cost_usd: 0.25 });

    const broken = new ResponsesAccumulator("m", quiet);
    broken.push({ type: "response.output_item.done", item: { type: "function_call", call_id: "c", name: "Read", arguments: "{oops" } });
    broken.push({ type: "response.completed", response: { status: "completed" } });
    expect(() => broken.finalMessage()).toThrow(MalformedToolCallError);

    expect(() => new ResponsesAccumulator("m", quiet).push({ type: "response.failed", response: { error: { message: "server" } } })).toThrow("server");
    expect(() => new ResponsesAccumulator("m", quiet).push({ type: "error", message: "bad" })).toThrow("bad");
  });
});

describe("models without reasoning", () => {
  test("Responses: a 400 about reasoning is retried once without it, and remembered", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.reasoning) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort'" } }), { status: 400 });
      return sse(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "ok" }] } },
        { type: "response.completed", response: { status: "completed" } },
      );
    }) as unknown as typeof fetch;
    const model = new ResponsesModel(endpoint, { summaries: true, encryptedReasoning: true }, fetchImpl);
    const r = req({ model: "openai/old-model-1" });
    expect((await model.send(r, quiet, new AbortController().signal)).content).toEqual([{ type: "text", text: "ok", citations: null }] as never);
    await model.send(r, quiet, new AbortController().signal);
    expect(bodies.map((b) => "reasoning" in b)).toEqual([true, false, false]);
  });

  test("Responses: a stream that ends without response.completed is an error", async () => {
    const fetchImpl = (async () =>
      sse({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "half" }] } })) as unknown as typeof fetch;
    const model = new ResponsesModel(endpoint, { summaries: true, encryptedReasoning: true }, fetchImpl);
    await expect(model.send(req(), quiet, new AbortController().signal)).rejects.toThrow("ended the response early");
  });

  test("Chat Completions: the same for effort fields; other 400s are not retried", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init.body));
      if (body.messages[1].content === "bad") return new Response("context too long", { status: 400 });
      if (body.reasoning_effort) return new Response(JSON.stringify({ error: { message: "reasoning_effort is not supported" } }), { status: 400 });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }) as unknown as typeof fetch;
    const chat = new ChatCompletionsModel({ ...endpoint, capabilities: { maxTokensParam: null, streamUsage: false, effort: (e) => ({ reasoning_effort: e }) } }, fetchImpl);
    await chat.send(req({ model: "x/no-reasoning-1" }), quiet, new AbortController().signal);
    expect(calls).toBe(2);
    calls = 0;
    await expect(chat.send(req({ model: "x/other", messages: [{ role: "user", content: "bad" }] }), quiet, new AbortController().signal)).rejects.toThrow("context too long");
    expect(calls).toBe(1);
  });
});
