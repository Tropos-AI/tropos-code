// src/agent/agent.ts
import Anthropic from "@anthropic-ai/sdk";
import { describeError } from "../api/errors";
import type { Attachment } from "../attachments/attachments";
import { attachmentBlocks } from "../attachments/validate";
import { errorText } from "../error-text";
import type { Message, Model } from "../api/model";
import { contextTokens, messageCostUsd } from "../api/pricing";
import { MalformedToolCallError } from "../providers/chat";
import type { Effort, Mode } from "../config/constants";
import type { HookEvent } from "../config/settings";
import { modeReminder } from "../context/system-prompt";
import { decide, ownFilePath, type PermissionContext } from "../permissions/engine";
import { danglingToolResults, type MessageParam } from "../session/store";
import { toolKind, type AnyTool, type ToolContext, type ToolOutput, type ToolResultContent } from "../tools/types";
import type { AgentEvent, PermissionAnswer, PermissionPrompt, ToolStatus, TurnEndReason } from "./events";

type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export const INTERRUPTED = "[interrupted by user]";
/** For an exec tool stopped while it ran (a command, a text being sent): it may have acted before the stop. */
export const EXEC_INTERRUPTED = `Stopped while it was running, so the action may already have happened. Check before repeating it.\n${INTERRUPTED}`;
const MAX_JSON_RETRIES = 2;
/** A Stop hook may send the model back to work this many times per user turn, so a broken hook can't loop forever. */
const MAX_STOP_CONTINUES = 3;

/** What one hook event decided (see hooks/runner.ts, which implements AgentHooks). */
export interface HookResult {
  blocked?: string;
  permission?: "allow" | "deny" | "ask";
  permissionReason?: string;
  updatedInput?: unknown;
  additionalContext: string[];
  stop?: string;
  messages: string[];
  errors: string[];
}

export interface AgentHooks {
  has(event: HookEvent): boolean;
  run(event: HookEvent, input: Record<string, unknown>, match?: string, signal?: AbortSignal): Promise<HookResult>;
}

/**
 * Hook output for the model, marked so it reads as the harness speaking, not the user. The session's
 * nonce (see context/tags.ts) is what tells it apart from look-alike text in a file or web page.
 */
export function hookContext(event: HookEvent, texts: string[], nonce?: string): string {
  const attr = nonce ? ` nonce="${nonce}"` : "";
  return `<hook-context event="${event}"${attr}>\n${texts.join("\n")}\n</hook-context>`;
}

/** Adds text to a tool result, whether its content is a string or a block list. */
export function appendToContent(content: ToolResultContent, text: string): ToolResultContent {
  if (typeof content === "string") return content + text;
  return [...content, { type: "text", text: text.trimStart() }];
}

function contentText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}

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
  /** Records what one model reply cost, for usage reports. Called after every reply; failures are the caller's to swallow. */
  recordUsage?(entry: { model: string; usage: Message["usage"]; costUsd: number | undefined }): void;
  toolContext: Omit<ToolContext, "signal">;
  maxTurns?: number;
  emit(event: AgentEvent): void;
  /** Hooks from settings and plugins; absent when none are configured. */
  hooks?: AgentHooks;
  /** Which hook fires when this agent finishes: Stop for the main agent, SubagentStop for a subagent. */
  stopEvent?: { event: "Stop" } | { event: "SubagentStop"; agentType: string };
  /** Runs once per user turn, before its first edit or exec tool (snapshots for /undo). Failures are ignored. */
  beforeChange?(): Promise<void>;
  /** Text appended to a successful edit tool's result: formatter notes, language-server errors. */
  postWrite?(paths: string[], signal: AbortSignal): Promise<string | null>;
  /** The session's harness nonce, carried by hook-context blocks. */
  nonce?(): string;
  /** Runs as each user turn starts (snapshots mark turn boundaries); returns one-shot reminders for its message, such as that the user undid file changes. */
  startTurn?(): string[];
  /** Runs once a user turn has ended, with its reason and the history so far (the learning review starts here). Must not throw. */
  endTurn?(reason: TurnEndReason, messages: readonly MessageParam[]): void;
}

/**
 * Settles with the tool's output, or with an interrupted result as soon as the signal aborts (a stuck tool is left
 * behind). `content` is that result's text.
 */
function raceAbort(run: Promise<ToolOutput>, signal: AbortSignal, content: string = INTERRUPTED): Promise<ToolOutput> {
  return new Promise<ToolOutput>((resolve, reject) => {
    const interrupted = () => resolve({ content, isError: true });
    if (signal.aborted) {
      // The tool already started; its later failure must not become an unhandled rejection.
      run.catch(() => {});
      return interrupted();
    }
    signal.addEventListener("abort", interrupted, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener("abort", interrupted));
  });
}

/** Settles with the work's value, or with undefined as soon as the signal aborts (the work is left behind). */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const stop = () => resolve(undefined);
    if (signal.aborted) {
      work.catch(() => {});
      return stop();
    }
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** The tool's preview for a permission prompt; a preview that throws is left out, never the prompt. */
function previewOf(tool: AnyTool, input: unknown): { preview?: { header: string; text: string } } {
  try {
    const preview = tool.preview?.(input);
    return preview ? { preview } : {};
  } catch {
    return {};
  }
}

/** The message of a caught value: anything can be thrown, not only Error. */
const errorResult = (id: string, content: string): ToolResult => ({ type: "tool_result", tool_use_id: id, content, is_error: true });

export class Agent {
  readonly messages: MessageParam[];
  /** Undefined once any reply came from a model with no known price: an undercount would read as a real total. */
  totalCostUsd: number | undefined = 0;
  private lastMode: Mode | undefined;
  private askQueue: Promise<unknown> = Promise.resolve();
  /** Set when this user turn has recorded its pre-change snapshot. */
  private changeRecorded = false;
  /** Set when a hook asked to stop the turn (`continue: false`). */
  private stopRequested: string | undefined;

  constructor(
    private readonly opts: AgentOptions,
    history: MessageParam[] = [],
  ) {
    this.messages = [...history];
  }

  /** Never rejects: a failure while preparing or running the turn ends it with reason "error". `attachments` were validated by the caller. */
  async run(prompt: string, signal: AbortSignal, attachments: Attachment[] = []): Promise<TurnEndReason> {
    const reason = await this.runTurn(prompt, signal, attachments);
    try {
      this.opts.endTurn?.(reason, this.messages);
    } catch {
      // an observer; the turn itself is over
    }
    return reason;
  }

  private async runTurn(prompt: string, signal: AbortSignal, attachments: Attachment[]): Promise<TurnEndReason> {
    try {
      const blocked = await this.startUserTurn(prompt, signal, attachments);
      return blocked ?? (await this.loop(signal));
    } catch (err) {
      return this.failTurn(err);
    }
  }

  private failTurn(err: unknown): TurnEndReason {
    this.emit({ type: "notice", level: "error", text: `Tropos could not complete this turn: ${errorText(err)}` });
    this.emit({ type: "turn_end", reason: "error" });
    return "error";
  }

  /**
   * Records the user message (context block, reminders, UserPromptSubmit hook output).
   * Returns "blocked" when a hook refused the prompt; otherwise undefined.
   */
  private async startUserTurn(prompt: string, signal: AbortSignal, attachments: Attachment[] = []): Promise<TurnEndReason | undefined> {
    // A previous run may have ended with tool_use blocks that never got results; close them first.
    const repair = danglingToolResults(this.messages);
    if (repair) await this.push(repair);
    this.changeRecorded = false;
    this.stopRequested = undefined;
    let hookTexts: string[] = [];
    if (this.opts.hooks?.has("UserPromptSubmit")) {
      const out = await this.hook("UserPromptSubmit", { prompt }, undefined, signal);
      const refusal = out.blocked ?? out.stop;
      if (refusal !== undefined) {
        this.emit({ type: "notice", level: "error", text: `A UserPromptSubmit hook blocked this prompt: ${refusal}` });
        this.emit({ type: "turn_end", reason: "blocked" });
        return "blocked";
      }
      hookTexts = out.additionalContext;
    }
    const content: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
    if (this.messages.length === 0) {
      // Esc must work while the context is still being gathered; nothing has been recorded yet, so nothing is left behind.
      const context = await untilAbort(this.opts.contextText(), signal);
      if (context === undefined) {
        this.emit({ type: "turn_end", reason: "aborted" });
        return "aborted";
      }
      content.push({ type: "text", text: context });
    }
    const mode = this.opts.permissions().mode;
    const reminder = modeReminder(this.lastMode, mode);
    this.lastMode = mode;
    if (reminder) content.push({ type: "text", text: reminder });
    for (const text of this.opts.startTurn?.() ?? []) content.push({ type: "text", text });
    if (hookTexts.length > 0) content.push({ type: "text", text: hookContext("UserPromptSubmit", hookTexts, this.opts.nonce?.()) });
    content.push(...attachmentBlocks(attachments));
    // The API rejects an empty text block: a message of images alone has none.
    if (prompt || attachments.length === 0) content.push({ type: "text", text: prompt });
    await this.push({ role: "user", content });
    return undefined;
  }

  /**
   * One user turn without the model: the message is recorded as `run` would, `call` goes through the
   * normal tool path (permissions, hooks, events), and `reply` turns its result into the assistant's answer.
   * Never rejects.
   */
  async runDirect(
    prompt: string,
    call: { name: string; input: unknown },
    reply: (result: { text: string; isError: boolean }) => string,
    signal: AbortSignal,
  ): Promise<TurnEndReason> {
    const reason = await this.runDirectTurn(prompt, call, reply, signal);
    try {
      this.opts.endTurn?.(reason, this.messages);
    } catch {
      // an observer; the turn itself is over
    }
    return reason;
  }

  private async runDirectTurn(
    prompt: string,
    call: { name: string; input: unknown },
    reply: (result: { text: string; isError: boolean }) => string,
    signal: AbortSignal,
  ): Promise<TurnEndReason> {
    try {
      const blocked = await this.startUserTurn(prompt, signal);
      if (blocked) return blocked;
      const block = { type: "tool_use", id: `toolu_direct_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, name: call.name, input: call.input } as ToolUse;
      const model = this.opts.config().model;
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const assistant = (content: unknown[], stop: string) =>
        ({ id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage }) as unknown as Message;
      await this.push({ role: "assistant", content: [block] });
      const result = await this.runTool(block, signal);
      await this.push({ role: "user", content: [result] });
      if (signal.aborted) {
        this.emit({ type: "turn_end", reason: "aborted" });
        return "aborted";
      }
      const text = reply({ text: contentText(result.content as ToolResultContent), isError: result.is_error === true });
      const message = assistant([{ type: "text", text, citations: null }], "end_turn");
      this.emit({ type: "text", delta: text });
      await this.push({ role: "assistant", content: [{ type: "text", text }] });
      this.emit({ type: "assistant", message });
      this.emit({ type: "turn_end", reason: "end_turn" });
      return "end_turn";
    } catch (err) {
      return this.failTurn(err);
    }
  }

  /** Appends to the in-memory history first; a failing session write is reported, never thrown. */
  private async push(message: MessageParam): Promise<void> {
    this.messages.push(message);
    try {
      await this.opts.persist(message);
    } catch (err) {
      this.emit({ type: "notice", level: "error", text: `Could not save the session: ${errorText(err)}` });
    }
  }

  /** Runs a hook event and surfaces its messages and errors as notices. */
  private async hook(event: HookEvent, input: Record<string, unknown>, match: string | undefined, signal: AbortSignal): Promise<HookResult> {
    const out = await this.opts.hooks!.run(event, input, match, signal);
    for (const text of out.messages) this.emit({ type: "notice", level: "info", text });
    for (const text of out.errors) this.emit({ type: "notice", level: "warn", text: `${event} hook: ${text}` });
    return out;
  }

  /**
   * Fires Stop (or SubagentStop) when the model is done. Returns the reason to keep going when a
   * hook blocks the stop, or undefined to end the turn.
   */
  private async stopHook(message: Message, active: boolean, signal: AbortSignal): Promise<string | undefined> {
    const stop = this.opts.stopEvent ?? { event: "Stop" as const };
    if (!this.opts.hooks?.has(stop.event)) return undefined;
    const last = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const input: Record<string, unknown> = { stop_hook_active: active, last_assistant_message: last };
    if (stop.event === "SubagentStop") input.agent_type = stop.agentType;
    const out = await this.hook(stop.event, input, stop.event === "SubagentStop" ? stop.agentType : undefined, signal);
    if (out.stop !== undefined) return undefined;
    return out.blocked;
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
    let stopContinues = 0;

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
            onNotice: (text) => emit({ type: "notice", level: "warn", text }),
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
        // (not an APIError) with this message; other providers' adapters throw MalformedToolCallError.
        // Re-request that, at most twice; anything else ends the turn.
        const malformed =
          err instanceof MalformedToolCallError ||
          (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && err.message.startsWith("Unable to parse tool parameter JSON"));
        if (malformed && jsonRetries < MAX_JSON_RETRIES) {
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
        emit({ type: "notice", level: "error", text: "The conversation no longer fits in the model's context. Start a new one with /clear." });
        return end("context_exceeded");
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
        emit({ type: "notice", level: "error", text: "The response hit the output token limit and was cut off." });
        return end("max_tokens");
      }
      if (toolUses.length === 0) {
        if (stopContinues >= MAX_STOP_CONTINUES || signal.aborted) return end("end_turn");
        const reason = await this.stopHook(message, stopContinues > 0, signal);
        if (reason === undefined || signal.aborted) return end("end_turn");
        stopContinues++;
        const event = this.opts.stopEvent?.event ?? "Stop";
        emit({ type: "notice", level: "info", text: `A ${event} hook asked Tropos to continue: ${reason}` });
        await this.push({ role: "user", content: [{ type: "text", text: hookContext(event, [reason], this.opts.nonce?.()) }] });
        continue;
      }

      const results = await this.runTools(toolUses, signal);
      await this.push({ role: "user", content: results });
      if (signal.aborted) return end("aborted");
      if (this.stopRequested !== undefined) {
        emit({ type: "notice", level: "warn", text: `A hook stopped the turn: ${this.stopRequested}` });
        return end("blocked");
      }
    }
  }

  /**
   * Consecutive read/meta calls run in parallel; edit/exec calls, unknown tools and tools that
   * declare no kind run one at a time, since nothing says they are free of side effects. Order is preserved.
   */
  private async runTools(toolUses: ToolUse[], signal: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    let batch: ToolUse[] = [];
    const flush = async () => {
      results.push(...(await Promise.all(batch.map((t) => this.runTool(t, signal)))));
      batch = [];
    };
    for (const block of toolUses) {
      const tool = this.opts.tools.find((t) => t.name === block.name);
      const kind = tool ? toolKind(tool) : undefined;
      if (kind === "read" || kind === "meta" || kind === "net") {
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
      return this.finish(block, name, { content: `${name} failed: ${errorText(err)}`, isError: true }, "error");
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
    let input = parsed.data;
    const kind = toolKind(tool);
    let summary = tool.summarize(input);
    emit({ type: "tool_start", id: block.id, name: tool.name, summary, input });

    let hookPermission: HookResult["permission"];
    if (this.opts.hooks?.has("PreToolUse")) {
      const out = await this.hook("PreToolUse", { tool_name: tool.name, tool_input: input, tool_use_id: block.id }, tool.name, signal);
      if (out.stop !== undefined) {
        this.stopRequested = out.stop;
        return this.finish(block, tool.name, { content: `Not run: a hook stopped the turn (${out.stop}).`, isError: true }, "denied");
      }
      if (out.blocked !== undefined) {
        return this.finish(block, tool.name, { content: `Blocked by a PreToolUse hook: ${out.blocked}`, isError: true }, "denied");
      }
      if (out.permission === "deny") {
        const why = out.permissionReason ? `: ${out.permissionReason}` : ".";
        return this.finish(block, tool.name, { content: `Denied by a PreToolUse hook${why}`, isError: true }, "denied");
      }
      if (out.updatedInput !== undefined) {
        const reparsed = tool.schema.safeParse(out.updatedInput);
        if (!reparsed.success) {
          return this.finish(block, tool.name, { content: "A PreToolUse hook rewrote the input into something invalid; not run.", isError: true }, "error");
        }
        input = reparsed.data;
        // The prompt must describe the call that will run, not the one the model asked for.
        summary = tool.summarize(input);
      }
      // Hooks run side by side on the original input, so an allow can't be tied to the rewritten one:
      // a rewritten call goes through the normal permission check.
      hookPermission = out.updatedInput !== undefined && out.permission === "allow" ? undefined : out.permission;
      // Esc while the hook ran: the call must not start.
      if (signal.aborted) return this.finish(block, tool.name, { content: INTERRUPTED, isError: true }, "error");
    }

    let subject;
    try {
      subject = tool.subject(input, this.opts.toolContext.cwd());
    } catch (err) {
      // e.g. PathResolutionError: fail closed, never run the tool.
      return this.finish(block, tool.name, { content: `${tool.name} refused: ${errorText(err)}`, isError: true }, "error");
    }
    let decision = decide({ toolName: tool.name, kind, ...subject }, this.opts.permissions());
    if (decision.behavior === "deny") {
      return this.finish(block, tool.name, { content: decision.reason, isError: true }, "denied");
    }
    // A hook's allow answers the prompt but never overrides a deny rule; its ask forces a prompt.
    if (hookPermission === "allow" && decision.behavior === "ask") decision = { behavior: "allow" };
    if (hookPermission === "ask" && decision.behavior === "allow") decision = { behavior: "ask", reason: "a PreToolUse hook asked for confirmation" };
    if (decision.behavior === "ask") {
      const answer = await this.ask(
        {
          toolName: tool.name,
          kind,
          summary,
          input,
          reason: decision.reason,
          suggestion: decision.suggestion,
          ...(subject.target !== undefined ? { target: subject.target } : {}),
          ...previewOf(tool, input),
        },
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

    if ((kind === "edit" || kind === "exec") && !this.changeRecorded && this.opts.beforeChange) {
      this.changeRecorded = true;
      await this.opts.beforeChange().catch(() => {});
      if (signal.aborted) return this.finish(block, tool.name, { content: INTERRUPTED, isError: true }, "error");
    }

    let output: ToolOutput;
    try {
      // approvedPaths lets file tools refuse if the path resolves differently at write time (TOCTOU).
      const permissions = this.opts.permissions();
      // isDenied lets search tools drop files covered by deny rules when they scan a directory.
      // A search over a folder that holds the chief's own files omits them for everyone (the owner reads them with an asked Read).
      const isDenied = (path: string) =>
        (!subject.paths.includes(path) && ownFilePath({ toolName: tool.name, kind, paths: [path] }, permissions) !== undefined) ||
        decide({ toolName: tool.name, kind, paths: [path] }, permissions).behavior === "deny" ||
        decide({ toolName: "Read", kind: "read", paths: [path] }, permissions).behavior === "deny";
      const progress = (text: string) => emit({ type: "tool_progress", id: block.id, text });
      output = await raceAbort(
        tool.run(input, { ...this.opts.toolContext, signal, approvedPaths: subject.paths, isDenied, toolUseId: block.id, progress }),
        signal,
        // It has started: an exec tool (a command, a text being sent) may already have acted.
        kind === "exec" ? EXEC_INTERRUPTED : INTERRUPTED,
      );
    } catch (err) {
      output = { content: `${tool.name} failed: ${errorText(err)}`, isError: true };
    }
    if (signal.aborted) return this.finish(block, tool.name, output, output.isError ? "error" : "done");
    if (!output.isError && kind === "edit" && this.opts.postWrite && subject.paths.length > 0) {
      const extra = await this.opts.postWrite(subject.paths, signal).catch(() => null);
      if (extra) output = { ...output, content: appendToContent(output.content, `\n\n${extra}`) };
    }
    output = await this.postToolHooks(tool.name, block.id, input, output, signal);
    return this.finish(block, tool.name, output, output.isError ? "error" : "done");
  }

  /** PostToolUse / PostToolUseFailure: their context and block reasons are appended to the result. */
  private async postToolHooks(name: string, id: string, input: unknown, output: ToolOutput, signal: AbortSignal): Promise<ToolOutput> {
    const event: HookEvent = output.isError ? "PostToolUseFailure" : "PostToolUse";
    if (!this.opts.hooks?.has(event)) return output;
    const text = contentText(output.content);
    const extra = output.isError ? { error: text } : { tool_response: text };
    const out = await this.hook(event, { tool_name: name, tool_input: input, tool_use_id: id, ...extra }, name, signal);
    if (out.stop !== undefined) this.stopRequested = out.stop;
    const texts = [...(out.blocked !== undefined ? [out.blocked] : []), ...out.additionalContext];
    if (texts.length === 0) return output;
    return { ...output, content: appendToContent(output.content, `\n\n${hookContext(event, texts, this.opts.nonce?.())}`) };
  }

  /** Adds a subagent's spend; an unknown price makes the total unknown, as for the agent's own replies. */
  addCost(costUsd: number | undefined): void {
    this.totalCostUsd = costUsd === undefined || this.totalCostUsd === undefined ? undefined : this.totalCostUsd + costUsd;
  }

  private recordUsage(message: Message, requestedModel: string): void {
    // Sums compaction/fallback iterations and prices fallbacks at the model that served them.
    const cost = messageCostUsd(message, requestedModel);
    this.totalCostUsd = cost === undefined || this.totalCostUsd === undefined ? undefined : this.totalCostUsd + cost;
    this.opts.recordUsage?.({ model: message.model || requestedModel, usage: message.usage, costUsd: cost });
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
