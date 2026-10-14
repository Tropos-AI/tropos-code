// src/web/protocol.ts — messages between `tcode web` and the browser app. No Node imports: the client imports this too.
import type { AgentEvent, PermissionAnswer, PermissionPrompt, TurnEndReason } from "../agent/events";
import type { Effort, Mode } from "../config/constants";
import type { MessageParam } from "../session/store";
import type { ExtraCommand, ListTopic } from "../ui/commands";
import type { CommandExpansion, PanelData } from "../ui/runtime";

export interface HelloInfo {
  version: string;
  cwd: string;
  sessionId: string;
  /** Permission modes the user may cycle through; "bypass" only when the server was started with it. */
  modes: Mode[];
  /** Custom commands and user-invocable skills. */
  commands: ExtraCommand[];
  /** The session's saved history, for historyToTranscript. */
  history: MessageParam[];
}

export interface SessionState {
  model: string;
  effort: Effort;
  mode: Mode;
  busy: boolean;
  contextTokens: number;
  /** Undefined when the model's window is unknown. */
  contextWindow?: number;
  /** Undefined once a model without a known price answered. */
  totalCostUsd?: number;
  turns: number;
  /** When the running turn started (ms since epoch), for "Worked for 12s" in a tab that joins mid-turn. */
  turnStartedAt?: number;
}

/** A saved session as the session list shows it; dates travel as ISO strings. */
export interface SessionSummaryView {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** The error text of an RPC refused because a turn is running; the client queues the prompt instead. */
export const BUSY_ERROR = "busy";

export type UndoResult = { ok: true; files: string[] } | { ok: false; reason: string };

/** Provider status as /providers shows it, without anything secret. */
export interface ProviderInfoView {
  id: string;
  name: string;
  keyRequired: boolean;
  keyURL: string | null;
  keyEnv: string[];
  noKeyNote?: string;
  /** How the key is set, never the key itself. */
  key: { kind: "env"; name: string } | { kind: "saved" } | null;
}

/** Every RPC: its params and its result. */
export interface RpcMap {
  /**
   * One turn. With `command`, the server first expands that custom command or skill (its `` !`cmd` ``
   * may ask permission) and runs the result, all in one busy period so no other tab's prompt slips in
   * between; `text` is then ignored. An expansion that fails or is cancelled rejects with its reason.
   */
  prompt: { params: { text: string; display?: string; model?: string; command?: { name: string; args: string } }; result: TurnEndReason };
  expand: { params: { name: string; args: string }; result: CommandExpansion };
  interrupt: { params: undefined; result: null };
  setMode: { params: Mode; result: null };
  setModel: { params: string; result: null };
  setEffort: { params: Effort; result: null };
  panel: { params: ListTopic; result: PanelData };
  sessions: { params: undefined; result: SessionSummaryView[] };
  resume: { params: string; result: HelloInfo };
  clear: { params: undefined; result: HelloInfo };
  undo: { params: undefined; result: UndoResult };
  redo: { params: undefined; result: UndoResult };
  "providers.status": { params: undefined; result: ProviderInfoView[] };
  "providers.connect": { params: { id: string; key: string }; result: null };
  "providers.disconnect": { params: string; result: boolean };
  "providers.models": { params: string; result: string[] };
  "modelPrefs.get": { params: undefined; result: { recent: string[]; favorites: string[] } };
  "modelPrefs.recordUse": { params: string; result: null };
  "modelPrefs.toggleFavorite": { params: string; result: boolean };
  completeFile: { params: { token: string }; result: string[] };
}

export type RpcMethod = keyof RpcMap;
export const RPC_METHODS: RpcMethod[] = [
  "prompt",
  "expand",
  "interrupt",
  "setMode",
  "setModel",
  "setEffort",
  "panel",
  "sessions",
  "resume",
  "clear",
  "undo",
  "redo",
  "providers.status",
  "providers.connect",
  "providers.disconnect",
  "providers.models",
  "modelPrefs.get",
  "modelPrefs.recordUse",
  "modelPrefs.toggleFavorite",
  "completeFile",
];

export type ClientMessage =
  | { t: "rpc"; id: number; method: RpcMethod; params?: unknown }
  | { t: "permission"; id: number; answer: PermissionAnswer };

export type ServerMessage =
  | { t: "hello"; server: HelloInfo }
  /** A prompt another tab sent, shown as the user's message (the sending tab already shows it; the agent stream has none). */
  | { t: "user"; text: string }
  | { t: "event"; event: AgentEvent }
  | { t: "state"; state: SessionState }
  | { t: "ask"; id: number; prompt: PermissionPrompt }
  | { t: "ask_closed"; id: number }
  | { t: "rpc_result"; id: number; ok: true; result: unknown }
  | { t: "rpc_result"; id: number; ok: false; error: string };

/** The path the WebSocket lives on. */
export const WS_PATH = "/ws";
/** The cookie that carries the launch token after the first visit. */
export const SESSION_COOKIE = "tcode_session";
export const DEFAULT_PORT = 4317;
