// src/tools/types.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { ToolKind } from "../config/constants";
import type { JobTable } from "./bash/jobs";
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
  /** Background jobs started with Bash run_in_background. */
  jobs: JobTable;
  shell: string;
  signal: AbortSignal;
  /** Canonical paths the permission engine approved for this call (set by the agent). */
  approvedPaths?: string[];
  /** True for paths a deny rule covers; search tools drop them (set by the agent). */
  isDenied?: (absPath: string) => boolean;
  /** The tool_use id of this call (set by the agent); subagents use it to tag their progress. */
  toolUseId?: string;
  /** Shows a one-line progress update on this call's transcript row (set by the agent). */
  progress?: (text: string) => void;
  /** Who is acting: the agent the user talks to (default) or the background learning review. Recorded in the learning ledger. */
  actor?: Actor;
}

/** Who changed a learned file: the user's agent, the background review, or the user through a command. */
export type Actor = "agent" | "review" | "user";

export interface PermissionSubject {
  command?: string;
  paths: string[];
  /** What a rule pattern is matched against for tools that act on neither paths nor commands, e.g. "domain:example.com" or a skill name. */
  target?: string;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  /** What the tool may do. A tool that doesn't say (a future MCP tool, say) is treated as "exec": see toolKind. */
  readonly kind?: ToolKind;
  readonly description: string;
  readonly schema: S;
  /** Raw JSON Schema sent to the model instead of the zod schema's; for tools defined elsewhere (MCP). */
  readonly inputSchema?: Anthropic.Beta.BetaTool.InputSchema;
  /** Short label for transcript rows and permission prompts. */
  summarize(input: z.infer<S>): string;
  /** What the permission engine checks. Paths must come from resolveToolPath. */
  subject(input: z.infer<S>, cwd: string): PermissionSubject;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

export type AnyTool = Tool<z.ZodType>;

/** A tool's kind for scheduling and permissions; one that declares none gets the strictest handling. */
export function toolKind(tool: Pick<AnyTool, "kind">): ToolKind {
  return tool.kind ?? "exec";
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
