import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Effort } from "../config/constants";
import type { MessageParam } from "../session/store";
import { toInputSchema } from "../tools/schema";
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
}

export interface Model {
  send(req: TurnRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<Message>;
}

export const MAX_TOKENS = 64_000;
export const BETA_COMPACTION = "compact-2026-01-12";
export const BETA_FALLBACK = "server-side-fallback-2026-07-01";

export function toolToApi(tool: AnyTool): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toInputSchema(tool.schema),
    eager_input_streaming: true,
  };
}

export function buildParams(req: TurnRequest): BetaMessageStreamParams {
  return {
    model: req.model,
    max_tokens: MAX_TOKENS,
    system: req.system,
    messages: req.messages,
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

/** Credentials resolve the SDK's usual way: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, `ant auth` profiles. */
export function createClient(): Anthropic {
  return new Anthropic({ maxRetries: 2 });
}
