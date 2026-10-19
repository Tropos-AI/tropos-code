// src/web/protocol.ts — messages between the dashboard server and the browser app. No Node imports: the client imports this too.
import type { AgentEvent, PermissionAnswer, PermissionPrompt, TurnEndReason } from "../agent/events";
import type { ActivityEvent, ActivitySnapshot } from "../agents/activity";
import type { Attachment, PromptAttachment } from "../attachments/attachments";
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
  /** The agent's own name and emoji (~/.tropos/workspace/IDENTITY.md); empty until it has one. */
  identity?: { name?: string; emoji?: string };
  /** The project this tab's chat works in; only the background service's dashboard serves more than one. */
  project?: { id: string; name: string };
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
  /** The agent's name and emoji, current as of this state: it changes when the Identity tool saves. */
  identity?: { name?: string; emoji?: string };
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
  /** An endpoint the owner added in settings.json (not built in), with where it is and which API it speaks. */
  custom?: { baseURL: string; api: "chat" | "responses" | "anthropic" };
}

/** Every RPC: its params and its result. */
export interface RpcMap {
  /**
   * One turn. With `command`, the server first expands that custom command or skill (its `` !`cmd` ``
   * may ask permission) and runs the result, all in one busy period so no other tab's prompt slips in
   * between; `text` is then ignored. An expansion that fails or is cancelled rejects with its reason.
   */
  /** `attachments`: images and text files sent with the text (src/attachments); the text may then be empty. */
  prompt: { params: { text: string; display?: string; model?: string; command?: { name: string; args: string }; attachments?: PromptAttachment[] }; result: TurnEndReason };
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
  /** Reverts a learned change (the latest one when no id is given). */
  "learned.undo": { params: string | undefined; result: { summary: string } };
  "providers.status": { params: undefined; result: ProviderInfoView[] };
  "providers.connect": { params: { id: string; key: string }; result: null };
  "providers.disconnect": { params: string; result: boolean };
  "providers.models": { params: string; result: string[] };
  "modelPrefs.get": { params: undefined; result: { recent: string[]; favorites: string[] } };
  "modelPrefs.recordUse": { params: string; result: null };
  "modelPrefs.toggleFavorite": { params: string; result: boolean };
  completeFile: { params: { token: string }; result: string[] };
  /** Moves this tab's chat to another project (its own session there); the result is that session's hello. */
  "project.select": { params: string; result: HelloInfo };
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
  "learned.undo",
  "providers.status",
  "providers.connect",
  "providers.disconnect",
  "providers.models",
  "modelPrefs.get",
  "modelPrefs.recordUse",
  "modelPrefs.toggleFavorite",
  "completeFile",
  "project.select",
];

export type ClientMessage =
  /** The first message of a browser that has a device key; nothing else is answered before it succeeds. */
  | { t: "auth"; key: string }
  /** A browser without a key logs in with a one-time key (`#login=`) or a 6-digit code; `name` labels the device. */
  | { t: "login"; value: string; name: string }
  | { t: "rpc"; id: number; method: RpcMethod; params?: unknown }
  /** Host-level admin call (src/web/admin/api.ts): no session needed. */
  | { t: "admin"; id: number; method: string; params?: unknown }
  | { t: "permission"; id: number; answer: PermissionAnswer };

export type ServerMessage =
  | { t: "auth_ok"; device: { id: string; name: string } }
  /** The key is unknown or was revoked; the socket stays open so the browser can log in. */
  | { t: "auth_failed" }
  /** The new device's key, sent this once: the browser keeps it. */
  | { t: "login_ok"; key: string; device: { id: string; name: string } }
  | { t: "login_failed"; reason: "invalid" | "locked" }
  | { t: "hello"; server: HelloInfo }
  /** A prompt another tab sent, shown as the user's message (the sending tab already shows it; the agent stream has none). */
  | { t: "user"; text: string; attachments?: Attachment[] }
  | { t: "event"; event: AgentEvent }
  | { t: "state"; state: SessionState }
  | { t: "ask"; id: number; prompt: PermissionPrompt }
  | { t: "ask_closed"; id: number }
  /** What every agent in the process is doing (the chief in each chat, its specialists): on login, then each change. */
  | { t: "agents"; activity: ActivitySnapshot }
  | { t: "agent"; event: ActivityEvent }
  | { t: "rpc_result"; id: number; ok: true; result: unknown }
  | { t: "rpc_result"; id: number; ok: false; error: string }
  | { t: "admin_result"; id: number; ok: true; result: unknown }
  | { t: "admin_result"; id: number; ok: false; error: string };

/** The path the WebSocket lives on. */
export const WS_PATH = "/ws";
/** The close code of a socket whose device was logged out: the browser forgets its key and shows the login screen. */
export const AUTH_CLOSE_CODE = 4401;
/** The close code of a socket that didn't log in in time: the browser reconnects silently, the login screen stays as it is. */
export const LOGIN_TIMEOUT_CLOSE_CODE = 4408;
/** The localStorage entry that holds this browser's device key. */
export const DEVICE_KEY_STORAGE = "tropos.deviceKey";
export const DEFAULT_PORT = 4317;
