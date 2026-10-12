// src/ui/runtime.ts
import type { Agent } from "../agent/agent";
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from "../agent/events";
import type { Effort, Mode } from "../config/constants";
import type { MessageParam, SessionSummary } from "../session/store";
import type { Theme } from "./theme";

export interface AgentUi {
  emit(event: AgentEvent): void;
  askPermission(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer>;
}

/** Everything the interactive UI needs from the outside world. */
export interface Runtime {
  readonly version: string;
  readonly cwd: string;
  readonly theme: Theme;
  /** Shift+Tab cycle order; includes "bypass" only when started with --dangerously-skip-permissions. */
  readonly modes: Mode[];
  readonly initialPrompt?: string;
  /** Open the session picker on start (`tropos -r` without an id). */
  readonly startWithPicker?: boolean;
  state(): { model: string; effort: Effort; mode: Mode };
  setMode(mode: Mode): void;
  setModel(model: string): void;
  setEffort(effort: Effort): void;
  /** An agent for the current session, seeded with its history. */
  newAgent(ui: AgentUi): Agent;
  /** The current session's saved history. */
  history(): MessageParam[];
  /** Starts a new, empty session. */
  clear(): Promise<void>;
  sessions(): Promise<SessionSummary[]>;
  /** Makes a saved session current. */
  resume(id: string): Promise<void>;
  inputHistory(): string[];
  recordInput(text: string): void;
}
