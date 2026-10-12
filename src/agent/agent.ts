// src/agent/agent.ts
import Anthropic from "@anthropic-ai/sdk";
import { describeError } from "../api/errors";
import type { Message, Model } from "../api/model";
import { contextTokens, messageCostUsd } from "../api/pricing";
import type { Effort, Mode } from "../config/constants";
import { modeReminder } from "../context/system-prompt";
import { decide, type PermissionContext } from "../permissions/engine";
import { danglingToolResults, type MessageParam } from "../session/store";
import type { AnyTool, ToolContext, ToolOutput } from "../tools/types";
import type { AgentEvent, PermissionAnswer, PermissionPrompt, ToolStatus, TurnEndReason } from "./events";

type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export const INTERRUPTED = "[interrupted by user]";
const MAX_JSON_RETRIES = 2;

export interface AgentOptions {
  model: Model;
  tools: AnyTool[];
  system: string;
  config(): { model: string; effort: Effort; refusalFallback: boolean };
  permissions(): PermissionContext;
  askPermission(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer>;
  onAllowAlways?(rule: string): Promise<void> | void;
  contextText(): Promise<string>;
  persist(message: MessageParam): Promise<void>;
  toolContext: Omit<ToolContext, "signal">;
  maxTurns?: number;
  emit(event: AgentEvent): void;
}

/** Settles with the tool's output, or with an interrupted result as soon as the signal aborts (a stuck tool is left behind). */
function raceAbort(run: Promise<ToolOutput>, signal: AbortSignal): Promise<ToolOutput> {
  return new Promise<ToolOutput>((resolve, reject) => {
    const interrupted = () => resolve({ content: INTERRUPTED, isError: true });
    if (signal.aborted) return interrupted();
    signal.addEventListener("abort", interrupted, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener("abort", interrupted));
  });
}

const errorResult = (id: string, content: string): ToolResult => ({ type: "tool_result", tool_use_id: id, content, is_error: true });

export class Agent {
  readonly messages: MessageParam[];
  totalCostUsd = 0;
  private lastMode: Mode | undefined;
  private askQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: AgentOptions,
    history: MessageParam[] = [],
  ) {
    this.messages = [...history];
  }

  /** Never rejects: a failure while preparing or running the turn ends it with reason "error". */
  async run(prompt: string, signal: AbortSignal): Promise<TurnEndReason> {
    try {
      // A previous run may have ended with tool_use blocks that never got results; close them first.
      const repair = danglingToolResults(this.messages);
      if (repair) await this.push(repair);
      const content: Anthropic.Beta.BetaTextBlockParam[] = [];
      if (this.messages.length === 0) content.push({ type: "text", text: await this.opts.contextText() });
      const mode = this.opts.permissions().mode;
      const reminder = modeReminder(this.lastMode, mode);
      this.lastMode = mode;
      if (reminder) content.push({ type: "text", text: reminder });
      content.push({ type: "text", text: prompt });
      await this.push({ role: "user", content });
      return await this.loop(signal);
    } catch (err) {
      this.emit({ type: "notice", level: "error", text: `Tropos could not complete this turn: ${(err as Error).message}` });
      this.emit({ type: "turn_end", reason: "error" });
      return "error";
    }
  }

  /** Appends to the in-memory history first; a failing session write is reported, never thrown. */
  private async push(message: MessageParam): Promise<void> {
    this.messages.push(message);
    try {
      await this.opts.persist(message);
    } catch (err) {
      this.emit({ type: "notice", level: "error", text: `Could not save the session: ${(err as Error).message}` });
    }
  }

  /** A misbehaving listener must never break the loop. */
  private emit(event: AgentEvent): void {
    try {
      this.opts.emit(event);
    } catch {
      // ignored on purpose
    }
  }

  private async loop(signal: AbortSignal): Promise<TurnEndReason> {
    const emit = (event: AgentEvent) => this.emit(event);
    const end = (reason: TurnEndReason) => {
      emit({ type: "turn_end", reason });
      return reason;
    };
    let turns = 0;
    let jsonRetries = 0;

    while (true) {
      if (signal.aborted) return end("aborted");
      if (this.opts.maxTurns !== undefined && turns >= this.opts.maxTurns) {
        emit({ type: "notice", level: "warn", text: `Stopped after ${this.opts.maxTurns} turn(s) (--max-turns).` });
        return end("max_turns");
      }
      turns++;

      const cfg = this.opts.config();
      let message: Message;
      try {
        message = await this.opts.model.send(
          {
            model: cfg.model,
            effort: cfg.effort,
            system: this.opts.system,
            tools: this.opts.tools,
            messages: [...this.messages],
            refusalFallback: cfg.refusalFallback,
          },
          {
            onText: (delta) => emit({ type: "text", delta }),
            onThinking: (delta) => emit({ type: "thinking", delta }),
          },
          signal,
        );
        jsonRetries = 0;
      } catch (err) {
        if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return end("aborted");
        if (err instanceof Anthropic.APIError) {
          emit({ type: "notice", level: "error", text: describeError(err).message });
          return end("error");
        }
        // The SDK reports an unparseable eager-streamed tool input as a bare AnthropicError
        // (not an APIError). Re-request that, at most twice; anything else ends the turn.
        if (err instanceof Anthropic.AnthropicError && jsonRetries < MAX_JSON_RETRIES) {
          jsonRetries++;
          turns--;
          emit({ type: "notice", level: "warn", text: "A tool call arrived malformed; asking the model again." });
          continue;
        }
        emit({ type: "notice", level: "error", text: describeError(err).message });
        return end("error");
      }

      this.recordUsage(message, cfg.model);
      // The API rejects an assistant message with no content, so an empty reply is not recorded.
      if (message.content.length > 0) await this.push({ role: "assistant", content: message.content });
      emit({ type: "assistant", message });
      const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");

      if (message.stop_reason === "refusal") {
        const category = (message as { stop_details?: { category?: string | null } | null }).stop_details?.category;
        emit({
          type: "notice",
          level: "error",
          text: `The model declined this request${category ? ` (${category})` : ""}. Try rephrasing it.`,
        });
        if (toolUses.length > 0) {
          await this.push({ role: "user", content: toolUses.map((t) => errorResult(t.id, "Not run: the response was declined.")) });
        }
        return end("refusal");
      }
      if (message.stop_reason === "model_context_window_exceeded") {
        if (toolUses.length > 0) {
          await this.push({
            role: "user",
            content: toolUses.map((t) => errorResult(t.id, "Not run: the conversation no longer fits in the model's context window.")),
          });
        }
        emit({ type: "notice", level: "warn", text: "The conversation no longer fits in the model's context. Start a new one with /clear." });
        return end("end_turn");
      }
      if (message.stop_reason === "pause_turn" || message.stop_reason === "compaction") continue;
      if (message.stop_reason === "max_tokens") {
        if (toolUses.length > 0) {
          await this.push({
            role: "user",
            content: toolUses.map((t) =>
              errorResult(t.id, "Not run: the response hit the output limit before this tool call was complete. Split the work into smaller steps."),
            ),
          });
          continue;
        }
        emit({ type: "notice", level: "warn", text: "The response hit the output token limit and was cut off." });
        return end("end_turn");
      }
      if (toolUses.length === 0) return end("end_turn");

      const results = await this.runTools(toolUses, signal);
      await this.push({ role: "user", content: results });
      if (signal.aborted) return end("aborted");
    }
  }

  /** Consecutive read/meta calls run in parallel; edit/exec calls run one at a time. Order is preserved. */
  private async runTools(toolUses: ToolUse[], signal: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    let batch: ToolUse[] = [];
    const flush = async () => {
      results.push(...(await Promise.all(batch.map((t) => this.runTool(t, signal)))));
      batch = [];
    };
    for (const block of toolUses) {
      const kind = this.opts.tools.find((t) => t.name === block.name)?.kind;
      if (kind === "read" || kind === "meta" || kind === undefined) {
        batch.push(block);
        continue;
      }
      await flush();
      results.push(await this.runTool(block, signal));
    }
    await flush();
    return results;
  }

  private finish(block: ToolUse, name: string, output: ToolOutput, status: ToolStatus): ToolResult {
    this.emit({ type: "tool_end", id: block.id, name, output, status });
    return output.isError
      ? { type: "tool_result", tool_use_id: block.id, content: output.content, is_error: true }
      : { type: "tool_result", tool_use_id: block.id, content: output.content };
  }

  /** Prompts are serialized. Aborting answers an open prompt with a denial so the queue never wedges. */
  private ask(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer> {
    const denied: PermissionAnswer = { kind: "deny" };
    const next = this.askQueue.then(
      () =>
        new Promise<PermissionAnswer>((resolve) => {
          if (signal.aborted) return resolve(denied);
          const onAbort = () => resolve(denied);
          signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve()
            .then(() => this.opts.askPermission(prompt, signal))
            .catch(() => denied)
            .then((answer) => {
              signal.removeEventListener("abort", onAbort);
              resolve(answer);
            });
        }),
    );
    this.askQueue = next;
    return next;
  }

  /** Never throws: any failure becomes an error result so the tool_use is always answered. */
  private async runTool(block: ToolUse, signal: AbortSignal): Promise<ToolResult> {
    try {
      return await this.runToolUnsafe(block, signal);
    } catch (err) {
      const name = this.opts.tools.find((t) => t.name === block.name)?.name ?? block.name;
      return this.finish(block, name, { content: `${name} failed: ${(err as Error).message}`, isError: true }, "error");
    }
  }

  private async runToolUnsafe(block: ToolUse, signal: AbortSignal): Promise<ToolResult> {
    const emit = (event: AgentEvent) => this.emit(event);
    if (signal.aborted) return errorResult(block.id, INTERRUPTED);

    const tool = this.opts.tools.find((t) => t.name === block.name);
    if (!tool) {
      emit({ type: "tool_start", id: block.id, name: block.name, summary: "", input: block.input });
      return this.finish(block, block.name, { content: `Unknown tool: ${block.name}`, isError: true }, "error");
    }
    const parsed = tool.schema.safeParse(block.input);
    if (!parsed.success) {
      emit({ type: "tool_start", id: block.id, name: tool.name, summary: "", input: block.input });
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
      return this.finish(block, tool.name, { content: `INVALID_INPUT: ${issues}`, isError: true }, "error");
    }
    const input = parsed.data;
    const summary = tool.summarize(input);
    emit({ type: "tool_start", id: block.id, name: tool.name, summary, input });

    let subject;
    try {
      subject = tool.subject(input, this.opts.toolContext.cwd());
    } catch (err) {
      // e.g. PathResolutionError: fail closed, never run the tool.
      return this.finish(block, tool.name, { content: `${tool.name} refused: ${(err as Error).message}`, isError: true }, "error");
    }
    const decision = decide({ toolName: tool.name, kind: tool.kind, ...subject }, this.opts.permissions());
    if (decision.behavior === "deny") {
      return this.finish(block, tool.name, { content: decision.reason, isError: true }, "denied");
    }
    if (decision.behavior === "ask") {
      const answer = await this.ask(
        { toolName: tool.name, kind: tool.kind, summary, input, reason: decision.reason, suggestion: decision.suggestion },
        signal,
      );
      if (signal.aborted) return this.finish(block, tool.name, { content: INTERRUPTED, isError: true }, "error");
      if (answer.kind === "deny") {
        const content =
          answer.message ??
          (answer.feedback
            ? `The user declined this action and said: ${answer.feedback}`
            : "The user declined this action. Ask what they would like to do instead.");
        return this.finish(block, tool.name, { content, isError: true }, "denied");
      }
      if (answer.kind === "allow_always") await this.opts.onAllowAlways?.(answer.rule);
    }

    let output: ToolOutput;
    try {
      // approvedPaths lets file tools refuse if the path resolves differently at write time (TOCTOU).
      const permissions = this.opts.permissions();
      // isDenied lets search tools drop files covered by deny rules when they scan a directory.
      const isDenied = (path: string) =>
        decide({ toolName: tool.name, kind: tool.kind, paths: [path] }, permissions).behavior === "deny" ||
        decide({ toolName: "Read", kind: "read", paths: [path] }, permissions).behavior === "deny";
      output = await raceAbort(tool.run(input, { ...this.opts.toolContext, signal, approvedPaths: subject.paths, isDenied }), signal);
    } catch (err) {
      output = { content: `${tool.name} failed: ${(err as Error).message}`, isError: true };
    }
    return this.finish(block, tool.name, output, output.isError ? "error" : "done");
  }

  private recordUsage(message: Message, requestedModel: string): void {
    // Sums compaction/fallback iterations and prices fallbacks at the model that served them.
    const cost = messageCostUsd(message, requestedModel);
    this.totalCostUsd += cost ?? 0;
    this.emit({
      type: "usage",
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      contextTokens: contextTokens(message.usage),
      costUsd: cost,
      totalCostUsd: this.totalCostUsd,
    });
  }
}
