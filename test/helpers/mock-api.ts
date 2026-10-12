type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
export interface MockResponse {
  content: Block[];
  stop_reason: string;
}
export interface MockApi {
  url: string;
  requests: Array<{ headers: Record<string, string>; body: any }>;
  stop(): void;
}

function sse(response: MockResponse): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ],
  ];
  response.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push([
        "content_block_delta",
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: response.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** A local stand-in for POST /v1/messages that streams scripted responses in order. */
export function startMockApi(script: MockResponse[]): MockApi {
  const queue = [...script];
  const requests: MockApi["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
      requests.push({ headers: Object.fromEntries(req.headers), body: await req.json() });
      const next = queue.shift();
      if (!next) {
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "mock: script exhausted" } }, { status: 400 });
      }
      return new Response(sse(next), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}
