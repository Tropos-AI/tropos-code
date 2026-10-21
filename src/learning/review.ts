// src/learning/review.ts
// The learning loop (Hermes): after enough user turns or tool calls, a background agent re-reads a copy of
// the conversation and saves what is worth keeping to memory and skills; near the context limit, a flush
// review writes the session's durable state to the daily note before compaction loses it; and when the session
// ends with unreviewed work, a final review does both.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { HUB_ONLY_TOOLS } from "../agent/subagent";
import { loadSpecialists } from "../agents/specialists";
import { BUILTIN_AGENTS } from "../extensions/agents";
import { agentsDir } from "../paths";
import { Agent, type AgentHooks } from "../agent/agent";
import type { PermissionAnswer, PermissionPrompt, TurnEndReason } from "../agent/events";
import { COMPACTION_TRIGGER_TOKENS, type Model } from "../api/model";
import { contextWindow } from "../api/pricing";
import type { Effort } from "../config/constants";
import type { PermissionContext } from "../permissions/engine";
import type { MessageParam } from "../session/store";
import type { AnyTool, ToolContext } from "../tools/types";
import type { LearningCounters } from "./counters";
import { MESSAGES_TOOLS } from "../messages/runtime";
import { redactPrivateResults } from "./redact";
import {
  COMBINED_REVIEW_PROMPT,
  FINAL_PROMPT,
  FLUSH_PROMPT,
  MEMORY_REVIEW_PROMPT,
  REVIEW_ALLOWED_TOOLS,
  REVIEW_WRITE_TOOLS,
  SKILL_REVIEW_PROMPT,
} from "./review-prompts";

export type ReviewKind = "memory" | "skill" | "combined" | "flush" | "final";

export const REVIEW_PROMPTS: Record<ReviewKind, string> = {
  memory: MEMORY_REVIEW_PROMPT,
  skill: SKILL_REVIEW_PROMPT,
  combined: COMBINED_REVIEW_PROMPT,
  flush: FLUSH_PROMPT,
  final: FINAL_PROMPT,
};

/** How long the end of a session waits for the final review before aborting it. */
export const FINAL_REVIEW_TIMEOUT_MS = 30_000;
/** The final review runs for at least this many user turns, or tool calls, the reviews haven't seen. */
const FINAL_MIN_TURNS = 2;
const FINAL_MIN_TOOLS = 5;

/** Context window assumed for models without a known one (other providers), so they get a flush too. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** The window the flush is timed against: compaction comes long before a 1M window fills. */
export function flushWindow(model: string): number {
  return Math.min(contextWindow(model) ?? DEFAULT_CONTEXT_WINDOW, COMPACTION_TRIGGER_TOKENS);
}

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
  /** Counters carried over from earlier sessions in this project. */
  initial?: LearningCounters;
  /** Called with a copy of the counters after every change, so they outlive the session. */
  saveCounters?(c: LearningCounters): void;
}

export interface LastReview {
  kind: ReviewKind;
  startedAt: number;
  changes: number;
  /** Set when the review threw; the loop never surfaces it beyond this. */
  failed?: boolean;
  aborted?: boolean;
  /** Set when it never ran because the conversation read or sent texts (its counters were consumed all the same). */
  skipped?: boolean;
}

/** True when the history holds a call to one of the Messages tools. */
function usesTexts(history: readonly MessageParam[]): boolean {
  return history.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && MESSAGES_TOOLS.has(b.name)));
}

const NOTICE_PREFIX = "💡 Learned: ";
const NOTICE_MAX = 160;

/** The one-line notice for a review that changed something, clipped to NOTICE_MAX characters. */
export function learnedNotice(changes: ReviewResult["changes"]): string {
  const created = changes.flatMap((c) => (c.tool === "AgentManage" ? [/^AgentManage create (.+)$/.exec(c.summary)?.[1]] : [])).filter((n): n is string => n !== undefined);
  const rest = changes.filter((c) => !(c.tool === "AgentManage" && /^AgentManage create /.test(c.summary)));
  const parts = [...created.map((n) => `🧩 New specialist: ${n}`), ...(rest.length > 0 ? [NOTICE_PREFIX + rest.map((c) => c.summary).join("; ")] : [])];
  const text = parts.join(" · ");
  return text.length > NOTICE_MAX ? `${text.slice(0, NOTICE_MAX - 1)}…` : text;
}

/** The notice for a specialist's own review: `💡 <label> learned: …`, clipped like learnedNotice. */
export function specialistLearnedNotice(label: string, changes: ReviewResult["changes"]): string {
  const text = `💡 ${label} learned: ${changes.map((c) => c.summary).join("; ")}`;
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
  /** The history the last ended turn left, for the final review. */
  private lastHistory: MessageParam[] = [];
  private finishing: Promise<void> | undefined;
  private finishCancelled = false;
  /** Resolves a running finish() early: the session's end no longer waits for the review. */
  private skipFinish: (() => void) | undefined;
  /**
   * Set once this session called a Messages tool. From then on no review runs: the agent's own replies may quote
   * the texts, and a compacted summary may carry them on after the calls themselves are gone from the history.
   */
  private sawTexts = false;

  constructor(private readonly deps: LearningLoopDeps) {
    this.turnsSinceMemory = deps.initial?.turnsSinceMemory ?? 0;
    this.toolsSinceSkill = deps.initial?.toolsSinceSkill ?? 0;
  }

  get running(): boolean {
    return this.current !== undefined;
  }

  get counters(): LearningCounters {
    return { turnsSinceMemory: this.turnsSinceMemory, toolsSinceSkill: this.toolsSinceSkill };
  }

  /** A turn ended in this loop and enough of the session is unreviewed to be worth a last review. */
  get finalDue(): boolean {
    if (this.lastHistory.length === 0 || !this.deps.settings().review) return false;
    return this.turnsSinceMemory >= FINAL_MIN_TURNS || this.toolsSinceSkill >= FINAL_MIN_TOOLS;
  }

  /** What the most recent review was, for status displays. */
  get last(): LastReview | undefined {
    return this.lastReview;
  }

  /** The main agent's tool calls. Its own successful saves postpone the matching review. */
  onToolEnd(toolName: string, status: "done" | "error" | "denied"): void {
    if (MESSAGES_TOOLS.has(toolName)) this.sawTexts = true;
    this.toolsSinceSkill++;
    if (status === "done") {
      if (toolName === "Memory") this.turnsSinceMemory = 0;
      if (toolName === "SkillManage") this.toolsSinceSkill = 0;
    }
    this.saveCounters();
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
    if (history.length > 0) this.lastHistory = history;
    try {
      this.maybeStart(reason, history);
    } finally {
      this.saveCounters();
    }
  }

  private maybeStart(reason: TurnEndReason, history: MessageParam[]): void {
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

  /**
   * Aborts the running review; called when a new user turn starts so the review never competes with it, and
   * at a shutdown that skips the final review (ctrl+c): a pending final review never starts, and finish()
   * resolves at once, even when the review is slow to notice the abort.
   */
  cancel(): void {
    if (this.finishing) {
      this.finishCancelled = true;
      this.skipFinish?.();
    }
    this.controller?.abort();
  }

  /** Resolves once no review is running (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.current) await this.current;
  }

  /**
   * The end of the session: waits for a running review, then runs one final review on the last history when
   * `finalDue`. After `timeoutMs` it aborts what is running (saves made so far are kept and announced) and
   * resolves. Never rejects; a second call gets the same promise.
   */
  finish(timeoutMs: number): Promise<void> {
    this.finishing ??= this.runFinish(timeoutMs);
    return this.finishing;
  }

  private async runFinish(timeoutMs: number): Promise<void> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.controller?.abort();
        resolve();
      }, timeoutMs);
    });
    const skipped = new Promise<void>((resolve) => (this.skipFinish = resolve));
    const work = async () => {
      // Only awaits when a review runs, so an idle loop starts the final review in this same tick.
      if (this.current) await this.whenIdle();
      if (timedOut || this.finishCancelled || !this.finalDue) return;
      this.start("final", [...this.lastHistory], { turnsSinceMemory: 0, toolsSinceSkill: 0, flushArmed: false });
      await this.whenIdle();
    };
    try {
      // A review that ignores the abort must not hold the session's end: the deadline resolves regardless.
      await Promise.race([work(), deadline, skipped]);
    } catch {
      // Never rejects: the session ends either way.
    } finally {
      clearTimeout(timer);
    }
  }

  private saveCounters(): void {
    try {
      this.deps.saveCounters?.(this.counters);
    } catch {
      // Losing a counter only delays a review.
    }
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
    this.saveCounters();
  }

  private start(kind: ReviewKind, history: MessageParam[], before: { turnsSinceMemory: number; toolsSinceSkill: number; flushArmed: boolean }): void {
    const controller = new AbortController();
    const record: LastReview = { kind, startedAt: (this.deps.now ?? Date.now)(), changes: 0 };
    // Turns that read or sent texts are not learned from: skipped as if reviewed, so the next window starts afresh.
    if (this.sawTexts || usesTexts(history)) {
      this.sawTexts = true;
      this.lastReview = { ...record, skipped: true };
      if (kind === "final") {
        this.turnsSinceMemory = 0;
        this.toolsSinceSkill = 0;
        this.saveCounters();
      }
      return;
    }
    this.controller = controller;
    this.lastReview = record;
    const run = async () => {
      try {
        // Inside the async body, so even a synchronous throw from runReview lands in the catch below.
        // Defence in depth (a history with texts never gets here): Messages results are withheld from the review.
        const result = await this.deps.runReview(kind, REVIEW_PROMPTS[kind], redactPrivateResults(history), controller.signal);
        if (controller.signal.aborted) record.aborted = true;
        record.changes = result.changes.length;
        // The final review consumes the counters only once it has really finished: until then, an exit
        // (ctrl+c, the timeout) leaves the work counted for the next session.
        if (kind === "final" && !record.aborted) {
          this.turnsSinceMemory = 0;
          this.toolsSinceSkill = 0;
          this.saveCounters();
        }
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

const SPECIALIST_ACTIONS_REFUSAL = "Specialists can only be created or updated during the learning review.";
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
  /** What the unattended AgentManage is checked against; without `home` it refuses everything. */
  specialists: { home?: string } = {},
): AnyTool[] {
  const chiefTools = tools.map((t) => t.name);
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
      if (tool.name === "AgentManage") {
        // Defense in depth: archiving or deleting a specialist is the owner's decision.
        return wrap(tool, {
          kind: tool.kind,
          subject: (input, cwd) => tool.subject(input, cwd),
          run: async (input, ctx) => {
            if (!mayManageSpecialist(input)) return { content: SPECIALIST_ACTIONS_REFUSAL, isError: true };
            const problem = await unattendedSpecialistProblem(input, specialists.home, chiefTools);
            return problem ? { content: `Not done: ${problem}`, isError: true } : tool.run(input, ctx);
          },
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

/**
 * A Memory call that adds or replaces, or a batch of 1-50 operations with at least one add or replace, where removes
 * may ride along but at most one more than the adds and replaces: merging two notes into one, not clearing memory.
 */
function consolidates(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const { action, operations } = input as { action?: unknown; operations?: unknown };
  if (Array.isArray(operations)) {
    const actions = operations.map((op) => (op as { action?: unknown } | null)?.action);
    const writes = actions.filter((a) => a === "add" || a === "replace").length;
    const removes = actions.filter((a) => a === "remove").length;
    return operations.length >= 1 && operations.length <= 50 && writes >= 1 && removes <= writes + 1;
  }
  return action === "add" || action === "replace";
}

interface ManageInput {
  action?: string;
  name?: string;
  description?: string;
  prompt?: string;
  tools?: string[];
  model?: string;
  emoji?: string;
  autonomy?: string;
}

/**
 * What the unattended review may do with specialists: create a NEW one with a narrow, explicit tool list and no
 * autonomy of its own, or reword the description and role contract of one it (or the chief) made. Widening tools,
 * raising autonomy, changing the model, or touching a user-made specialist or a plain agent needs the owner.
 * Returns the reason it refuses, or undefined.
 */
async function unattendedSpecialistProblem(input: unknown, home: string | undefined, chiefTools: string[]): Promise<string | undefined> {
  const i = (typeof input === "object" && input !== null ? input : {}) as ManageInput;
  if (!home || typeof i.name !== "string") return "the review can't check this specialist.";
  const known = (await loadSpecialists(home).catch(() => [])).find((s) => s.id === i.name);
  // The same file AgentManage would write: a plain agent of this name (even a dangling link) is the owner's, whatever else exists.
  const plain = await lstat(join(agentsDir(home), `${i.name}.md`)).then(() => true, () => false);
  if (plain) return `a plain agent named ${i.name} exists; only the owner changes it.`;
  const taken = known !== undefined || BUILTIN_AGENTS.some((b) => b.name === i.name);
  if (i.action === "create") {
    if (taken) return `an agent named ${i.name} already exists; update it instead, or pick another name.`;
    const allowed = chiefTools.filter((t) => !HUB_ONLY_TOOLS.has(t));
    if (!i.tools || i.tools.length === 0) return "a specialist created by the review must list its tools (the fewest that do the job).";
    const bad = i.tools.find((t) => !allowed.includes(t));
    if (bad) return `${bad} isn't a tool a specialist may have.`;
    if (i.autonomy !== undefined && i.autonomy !== "ask") return "a specialist created by the review can't set its own autonomy; the owner can raise it.";
    return undefined;
  }
  if (!known || known.archived) return `no active specialist named ${i.name}; plain agents and the owner's own agents are changed only by the owner.`;
  if (known.createdBy === "user") return `${i.name} was made by the owner; only the owner changes it.`;
  if (i.tools !== undefined || i.model !== undefined || i.autonomy !== undefined || i.emoji !== undefined) {
    return "the review may only reword a specialist's description and role contract; tools, model, autonomy and emoji are the owner's to change.";
  }
  return undefined;
}

function mayManageSpecialist(input: unknown): boolean {
  const action = typeof input === "object" && input !== null ? (input as { action?: unknown }).action : undefined;
  return action === "create" || action === "update";
}

function isDelete(input: unknown): boolean {
  return typeof input === "object" && input !== null && (input as { action?: unknown }).action === "delete";
}

/** The review never asks the user: its writes are approved, SkillManage deletes and everything else are refused. */
export function reviewAskPermission(prompt: PermissionPrompt): PermissionAnswer {
  if (!REVIEW_WRITE_TOOLS.includes(prompt.toolName)) return { kind: "deny", message: `${prompt.toolName} needs approval, and the learning review can't ask for it.` };
  if (prompt.toolName === "SkillManage" && isDelete(prompt.input)) return { kind: "deny", message: "Skills can't be deleted during the learning review." };
  if (prompt.toolName === "AgentManage" && !mayManageSpecialist(prompt.input)) return { kind: "deny", message: SPECIALIST_ACTIONS_REFUSAL };
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
  /** The tools the review may run; default REVIEW_ALLOWED_TOOLS. */
  allowed?: readonly string[];
  /** The Tropos home, to check specialist changes against; without it the review changes none. */
  home?: string;
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
      tools: reviewToolGate(opts.tools, opts.allowed ?? REVIEW_ALLOWED_TOOLS, opts.overrides, { home: opts.home }),
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
      hooks: opts.hooks && reviewHooks(opts.hooks, opts.allowed ?? REVIEW_ALLOWED_TOOLS),
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
function reviewHooks(hooks: AgentHooks, allowed: readonly string[]): AgentHooks {
  return {
    has: (event) => TOOL_HOOKS.has(event) && hooks.has(event),
    run: async (event, input, match, signal) => {
      if (match === undefined || !allowed.includes(match)) return { additionalContext: [], messages: [], errors: [] };
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
