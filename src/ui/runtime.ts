// src/ui/runtime.ts
import type { Agent } from "../agent/agent";
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from "../agent/events";
import type { Effort, Mode } from "../config/constants";
import type { ProviderStatus } from "../providers/router";
import type { MessageParam, SessionSummary } from "../session/store";
import type { ExtraCommand, ListTopic } from "./commands";
import type { Theme } from "./theme";

/** A slash command expanded for the model; `model` applies to that one turn. */
export type CommandExpansion = { ok: true; prompt: string; model?: string } | { ok: false; reason: string };

export interface AgentUi {
  emit(event: AgentEvent): void;
  askPermission(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer>;
}

/** What /providers needs: who is connected, saving and removing keys, and listing models. */
export interface ProviderControl {
  status(): Promise<ProviderStatus[]>;
  connect(id: string, apiKey: string): Promise<void>;
  disconnect(id: string): Promise<boolean>;
  models(id: string, signal: AbortSignal): Promise<string[]>;
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
  readonly providers: ProviderControl;
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
  /** Custom commands and user-invocable skills, for /help, completion and dispatch. */
  readonly extraCommands: ExtraCommand[];
  /** Expands a custom command or skill; `` !`cmd` `` may ask permission through `ui`. */
  expandCommand(name: string, args: string, ui: Pick<AgentUi, "askPermission">, signal: AbortSignal): Promise<CommandExpansion>;
  /** Model for the next turn only (a command's `model`), or undefined to clear it. */
  setTurnModel(model: string | undefined): void;
  describe(what: ListTopic): Promise<string>;
  undo(): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }>;
  redo(): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }>;
  /** Fires SessionStart (startup/resume) once the UI is up; notices go through `notice`. */
  start(notice: (level: "info" | "warn", text: string) => void): Promise<void>;
  /** SessionEnd, then closes MCP servers and language servers. */
  shutdown(): Promise<void>;
}
