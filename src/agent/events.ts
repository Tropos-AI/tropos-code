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
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; contextTokens: number; costUsd?: number; totalCostUsd?: number }
  | { type: "turn_end"; reason: TurnEndReason };

export interface PermissionPrompt {
  toolName: string;
  kind: ToolKind;
  summary: string;
  input: unknown;
  reason?: string;
  suggestion?: string;
}

export type PermissionAnswer =
  | { kind: "allow" }
  | { kind: "allow_always"; rule: string }
  | { kind: "deny"; feedback?: string; message?: string };
