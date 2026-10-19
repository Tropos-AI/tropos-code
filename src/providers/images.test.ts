// src/providers/images.test.ts — images in the user's turn, per API: Chat Completions, Responses, and models without vision.
import { describe, expect, test } from "bun:test";
import type { TurnRequest } from "../api/model";
import type { MessageParam } from "../session/store";
import { toChatMessages } from "./chat";
import { ChatCompletionsModel, type ChatEndpoint } from "./chat-model";
import { ResponsesModel, toResponsesInput } from "./responses";

const withImage: MessageParam[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "<context>x</context>" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      { type: "text", text: "what is this?" },
    ],
  },
];

const endpoint = (over: Partial<ChatEndpoint> = {}): ChatEndpoint => ({
  id: "acme",
  name: "Acme",
  baseURL: "https://api.acme.test/v1",
  capabilities: { maxTokensParam: null, streamUsage: false },
  apiKey: async () => "sk",
  keyRequired: true,
  keyHint: "hint",
  ...over,
});

const request = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: "acme/vision-1",
  effort: "high",
  system: "SYS",
  tools: [],
  messages: withImage,
  refusalFallback: false,
  ...over,
});

function fakeFetch(responses: Response[]): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  }) as unknown as typeof fetch;
  return { fetch: f, bodies };
}

const chatDone = () =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
const responsesDone = () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`, { status: 200 });
const rejection = (message: string) => new Response(JSON.stringify({ error: { message } }), { status: 400 });

function listening() {
  const notices: string[] = [];
  return { notices, handlers: { onText() {}, onThinking() {}, onNotice: (t: string) => void notices.push(t) } };
}
const signal = () => new AbortController().signal;

describe("toChatMessages", () => {
  test("a user's image goes as an image_url data URL, in its place among the text", () => {
    expect(toChatMessages("S", withImage)[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "<context>x</context>" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        { type: "text", text: "what is this?" },
      ],
    });
  });

  test("for a model that can't see images it is a note instead, and the message stays plain text", () => {
    const msg = toChatMessages("S", withImage, { images: false })[1] as { content: string };
    expect(typeof msg.content).toBe("string");
    expect(msg.content).toContain("can't see images");
    expect(msg.content).toContain("what is this?");
  });
});

describe("toResponsesInput", () => {
  test("a user's image is an input_image part between input_text parts", () => {
    expect(toResponsesInput(withImage)).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "<context>x</context>" },
          { type: "input_image", image_url: "data:image/png;base64,QUJD" },
          { type: "input_text", text: "what is this?" },
        ],
      },
    ]);
  });

  test("without vision the image is a note in the text", () => {
    const [item] = toResponsesInput(withImage, { images: false }) as Array<{ content: string }>;
    expect(item!.content).toContain("can't see images");
    expect(item!.content).toContain("what is this?");
  });
});

describe("ChatCompletionsModel and images", () => {
  test("a vision model gets the image", async () => {
    const f = fakeFetch([chatDone()]);
    const { notices, handlers } = listening();
    await new ChatCompletionsModel(endpoint(), f.fetch).send(request(), handlers, signal());
    expect(JSON.parse(f.bodies[0]!).messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
    expect(notices).toEqual([]);
  });

  test("a provider without vision gets a note, and the user is told when a turn starts with images", async () => {
    const f = fakeFetch([chatDone(), chatDone()]);
    const { notices, handlers } = listening();
    const model = new ChatCompletionsModel(endpoint({ capabilities: { maxTokensParam: null, streamUsage: false, vision: false } }), f.fetch);
    await model.send(request({ model: "acme/text-1" }), handlers, signal());
    const sent = JSON.parse(f.bodies[0]!).messages[1].content;
    expect(typeof sent).toBe("string");
    expect(sent).toContain("can't see images");
    expect(notices).toEqual([expect.stringContaining("can't see images")]);
    // Later requests of the conversation re-send that image; nothing more is said.
    const later: MessageParam[] = [...withImage, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: "and?" }];
    await model.send(request({ model: "acme/text-1", messages: later }), handlers, signal());
    expect(notices).toHaveLength(1);
  });

  test("a 400 about images is retried once with a note instead, and remembered for that model", async () => {
    const f = fakeFetch([rejection("image_url is not supported by this model"), chatDone(), chatDone()]);
    const { notices, handlers } = listening();
    const model = new ChatCompletionsModel(endpoint(), f.fetch);
    await model.send(request({ model: "acme/remember-no-vision" }), handlers, signal());
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[0]).toContain("image_url");
    expect(f.bodies[1]).not.toContain("image_url");
    expect(notices).toEqual([expect.stringContaining("can't see images")]);
    await model.send(request({ model: "acme/remember-no-vision" }), handlers, signal());
    expect(f.bodies).toHaveLength(3);
    expect(f.bodies[2]).not.toContain("image_url");
  });

  test("other 400s are not retried", async () => {
    const f = fakeFetch([rejection("bad tool schema")]);
    const { handlers } = listening();
    await expect(new ChatCompletionsModel(endpoint(), f.fetch).send(request({ model: "acme/other-400" }), handlers, signal())).rejects.toThrow(/bad tool schema/);
    expect(f.bodies).toHaveLength(1);
  });
});

describe("ResponsesModel and images", () => {
  test("an image the model refuses is replaced by a note, the user is told, and the model is remembered", async () => {
    const f = fakeFetch([rejection("This model does not support image inputs."), responsesDone(), responsesDone()]);
    const { notices, handlers } = listening();
    const model = new ResponsesModel(endpoint(), { summaries: false, encryptedReasoning: false }, f.fetch);
    await model.send(request({ model: "acme/responses-no-vision" }), handlers, signal());
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[0]).toContain("input_image");
    expect(f.bodies[1]).not.toContain("input_image");
    expect(notices).toEqual([expect.stringContaining("can't see images")]);
    await model.send(request({ model: "acme/responses-no-vision" }), handlers, signal());
    expect(f.bodies).toHaveLength(3);
    expect(f.bodies[2]).not.toContain("input_image");
  });
});
