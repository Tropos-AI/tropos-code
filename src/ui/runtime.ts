// src/ui/runtime.ts
import type { Agent } from "../agent/agent";
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from "../agent/events";
import type { DirectCall } from "../agents/mention";
import type { Effort, Mode } from "../config/constants";
import type { ProviderStatus } from "../providers/router";
import type { MessageParam, SessionSummary } from "../session/store";
import type { ExtraCommand, ListTopic } from "./commands";
import type { Theme } from "./theme";

/** One row of a panel (/skills, /mcp …): what it is, a dim hint, a status glyph, and details shown when selected. */
export interface PanelItem {
  key: string;
  label: string;
  hint?: string;
  aside?: string;
  status?: "ok" | "warn" | "error" | "off";
  /** False when the row is a change that can't be reverted; its last detail line says why. Unset means "as usual". */
  undoable?: boolean;
  /** Lines shown under the list for the selected row. */
  detail?: string[];
}

export interface PanelSection {
  title?: string;
  items: PanelItem[];
}

/** What a list panel shows; App renders it as a Pane with a SelectList. */
export interface PanelData {
  title: string;
  subtitle?: string;
  sections: PanelSection[];
  /** Shown when there are no items, e.g. how to add one. */
  empty?: string;
}

/** Recently used and favorite models for the /model picker (persisted in ~/.tropos/models.json). */
export interface ModelPrefsControl {
  get(): Promise<{ recent: string[]; favorites: string[] }>;
  recordUse(model: string): Promise<void>;
  /** Returns whether the model is now a favorite. */
  toggleFavorite(model: string): Promise<boolean>;
}

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
  /** Open the session picker on start (`tcode -r` without an id). */
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
  /** The current session's id (changes on /clear and resume). */
  sessionId(): string;
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
  /** Structured data for /skills, /agents, /hooks, /mcp, /plugins and /memory panels. */
  panel(what: ListTopic): Promise<PanelData>;
  readonly modelPrefs: ModelPrefsControl;
  undo(): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }>;
  /** Reverts the latest learned change that is not undone yet (or the one with `id`). */
  undoLearned(id?: string): Promise<{ ok: true; summary: string } | { ok: false; reason: string }>;
  /** The agent's name and emoji from ~/.tropos/workspace/IDENTITY.md, for headers (re-read when the Identity tool saves). */
  identity(): { name?: string; emoji?: string };
  redo(): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }>;
  /** Replaces pasted keys and tokens with placeholders the session's vault holds; the text unchanged when there is no vault. */
  sealSecrets(text: string): string;
  /** The call behind an `@<specialist> message`; null for a guest session or any other text. */
  directCall?(text: string): DirectCall | null;
  /** Fires SessionStart (startup/resume) once the UI is up; notices go through `notice`. */
  start(notice: (level: "info" | "warn", text: string) => void): Promise<void>;
  /** True when shutdown will wait for the learning review: a final one is due, or one is running. */
  finalReviewDue(): boolean;
  /** Ctrl+c during shutdown: aborts the final review; SessionEnd and closing the servers still run. */
  skipFinalReview(): void;
  /**
   * The final learning review (unless `finalReview` is false; it waits at most 30 s), SessionEnd, then closes
   * MCP servers and language servers.
   */
  shutdown(opts?: { finalReview?: boolean }): Promise<void>;
}
