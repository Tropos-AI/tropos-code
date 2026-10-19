// src/providers/chat.ts — Anthropic-format history to and from the OpenAI Chat Completions format.
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../api/model";
import { imageNote } from "../attachments/attachments";
import type { MessageParam } from "../session/store";
import { toolInputSchema } from "../tools/schema";
import type { AnyTool } from "../tools/types";
import { foreignThinking, readForeign, type ForeignReasoning } from "./reasoning";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini's thought signature travels with the call it belongs to. */
  extra_content?: { google: { thought_signature: string } };
}

/** A user message with images is a list of parts; one without stays a plain string. */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string; reasoning?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export type ReasoningField = NonNullable<ForeignReasoning["field"]>;

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

type Block = Exclude<MessageParam["content"], string>[number];
type ToolResultContent = Anthropic.Beta.BetaToolResultBlockParam["content"];

const IMAGE_OMITTED = "[image omitted: this model is reached through a text-only API]";

function toolResultText(content: ToolResultContent): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : IMAGE_OMITTED)).join("\n");
}

/** Text a block contributes when the target API has no equivalent: compaction summaries, documents. */
function fallbackText(block: Block): string | null {
  const b = block as { type: string; text?: unknown; content?: unknown };
  if (b.type === "compaction") return typeof b.content === "string" && b.content ? `[Summary of the earlier conversation]\n${b.content}` : null;
  if (b.type === "image") return IMAGE_OMITTED;
  if (typeof b.text === "string") return b.text;
  return null;
}

/** The data URL of an inline (base64) image block, or null for any other block. */
export function imageDataUrl(block: Block): string | null {
  if (block.type !== "image" || block.source.type !== "base64") return null;
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

/**
 * Converts the session history. Tool results become `tool` messages placed straight after the
 * assistant message that asked for them, as Chat Completions requires. `keepReasoning` sends
 * reasoning back, in the field it arrived in (else `reasoningField`), for providers that need it
 * during a tool-call loop. Gemini thought signatures always go back on their tool calls. The user's
 * images go as image_url parts, or as a note when `images` is false (a model without vision).
 */
export function toChatMessages(
  system: string,
  history: MessageParam[],
  opts: { keepReasoning?: boolean; reasoningField?: ReasoningField; images?: boolean } = {},
): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const message of history) {
    const blocks: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "assistant") {
      const text: string[] = [];
      const reasoning: string[] = [];
      let field: ReasoningField = opts.reasoningField ?? "reasoning_content";
      const signatures: Record<string, string> = {};
      const calls: ChatToolCall[] = [];
      for (const block of blocks) {
        if (block.type === "tool_use") {
          calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
        } else if (block.type === "thinking") {
          const foreign = readForeign(block);
          if (foreign?.data.field) field = foreign.data.field;
          Object.assign(signatures, foreign?.data.toolSignatures);
          if (block.thinking) reasoning.push(block.thinking);
        } else if (block.type !== "redacted_thinking") {
          const t = fallbackText(block);
          if (t) text.push(t);
        }
      }
      for (const call of calls) {
        const signature = signatures[call.id];
        if (signature) call.extra_content = { google: { thought_signature: signature } };
      }
      const assistant: ChatMessage = { role: "assistant", content: text.length ? text.join("\n\n") : null };
      if (calls.length) assistant.tool_calls = calls;
      if (opts.keepReasoning && reasoning.length) assistant[field] = reasoning.join("");
      out.push(assistant);
      continue;
    }
    const text: string[] = [];
    const parts: ChatContentPart[] = [];
    const flushText = () => {
      if (text.length) parts.push({ type: "text", text: text.splice(0).join("\n\n") });
    };
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const content = toolResultText(block.content);
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.is_error ? `Error: ${content}` : content || "(no output)" });
        continue;
      }
      const url = opts.images === false ? null : imageDataUrl(block);
      if (url) {
        flushText();
        parts.push({ type: "image_url", image_url: { url } });
        continue;
      }
      const t = block.type === "image" ? imageNote() : fallbackText(block);
      if (t) text.push(t);
    }
    flushText();
    if (parts.length) out.push({ role: "user", content: parts.some((p) => p.type === "image_url") ? parts : parts.map((p) => (p as { text: string }).text).join("\n\n") });
  }
  return out;
}

export function toChatTools(tools: AnyTool[]): ChatTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: toolInputSchema(tool) as Record<string, unknown> },
  }));
}

/** Thrown when a streamed tool call's arguments are not valid JSON; the agent asks the model again. */
export class MalformedToolCallError extends Error {
  constructor(name: string) {
    super(`The model sent arguments for ${name} that are not valid JSON.`);
    this.name = "MalformedToolCallError";
  }
}

/** Mistral sends content as a list of text and thinking parts when reasoning is on. */
type ContentPart = { type?: string; text?: string; thinking?: Array<{ type?: string; text?: string }> | string };

interface ChatChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | ContentPart[] | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        extra_content?: { google?: { thought_signature?: string } };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: ChatUsage | null;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek reports cache hits under its own name. */
  prompt_cache_hit_tokens?: number;
  /** OpenRouter reports the actual charge in USD. */
  cost?: number;
}

/** Anthropic accepts only [A-Za-z0-9_-] in tool ids, and a session may move between providers. */
export function safeToolId(id: string, index: number): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return clean || `call_${index}`;
}

const STOP_REASONS: Record<string, Message["stop_reason"]> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

/** Assembles streamed Chat Completions chunks into one Anthropic-shaped assistant message. */
export class ChatAccumulator {
  private text = "";
  private reasoning = "";
  private reasoningField: ReasoningField | undefined;
  private readonly calls = new Map<number, { id: string; name: string; arguments: string; signature?: string }>();
  private finish: string | null = null;
  private usage: ChatUsage | null = null;
  private id = "";
  private servedModel = "";

  constructor(
    private readonly requestedModel: string,
    private readonly handlers: { onText(delta: string): void; onThinking(delta: string): void },
  ) {}

  push(chunk: ChatChunk): void {
    if (chunk.id) this.id = chunk.id;
    if (chunk.model) this.servedModel = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (delta.reasoning_content) this.addReasoning(delta.reasoning_content, "reasoning_content");
      else if (delta.reasoning) this.addReasoning(delta.reasoning, "reasoning");
      if (typeof delta.content === "string") this.addText(delta.content);
      else if (Array.isArray(delta.content)) {
        for (const part of delta.content) {
          if (part.type === "text" && part.text) this.addText(part.text);
          else if (part.type === "thinking") {
            const t = typeof part.thinking === "string" ? part.thinking : (part.thinking ?? []).map((x) => x.text ?? "").join("");
            if (t) this.addReasoning(t, undefined);
          }
        }
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? this.calls.size;
        const entry = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name += call.function.name;
        if (call.function?.arguments) entry.arguments += call.function.arguments;
        const signature = call.extra_content?.google?.thought_signature;
        if (signature) entry.signature = signature;
        this.calls.set(index, entry);
      }
      if (choice.finish_reason) this.finish = choice.finish_reason;
    }
  }

  private addText(delta: string): void {
    // Reasoning streams often interleave `content: ""` chunks; an empty delta is not text.
    if (!delta) return;
    this.text += delta;
    this.handlers.onText(delta);
  }

  private addReasoning(delta: string, field: ReasoningField | undefined): void {
    this.reasoning += delta;
    this.reasoningField ??= field;
    this.handlers.onThinking(delta);
  }

  /**
   * `keepReasoning` stores the reasoning as an unsigned thinking block so it can be sent back later.
   * Gemini thought signatures are always stored: the next request fails without them.
   */
  /** True once a choice carried a finish_reason; a stream that ends without one was cut off. */
  get finished(): boolean {
    return this.finish !== null;
  }

  finalMessage(opts: { keepReasoning?: boolean } = {}): Message {
    const content: Array<Record<string, unknown>> = [];
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    const signatures: Record<string, string> = {};
    for (const [i, call] of calls.entries()) if (call.signature) signatures[safeToolId(call.id, i)] = call.signature;
    const hasSignatures = Object.keys(signatures).length > 0;
    if ((opts.keepReasoning && this.reasoning) || hasSignatures) {
      content.push(
        foreignThinking(opts.keepReasoning ? this.reasoning : "", {
          field: opts.keepReasoning ? this.reasoningField : undefined,
          toolSignatures: hasSignatures ? signatures : undefined,
        }) as unknown as Record<string, unknown>,
      );
    }
    if (this.text) content.push({ type: "text", text: this.text, citations: null });
    for (const [i, call] of calls.entries()) {
      let input: unknown;
      try {
        input = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      } catch {
        // Cut off mid-call at the output limit: report the limit rather than a malformed call.
        if (this.finish === "length") continue;
        throw new MalformedToolCallError(call.name || "a tool");
      }
      content.push({ type: "tool_use", id: safeToolId(call.id, i), name: call.name, input, caller: null });
    }
    let stop = STOP_REASONS[this.finish ?? "stop"] ?? "end_turn";
    // Some providers end a tool-calling turn with "stop"; the calls are what matter.
    if (stop === "end_turn" && content.some((b) => b.type === "tool_use")) stop = "tool_use";
    const u = this.usage ?? {};
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
    const usage = {
      input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      ...(typeof u.cost === "number" ? { cost_usd: u.cost } : {}),
    };
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model: this.requestedModel,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage,
    } as unknown as Message;
  }
}

/** Parses a server-sent-events body into the JSON payload of each `data:` line, stopping at [DONE]. */
export async function* sseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) yield JSON.parse(data);
    }
  }
}
