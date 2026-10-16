// src/learning/review.ts
// The learning loop (Hermes): after enough user turns or tool calls, a background agent re-reads a copy of
// the conversation and saves what is worth keeping to memory and skills; near the context limit, a flush
// review writes the session's durable state to the daily note before compaction loses it.
import { Agent, type AgentHooks } from "../agent/agent";
import type { PermissionAnswer, PermissionPrompt, TurnEndReason } from "../agent/events";
import type { Model } from "../api/model";
import type { Effort } from "../config/constants";
import type { PermissionContext } from "../permissions/engine";
import type { MessageParam } from "../session/store";
import type { AnyTool, ToolContext } from "../tools/types";
import {
  COMBINED_REVIEW_PROMPT,
  FLUSH_PROMPT,
  MEMORY_REVIEW_PROMPT,
  REVIEW_ALLOWED_TOOLS,
  REVIEW_WRITE_TOOLS,
  SKILL_REVIEW_PROMPT,
} from "./review-prompts";

export type ReviewKind = "memory" | "skill" | "combined" | "flush";

export const REVIEW_PROMPTS: Record<ReviewKind, string> = {
  memory: MEMORY_REVIEW_PROMPT,
  skill: SKILL_REVIEW_PROMPT,
  combined: COMBINED_REVIEW_PROMPT,
  flush: FLUSH_PROMPT,
};

export interface ReviewResult {
  /** Successful writes, e.g. { tool: "Memory", summary: "Memory add user: prefers bun" }. */
  changes: Array<{ tool: string; summary: string }>;
  /** Undefined when a reply came from a model without a known price. */
  costUsd?: number;
  /** The review's last reply ("NOTHING" when it saved nothing). */
  reply: string;
}

export interface LearningLoopDeps {
  settings(): { review: boolean; interval: number; flushAt: number };
  /** Builds and runs the review agent; the integrator implements it with the real Agent. Must resolve when done. */
  runReview(kind: ReviewKind, prompt: string, history: MessageParam[], signal: AbortSignal): Promise<ReviewResult>;
  notice(text: string): void;
  now?: () => number;
}

export interface LastReview {
  kind: ReviewKind;
  startedAt: number;
  changes: number;
  /** Set when the review threw; the loop never surfaces it beyond this. */
  failed?: boolean;
  aborted?: boolean;
}

const NOTICE_PREFIX = "💡 Learned: ";
const NOTICE_MAX = 160;

/** The one-line notice for a review that changed something, clipped to NOTICE_MAX characters. */
export function learnedNotice(changes: ReviewResult["changes"]): string {
  const text = NOTICE_PREFIX + changes.map((c) => c.summary).join("; ");
  return text.length > NOTICE_MAX ? `${text.slice(0, NOTICE_MAX - 1)}…` : text;
}

/** One per runtime. Feed it the main agent's events; it decides when a review runs and keeps at most one in flight. */
export class LearningLoop {
  /** User turns since the main agent last saved to memory (or since the last memory review). */
  private turnsSinceMemory = 0;
  /** Tool calls since the main agent last wrote a skill (or since the last skill review). */
  private toolsSinceSkill = 0;
  private contextFraction = 0;
  /** One flush per compaction cycle: disarmed when it runs, re-armed when the context shrinks below half the threshold. */
  private flushArmed = true;
  private controller: AbortController | undefined;
  private current: Promise<void> | undefined;
  private lastReview: LastReview | undefined;

  constructor(private readonly deps: LearningLoopDeps) {}

  get running(): boolean {
    return this.current !== undefined;
  }

  /** What the most recent review was, for status displays. */
  get last(): LastReview | undefined {
    return this.lastReview;
  }

  /** The main agent's tool calls. Its own successful saves postpone the matching review. */
  onToolEnd(toolName: string, status: "done" | "error" | "denied"): void {
    this.toolsSinceSkill++;
    if (status !== "done") return;
    if (toolName === "Memory") this.turnsSinceMemory = 0;
    if (toolName === "SkillManage") this.toolsSinceSkill = 0;
  }

  /** The main agent's latest context size. */
  onUsage(contextTokens: number, contextWindow: number): void {
    if (!(contextWindow > 0)) return;
    this.contextFraction = contextTokens / contextWindow;
    if (this.contextFraction < this.deps.settings().flushAt / 2) this.flushArmed = true;
  }

  /** Fire-and-forget: call after every main-agent turn. */
  afterTurn(reason: TurnEndReason, history: MessageParam[]): void {
    this.turnsSinceMemory++;
    const settings = this.deps.settings();
    if (reason !== "end_turn" || !settings.review || this.running || history.length === 0) return;
    const pre = { turnsSinceMemory: this.turnsSinceMemory, toolsSinceSkill: this.toolsSinceSkill, flushArmed: this.flushArmed };
    const kind = this.pickKind(settings);
    if (!kind) return;
    // Only what pickKind consumed is put back on failure: restoring a counter it left alone would double it.
    const consumed = {
      turnsSinceMemory: pre.turnsSinceMemory - this.turnsSinceMemory,
      toolsSinceSkill: pre.toolsSinceSkill - this.toolsSinceSkill,
      flushArmed: pre.flushArmed && !this.flushArmed,
    };
    this.start(kind, [...history], consumed);
  }

  /** Aborts the running review; called when a new user turn starts so the review never competes with it. */
  cancel(): void {
    this.controller?.abort();
  }

  /** Resolves once no review is running (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.current) await this.current;
  }

  private pickKind(settings: { interval: number; flushAt: number }): ReviewKind | undefined {
    if (this.flushArmed && this.contextFraction >= settings.flushAt) {
      this.flushArmed = false;
      return "flush";
    }
    const memory = this.turnsSinceMemory >= settings.interval;
    const skill = this.toolsSinceSkill >= settings.interval;
    if (memory) this.turnsSinceMemory = 0;
    if (skill) this.toolsSinceSkill = 0;
    if (memory && skill) return "combined";
    if (memory) return "memory";
    if (skill) return "skill";
    return undefined;
  }

  /**
   * A review that was cancelled or failed before saving anything didn't happen: put back what it consumed (the
   * counters it reset, the flush it disarmed), so the next turn tries again instead of waiting a full interval.
   */
  private restore(before: { turnsSinceMemory: number; toolsSinceSkill: number; flushArmed: boolean }): void {
    this.turnsSinceMemory += before.turnsSinceMemory;
    this.toolsSinceSkill += before.toolsSinceSkill;
    this.flushArmed ||= before.flushArmed;
  }

  private start(kind: ReviewKind, history: MessageParam[], before: { turnsSinceMemory: number; toolsSinceSkill: number; flushArmed: boolean }): void {
    const controller = new AbortController();
    const record: LastReview = { kind, startedAt: (this.deps.now ?? Date.now)(), changes: 0 };
    this.controller = controller;
    this.lastReview = record;
    const run = async () => {
      try {
        // Inside the async body, so even a synchronous throw from runReview lands in the catch below.
        const result = await this.deps.runReview(kind, REVIEW_PROMPTS[kind], history, controller.signal);
        if (controller.signal.aborted) record.aborted = true;
        record.changes = result.changes.length;
        // Saves made before a cancel are real: they are announced like any other.
        if (result.changes.length > 0) this.deps.notice(learnedNotice(result.changes));
        else if (record.aborted) this.restore(before);
      } catch {
        // A failed review is not the user's problem: nothing is surfaced, and it is tried again later.
        if (controller.signal.aborted) record.aborted = true;
        else record.failed = true;
        this.restore(before);
      }
    };
    const current = run().finally(() => {
      if (this.current === current) this.current = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
    this.current = current;
  }
}

const REMOVE_ONLY_REFUSAL = "The learning review can't only remove notes; replace or merge them instead.";

/**
 * The review's tool list: the same names, descriptions and schemas in the same order as the main agent's
 * (so the prompt cache is shared), but tools outside `allowed` refuse to run. They become "meta" with no
 * paths, so a call never reaches a permission prompt. SkillManage never deletes during a review.
 */
export function reviewToolGate(
  tools: AnyTool[],
  allowed: readonly string[] = REVIEW_ALLOWED_TOOLS,
  /** Implementations swapped in under the same name and schema, e.g. a SkillManage that writes to skills-learned. */
  overrides: Record<string, Pick<AnyTool, "subject" | "run">> = {},
): AnyTool[] {
  return tools.map((original) => {
    const swap = Object.hasOwn(overrides, original.name) ? overrides[original.name] : undefined;
    const tool = swap ? wrap(original, { kind: original.kind, subject: swap.subject, run: swap.run }) : original;
    if (allowed.includes(tool.name)) {
      if (tool.name === "Memory") {
        // Unattended, the review may add, replace and consolidate but never only remove; the ledger keeps undo for every change.
        return wrap(tool, {
          kind: tool.kind,
          subject: (input, cwd) => tool.subject(input, cwd),
          run: (input, ctx) =>
            consolidates(input) ? tool.run(input, ctx) : Promise.resolve({ content: REMOVE_ONLY_REFUSAL, isError: true }),
        });
      }
      if (tool.name !== "SkillManage") return tool;
      // Defense in depth: a permission mode that skips the prompt (bypass) must not let the review delete.
      return wrap(tool, {
        kind: tool.kind,
        subject: (input, cwd) => tool.subject(input, cwd),
        run: (input, ctx) =>
          isDelete(input)
            ? Promise.resolve({ content: "Skills can't be deleted during the learning review.", isError: true })
            : tool.run(input, ctx),
      });
    }
    return wrap(tool, {
      kind: "meta",
      subject: () => ({ paths: [] }),
      run: async () => ({ content: `${tool.name} isn't available during the learning review.`, isError: true }),
    });
  });
}

function wrap(tool: AnyTool, over: Pick<AnyTool, "kind" | "subject" | "run">): AnyTool {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(over.kind !== undefined ? { kind: over.kind } : {}),
    summarize: (input) => tool.summarize(input),
    subject: over.subject,
    run: over.run,
  };
}

/** A Memory call that adds or replaces, or a batch of 1-50 operations with at least one add or replace (removes may ride along). */
function consolidates(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const { action, operations } = input as { action?: unknown; operations?: unknown };
  if (Array.isArray(operations)) {
    return operations.length >= 1 && operations.length <= 50 && operations.some((op) => ["add", "replace"].includes((op as { action?: unknown } | null)?.action as string));
  }
  return action === "add" || action === "replace";
}

function isDelete(input: unknown): boolean {
  return typeof input === "object" && input !== null && (input as { action?: unknown }).action === "delete";
}

/** The review never asks the user: its writes are approved, SkillManage deletes and everything else are refused. */
export function reviewAskPermission(prompt: PermissionPrompt): PermissionAnswer {
  if (!REVIEW_WRITE_TOOLS.includes(prompt.toolName)) return { kind: "deny", message: `${prompt.toolName} needs approval, and the learning review can't ask for it.` };
  if (prompt.toolName === "SkillManage" && isDelete(prompt.input)) return { kind: "deny", message: "Skills can't be deleted during the learning review." };
  if (prompt.toolName === "Memory" && !consolidates(prompt.input)) return { kind: "deny", message: REMOVE_ONLY_REFUSAL };
  return { kind: "allow" };
}

export interface RunReviewAgentOptions {
  model: Model;
  /** The main agent's tools, ungated: they are gated here. */
  tools: AnyTool[];
  /** The main agent's system prompt, unchanged (prompt-cache parity). */
  system: string;
  config(): { model: string; effort: Effort; refusalFallback: boolean };
  permissions(): PermissionContext;
  toolContext: Omit<ToolContext, "signal">;
  history: MessageParam[];
  prompt: string;
  signal: AbortSignal;
  maxTurns?: number;
  /** The session's hooks; only the tool events fire for the review (PreToolUse guards still apply). */
  hooks?: AgentHooks;
  /** Tool implementations swapped in under the same name and schema (see reviewToolGate). */
  overrides?: Record<string, Pick<AnyTool, "subject" | "run">>;
}

const REVIEW_MAX_TURNS = 16;
const TOOL_HOOKS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

/** Runs one review to completion on a copy of the conversation. Never asks the user anything. */
export async function runReviewAgent(opts: RunReviewAgentOptions): Promise<ReviewResult> {
  // The review continues a conversation; with none there is nothing to learn from (and no context to send).
  if (opts.history.length === 0) return { changes: [], reply: "" };
  const changes: ReviewResult["changes"] = [];
  const started = new Map<string, string>();
  const agent = new Agent(
    {
      model: opts.model,
      tools: reviewToolGate(opts.tools, REVIEW_ALLOWED_TOOLS, opts.overrides),
      system: opts.system,
      config: opts.config,
      // Always "default": plan mode would refuse the review's own writes, and bypass/acceptEdits would skip
      // reviewAskPermission. Deny rules still win, and the user's ask rules count as deny: nobody is there to ask.
      permissions: () => {
        const base = opts.permissions();
        return { ...base, mode: "default", rules: { ...base.rules, deny: [...base.rules.deny, ...base.rules.ask], ask: [] } };
      },
      askPermission: async (prompt) => reviewAskPermission(prompt),
      contextText: async () => "",
      persist: async () => {},
      toolContext: { ...opts.toolContext, actor: "review" },
      maxTurns: opts.maxTurns ?? REVIEW_MAX_TURNS,
      hooks: opts.hooks && reviewHooks(opts.hooks),
      emit: (event) => {
        if (event.type === "tool_start") started.set(event.id, event.summary);
        else if (event.type === "tool_end" && event.status === "done" && REVIEW_WRITE_TOOLS.includes(event.name)) {
          changes.push({ tool: event.name, summary: `${event.name} ${started.get(event.id) ?? ""}`.trim() });
        }
      },
    },
    opts.history,
  );
  await agent.run(opts.prompt, opts.signal);
  // Only the review's own replies: the copied history has assistant text of its own.
  return { changes, costUsd: agent.totalCostUsd, reply: lastAssistantText(agent.messages.slice(opts.history.length)) };
}

/**
 * The user's hooks as the review sees them: only tool events, only for tools the review may run (a refused call
 * never reaches a hook), and a hook's "ask" becomes a deny, since nobody is there to answer.
 */
function reviewHooks(hooks: AgentHooks): AgentHooks {
  return {
    has: (event) => TOOL_HOOKS.has(event) && hooks.has(event),
    run: async (event, input, match, signal) => {
      if (match === undefined || !REVIEW_ALLOWED_TOOLS.includes(match)) return { additionalContext: [], messages: [], errors: [] };
      const out = await hooks.run(event, input, match, signal);
      return out.permission === "ask" ? { ...out, permission: "deny", permissionReason: out.permissionReason ?? "a hook asks for confirmation, and the learning review can't ask" } : out;
    },
  };
}

function lastAssistantText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (text) return text;
  }
  return "";
}
