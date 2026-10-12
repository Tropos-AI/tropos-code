// src/tools/types.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { ToolKind } from "../config/constants";
import type { ReadState } from "./read-state";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface TodoStore {
  get(): Todo[];
  set(todos: Todo[]): void;
}

export type ToolResultContent = NonNullable<Anthropic.Beta.BetaToolResultBlockParam["content"]>;

export interface DiffDisplay {
  kind: "diff";
  path: string;
  patch: string;
  added: number;
  removed: number;
}

export type ToolDisplay = DiffDisplay | { kind: "todos"; todos: Todo[] } | { kind: "text"; text: string };

export interface ToolOutput {
  content: ToolResultContent;
  isError?: boolean;
  /** Rich rendering for the transcript (diffs, todo lists). */
  display?: ToolDisplay;
  /** One-line result summary for the transcript, e.g. "84 lines". */
  summary?: string;
}

export interface ToolContext {
  cwd(): string;
  setCwd(dir: string): void;
  allowedDirs: string[];
  readState: ReadState;
  todos: TodoStore;
  shell: string;
  signal: AbortSignal;
  /** Canonical paths the permission engine approved for this call (set by the agent). */
  approvedPaths?: string[];
}

export interface PermissionSubject {
  command?: string;
  paths: string[];
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly kind: ToolKind;
  readonly description: string;
  readonly schema: S;
  /** Short label for transcript rows and permission prompts. */
  summarize(input: z.infer<S>): string;
  /** What the permission engine checks. Paths must come from resolveToolPath. */
  subject(input: z.infer<S>, cwd: string): PermissionSubject;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

export type AnyTool = Tool<z.ZodType>;

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
