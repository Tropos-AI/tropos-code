// src/config/constants.ts
export const DEFAULT_MODEL = "claude-opus-5-5";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Permission modes. `bypass` is only reachable through --dangerously-skip-permissions. */
export const MODES = ["default", "acceptEdits", "plan", "bypass"] as const;
export type Mode = (typeof MODES)[number];

export const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * read: no side effects · edit: writes files · exec: runs commands · meta: agent bookkeeping ·
 * net: reaches the network (asks unless a rule allows it, may run in plan mode, runs in parallel)
 */
export type ToolKind = "read" | "edit" | "exec" | "meta" | "net";
