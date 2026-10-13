// test/helpers/mock-chat-api.ts — a local OpenAI-compatible Chat Completions server for end-to-end tests.
import type { MockApi } from "./mock-api";

/** One scripted reply: streamed as Chat Completions chunks. */
export interface MockChatReply {
  reasoning?: string;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
}

function sse(reply: MockChatReply): string {
  const chunks: unknown[] = [];
  if (reply.reasoning) chunks.push({ choices: [{ index: 0, delta: { reasoning_content: reply.reasoning } }] });
  if (reply.text) chunks.push({ choices: [{ index: 0, delta: { content: reply.text } }] });
  reply.toolCalls?.forEach((call, index) => {
    const args = JSON.stringify(call.arguments);
    // Split the arguments across two chunks, as real providers do.
    chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: args.slice(0, 5) } }] } }] });
    chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] });
  });
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 15 } });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

/** Serves POST {url}/chat/completions with the scripted replies, in order. */
export function startMockChatApi(script: MockChatReply[]): MockApi {
  const queue = [...script];
  const requests: MockApi["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      requests.push({ headers: Object.fromEntries(req.headers), body: await req.json() });
      const next = queue.shift();
      if (!next) return Response.json({ error: { message: "mock: script exhausted" } }, { status: 400 });
      return new Response(sse(next), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://localhost:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
