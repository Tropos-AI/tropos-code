// src/providers/responses.ts — the OpenAI Responses API (OpenAI, xAI).
import type { Message, Model, StreamHandlers, TurnRequest } from "../api/model";
import type { Effort } from "../config/constants";
import { clampEffort } from "./registry";
import type { MessageParam } from "../session/store";
import { toolInputSchema } from "../tools/schema";
import type { AnyTool } from "../tools/types";
import { MalformedToolCallError, safeToolId, sseJson } from "./chat";
import { ProviderError, postWithEffortFallback, type ChatEndpoint } from "./chat-model";
import { foreignThinking, readForeign } from "./reasoning";

type Block = Exclude<MessageParam["content"], string>[number];

export type ResponsesInputItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | Record<string, unknown>;

const IMAGE_OMITTED = "[image omitted]";

function blockText(block: Block): string | null {
  const b = block as { type: string; text?: unknown; content?: unknown };
  if (b.type === "compaction") return typeof b.content === "string" && b.content ? `[Summary of the earlier conversation]\n${b.content}` : null;
  if (b.type === "image") return IMAGE_OMITTED;
  return typeof b.text === "string" ? b.text : null;
}

/**
 * Session history as Responses input items. Reasoning items this API returned earlier go back
 * verbatim (encrypted, since nothing is stored server-side); Anthropic's own thinking is dropped.
 */
export function toResponsesInput(history: MessageParam[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const message of history) {
    const blocks: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const text: string[] = [];
    const flushText = () => {
      if (text.length) items.push({ role: message.role, content: text.splice(0).join("\n\n") });
    };
    for (const block of blocks) {
      if (block.type === "thinking") {
        for (const item of readForeign(block)?.data.items ?? []) items.push(item as Record<string, unknown>);
      } else if (block.type === "redacted_thinking") {
        continue;
      } else if (block.type === "tool_use") {
        flushText();
        items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === "tool_result") {
        const c = block.content;
        const output = c === undefined ? "" : typeof c === "string" ? c : c.map((p) => (p.type === "text" ? p.text : IMAGE_OMITTED)).join("\n");
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.is_error ? `Error: ${output}` : output || "(no output)" });
      } else {
        const t = blockText(block);
        if (t) text.push(t);
      }
    }
    flushText();
  }
  return items;
}

export function toResponsesTools(tools: AnyTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: toolInputSchema(t), strict: false }));
}

/** Per-provider Responses options. */
export interface ResponsesOptions {
  /** Ask for reasoning summaries to show while the model thinks. */
  summaries: boolean;
  /** Ask for encrypted reasoning so it can be sent back on later turns. */
  encryptedReasoning: boolean;
  /** Effort levels the provider accepts; ours is clamped to these. All of ours when absent. */
  efforts?: readonly Effort[];
}

export function responsesBody(model: string, req: TurnRequest, opts: ResponsesOptions): { body: Record<string, unknown>; withoutReasoning: Record<string, unknown> } {
  const tools = toResponsesTools(req.tools);
  const base: Record<string, unknown> = {
    model,
    instructions: req.system,
    input: toResponsesInput(req.messages),
    ...(tools.length ? { tools } : {}),
    stream: true,
    store: false,
  };
  const effort = opts.efforts ? clampEffort(req.effort, opts.efforts) : req.effort;
  const reasoning = { effort, ...(opts.summaries ? { summary: "auto" } : {}) };
  const body = { ...base, reasoning, ...(opts.encryptedReasoning ? { include: ["reasoning.encrypted_content"] } : {}) };
  return { body, withoutReasoning: base };
}

interface OutputItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
  summary?: Array<{ text?: string }>;
  encrypted_content?: string;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  /** xAI: the charge, in units of 1e-10 USD. */
  cost_in_usd_ticks?: number;
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: OutputItem;
  message?: string;
  response?: { status?: string; usage?: ResponsesUsage; incomplete_details?: { reason?: string } | null; error?: { message?: string } | null };
}

/** Builds the final message from the completed output items; deltas only drive the live display. */
export class ResponsesAccumulator {
  private readonly items: OutputItem[] = [];
  private status = "completed";
  private incomplete: string | undefined;
  private usage: ResponsesUsage = {};
  private refused = false;

  constructor(
    private readonly requestedModel: string,
    private readonly handlers: StreamHandlers,
  ) {}

  push(event: ResponsesEvent): void {
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) this.handlers.onText(event.delta);
        return;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (event.delta) this.handlers.onThinking(event.delta);
        return;
      case "response.output_item.done":
        if (event.item) this.items.push(event.item);
        return;
      case "response.completed":
      case "response.incomplete":
        this.status = event.response?.status ?? (event.type === "response.completed" ? "completed" : "incomplete");
        this.incomplete = event.response?.incomplete_details?.reason;
        this.usage = event.response?.usage ?? {};
        return;
      case "response.failed":
        throw new ProviderError(`The model failed: ${event.response?.error?.message ?? "no reason given"}`, null, true);
      case "error":
        throw new ProviderError(`The provider reported an error mid-response: ${event.message ?? JSON.stringify(event)}`, null, true);
    }
  }

  finalMessage(): Message {
    const content: Array<Record<string, unknown>> = [];
    const reasoningItems = this.items.filter((i) => i.type === "reasoning" && i.encrypted_content);
    if (reasoningItems.length) {
      const summary = reasoningItems.flatMap((i) => (i.summary ?? []).map((s) => s.text ?? "")).join("\n\n");
      content.push(foreignThinking(summary, { items: reasoningItems }) as unknown as Record<string, unknown>);
    }
    const text: string[] = [];
    for (const item of this.items) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) text.push(part.text);
        if (part.type === "refusal" && part.refusal) {
          text.push(part.refusal);
          this.refused = true;
        }
      }
    }
    if (text.length) content.push({ type: "text", text: text.join(""), citations: null });
    for (const [i, item] of this.items.filter((x) => x.type === "function_call").entries()) {
      let input: unknown;
      try {
        input = item.arguments?.trim() ? JSON.parse(item.arguments) : {};
      } catch {
        if (this.incomplete === "max_output_tokens") continue;
        throw new MalformedToolCallError(item.name ?? "a tool");
      }
      content.push({ type: "tool_use", id: safeToolId(item.call_id ?? "", i), name: item.name ?? "", input, caller: null });
    }
    let stop: Message["stop_reason"] = "end_turn";
    if (this.refused || this.incomplete === "content_filter") stop = "refusal";
    else if (this.status === "incomplete" && this.incomplete === "max_output_tokens") stop = "max_tokens";
    else if (content.some((b) => b.type === "tool_use")) stop = "tool_use";
    const cached = this.usage.input_tokens_details?.cached_tokens ?? 0;
    const usage = {
      input_tokens: Math.max(0, (this.usage.input_tokens ?? 0) - cached),
      output_tokens: this.usage.output_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      ...(typeof this.usage.cost_in_usd_ticks === "number" ? { cost_usd: this.usage.cost_in_usd_ticks / 1e10 } : {}),
    };
    return { id: "", type: "message", role: "assistant", model: this.requestedModel, content, stop_reason: stop, stop_sequence: null, usage } as unknown as Message;
  }
}

export class ResponsesModel implements Model {
  constructor(
    private readonly endpoint: ChatEndpoint,
    private readonly opts: ResponsesOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(req: TurnRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<Message> {
    const model = req.model.slice(req.model.indexOf("/") + 1);
    const { body, withoutReasoning } = responsesBody(model, req, this.opts);
    const res = await postWithEffortFallback(this.endpoint, "/responses", body, withoutReasoning, req.model, signal, this.fetchImpl);
    if (!res.body) throw new ProviderError(`${this.endpoint.name} sent an empty response.`, res.status, true);
    const acc = new ResponsesAccumulator(req.model, handlers);
    for await (const event of sseJson(res.body)) acc.push(event as ResponsesEvent);
    return acc.finalMessage();
  }
}
