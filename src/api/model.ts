import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Effort } from "../config/constants";
import type { MessageParam } from "../session/store";
import { toolInputSchema } from "../tools/schema";
import type { AnyTool } from "../tools/types";

export type Message = Anthropic.Beta.BetaMessage;

export interface TurnRequest {
  model: string;
  effort: Effort;
  system: string;
  tools: AnyTool[];
  messages: MessageParam[];
  refusalFallback: boolean;
}

export interface StreamHandlers {
  onText(delta: string): void;
  onThinking(delta: string): void;
  /** Something the user should know about this request, e.g. that the model got a note in place of their images. */
  onNotice?(text: string): void;
}

export interface Model {
  send(req: TurnRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<Message>;
}

export const MAX_TOKENS = 64_000;
export const BETA_COMPACTION = "compact-2026-01-12";
/**
 * Prompt size at which the server compacts the conversation: compact_20260112's default trigger, which
 * Tropos doesn't override. The learning review's memory flush is timed against it.
 */
export const COMPACTION_TRIGGER_TOKENS = 150_000;
export const BETA_FALLBACK = "server-side-fallback-2026-07-01";

export function toolToApi(tool: AnyTool): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toolInputSchema(tool),
    eager_input_streaming: true,
  };
}

/**
 * Drops thinking blocks without a signature. Other providers' reasoning is kept in the session that
 * way, and the Messages API rejects it.
 */
export function anthropicHistory(messages: MessageParam[]): MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string" || !m.content.some((b) => b.type === "thinking" && !b.signature)) return m;
    const content = m.content.filter((b) => !(b.type === "thinking" && !b.signature));
    return { ...m, content: content.length > 0 ? content : [{ type: "text", text: "(no reply)" }] };
  });
}

export function buildParams(req: TurnRequest): BetaMessageStreamParams {
  return {
    model: req.model,
    max_tokens: MAX_TOKENS,
    system: req.system,
    messages: anthropicHistory(req.messages),
    tools: req.tools.map(toolToApi),
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: req.effort },
    cache_control: { type: "ephemeral" },
    context_management: { edits: [{ type: "compact_20260112" }] },
    betas: req.refusalFallback ? [BETA_COMPACTION, BETA_FALLBACK] : [BETA_COMPACTION],
    ...(req.refusalFallback ? { fallbacks: "default" as const } : {}),
  };
}

export class AnthropicModel implements Model {
  constructor(private readonly client: Anthropic) {}

  async send(req: TurnRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<Message> {
    const stream = this.client.beta.messages.stream(buildParams(req), { signal });
    stream.on("text", (delta) => handlers.onText(delta));
    stream.on("thinking", (delta) => handlers.onThinking(delta));
    return await stream.finalMessage();
  }
}
