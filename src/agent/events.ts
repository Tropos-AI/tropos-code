// src/agent/events.ts
import type { Message } from "../api/model";
import type { ToolKind } from "../config/constants";
import type { ToolOutput } from "../tools/types";

/**
 * max_tokens: the final reply was cut off at the output limit. context_exceeded: the conversation no longer fits.
 * blocked: a hook refused the prompt or stopped the turn.
 */
export type TurnEndReason = "end_turn" | "refusal" | "max_turns" | "max_tokens" | "context_exceeded" | "aborted" | "error" | "blocked";
export type ToolStatus = "done" | "error" | "denied";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "assistant"; message: Message }
  | { type: "tool_start"; id: string; name: string; summary: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; output: ToolOutput; status: ToolStatus }
  /** A running tool's latest progress line, e.g. what a subagent is doing. */
  | { type: "tool_progress"; id: string; text: string }
  /** learned: the line reports something saved to the agent's own stores (a save or a review), which Telegram holds back and forwards. */
  | { type: "notice"; level: "info" | "warn" | "error"; text: string; learned?: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; contextTokens: number; costUsd?: number; totalCostUsd?: number }
  | { type: "turn_end"; reason: TurnEndReason };

export interface PermissionPrompt {
  toolName: string;
  kind: ToolKind;
  summary: string;
  input: unknown;
  reason?: string;
  suggestion?: string;
  /**
   * The target the permission check matched (a send's recipient, a WebFetch domain), from the tool's subject; set
   * when the tool has one. Whoever answers for nobody (a scheduled run) matches its rules against this, never the input.
   */
  target?: string;
  /** The full change, from the tool, when the summary can't show it (see Tool.preview). */
  preview?: { header: string; text: string };
}

export type PermissionAnswer =
  | { kind: "allow" }
  | { kind: "allow_always"; rule: string }
  | { kind: "deny"; feedback?: string; message?: string };
