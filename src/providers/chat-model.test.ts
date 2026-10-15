// src/providers/chat-model.test.ts
import { describe, expect, test } from "bun:test";
import type { TurnRequest } from "../api/model";
import { ChatCompletionsModel, ProviderError, chatBody, listChatModels, type ChatEndpoint } from "./chat-model";

const endpoint = (over: Partial<ChatEndpoint> = {}): ChatEndpoint => ({
  id: "acme",
  name: "Acme",
  baseURL: "https://api.acme.test/v1/",
  capabilities: { maxTokensParam: "max_tokens", maxTokens: 8000, streamUsage: true },
  apiKey: async () => "sk-acme",
  keyRequired: true,
  keyHint: "Run /providers to connect Acme or set ACME_API_KEY.",
  ...over,
});

const request = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: "acme/coder-1",
  effort: "high",
  system: "SYS",
  tools: [],
  messages: [{ role: "user", content: "hi" }],
  refusalFallback: true,
  ...over,
});

function sse(...payloads: unknown[]): Response {
  const text = payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const handlers = () => ({ text: [] as string[], onText(d: string) { this.text.push(d); }, onThinking() {} });

describe("ChatCompletionsModel", () => {
  test("streams a reply and sends the provider's own model id with auth", async () => {
    const f = fakeFetch([sse({ choices: [{ delta: { content: "Hi" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })]);
    const h = handlers();
    const m = await new ChatCompletionsModel(endpoint(), f.fetch).send(request(), h, new AbortController().signal);
    expect(h.text).toEqual(["Hi"]);
    expect(m.content).toEqual([{ type: "text", text: "Hi", citations: null }] as never);
    expect(m.model).toBe("acme/coder-1");
    expect(f.calls[0]!.url).toBe("https://api.acme.test/v1/chat/completions");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-acme");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body).toMatchObject({ model: "coder-1", stream: true, stream_options: { include_usage: true }, max_tokens: 8000 });
    expect(body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]);
    expect(body.tools).toBeUndefined();
  });

  test("model ids keep everything after the first slash (OpenRouter style)", () => {
    expect(chatBody(endpoint(), "qwen/qwen3-coder", request()).model).toBe("qwen/qwen3-coder");
  });

  test("effort, extra fields and max_completion_tokens come from the capabilities", () => {
    const body = chatBody(
      endpoint({
        capabilities: {
          maxTokensParam: "max_completion_tokens",
          maxTokens: 100,
          streamUsage: false,
          effort: (e) => ({ reasoning_effort: e === "max" ? "high" : e }),
          extraBody: { usage: { include: true } },
        },
      }),
      "m",
      request({ effort: "max" }),
    );
    expect(body).toMatchObject({ max_completion_tokens: 100, reasoning_effort: "high", usage: { include: true } });
    expect(body.stream_options).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  test("retries 429 and 5xx, then succeeds", async () => {
    const f = fakeFetch([
      new Response("busy", { status: 429, headers: { "retry-after": "0.01" } }),
      new Response("oops", { status: 503 }),
      sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
    ]);
    const m = await new ChatCompletionsModel(endpoint(), f.fetch).send(request(), handlers(), new AbortController().signal);
    expect(f.calls).toHaveLength(3);
    expect(m.stop_reason).toBe("end_turn");
  }, 10_000);

  test("a rejected key is not retried and says how to fix it", async () => {
    const f = fakeFetch([new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })]);
    const err = await new ChatCompletionsModel(endpoint(), f.fetch).send(request(), handlers(), new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("Acme rejected the API key (401): invalid api key. Run /providers to connect Acme or set ACME_API_KEY.");
    expect(f.calls).toHaveLength(1);
  });

  test("a missing key fails before any request; a local provider needs none", async () => {
    const f = fakeFetch([sse({ choices: [{ delta: { content: "local" }, finish_reason: "stop" }] })]);
    const noKey = endpoint({ apiKey: async () => null });
    await expect(new ChatCompletionsModel(noKey, f.fetch).send(request(), handlers(), new AbortController().signal)).rejects.toThrow("No API key for Acme");
    expect(f.calls).toHaveLength(0);
    const local = endpoint({ apiKey: async () => null, keyRequired: false });
    await new ChatCompletionsModel(local, f.fetch).send(request(), handlers(), new AbortController().signal);
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("an error event inside the stream ends the turn with that message", async () => {
    const f = fakeFetch([sse({ choices: [{ delta: { content: "a" } }] }, { error: { message: "overloaded" } })]);
    await expect(new ChatCompletionsModel(endpoint(), f.fetch).send(request(), handlers(), new AbortController().signal)).rejects.toThrow("overloaded");
  });

  test("a stream that ends before any finish_reason is an error, not a complete answer", async () => {
    const f = fakeFetch([sse({ choices: [{ delta: { content: "half an ans" } }] })]);
    await expect(new ChatCompletionsModel(endpoint(), f.fetch).send(request(), handlers(), new AbortController().signal)).rejects.toThrow("ended the response early");
  });

  test("an unreachable provider is reported after the retries", async () => {
    const f = fakeFetch([new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
    const err = await new ChatCompletionsModel(endpoint(), f.fetch).send(request(), handlers(), new AbortController().signal).catch((e) => e);
    expect(err.message).toContain("Could not reach Acme at https://api.acme.test/v1/");
    expect(f.calls).toHaveLength(3);
  }, 10_000);

  test("aborting stops a retry wait", async () => {
    const f = fakeFetch([new Response("busy", { status: 429, headers: { "retry-after": "5" } })]);
    const c = new AbortController();
    setTimeout(() => c.abort(), 50);
    const started = Date.now();
    await expect(new ChatCompletionsModel(endpoint(), f.fetch).send(request(), handlers(), c.signal)).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

test("listChatModels reads data[].id, sorted and unique", async () => {
  const f = fakeFetch([Response.json({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, {}] })]);
  expect(await listChatModels(endpoint(), new AbortController().signal, f.fetch)).toEqual(["a", "b"]);
  expect(f.calls[0]!.url).toBe("https://api.acme.test/v1/models");
  const denied = fakeFetch([new Response("nope", { status: 403 })]);
  await expect(listChatModels(endpoint(), new AbortController().signal, denied.fetch)).rejects.toThrow("rejected the API key (403)");
});
