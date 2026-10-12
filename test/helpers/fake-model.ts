// test/helpers/fake-model.ts
import { expect } from "bun:test";
import type { Message, Model, StreamHandlers, TurnRequest } from "../../src/api/model";
import type { MessageParam } from "../../src/session/store";

export type Step = (req: TurnRequest, handlers: StreamHandlers, signal: AbortSignal) => Message | Promise<Message>;

/** A Model that replays scripted responses and records every request it receives. */
export class FakeModel implements Model {
  readonly requests: TurnRequest[] = [];
  constructor(private readonly steps: Step[]) {}

  async send(req: TurnRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<Message> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const step = this.steps.shift();
    if (!step) throw new Error("FakeModel: no scripted response left");
    const message = await step(req, handlers, signal);
    for (const block of message.content) {
      if (block.type === "text") handlers.onText(block.text);
    }
    return message;
  }
}

export const textBlock = (text: string) => ({ type: "text", text, citations: null });
export const toolUseBlock = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

export function reply(content: unknown[], stopReason = "end_turn", model = "claude-opus-5-5"): Message {
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Message;
}

/** Every assistant tool_use is answered by a tool_result in the very next message. */
export function assertToolPairs(messages: MessageParam[]): void {
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const ids = m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    if (ids.length === 0) return;
    const next = messages[i + 1];
    expect(next?.role).toBe("user");
    const results = typeof next!.content === "string" ? [] : next!.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []));
    expect(results).toEqual(ids);
  });
}
