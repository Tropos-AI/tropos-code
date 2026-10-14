// web/src/lib/app-state.ts — the web app's state and its pure reducer. No React, no sockets: every input (server
// messages, connection changes, local prompts, the clock) arrives as an action, so it is all unit-testable.
import type { PermissionPrompt } from "@core/agent/events";
import { addTurnDone, addUser, emptyTranscript, flush, historyToTranscript, reduce, type Transcript } from "@core/ui/transcript";
import type { HelloInfo, ServerMessage, SessionState } from "@core/web/protocol";

import type { ConnectionStatus } from "@/lib/client";

export interface ConnectionState {
  status: ConnectionStatus;
  /** Reconnect attempts since the socket was last open (0 while open). */
  attempt: number;
  /** True once any connection succeeded: tells "starting up" apart from "lost the server". */
  everOpened: boolean;
}

export interface PendingAsk {
  id: number;
  prompt: PermissionPrompt;
}

export type ToastTone = "info" | "ok" | "warn" | "error";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

/** A message typed while a turn ran; it runs when the agent is free (like the terminal's queue). */
export interface QueuedMessage {
  id: number;
  text: string;
}

export interface AppState {
  connection: ConnectionState;
  hello: HelloInfo | null;
  /** Increments on every hello (connect, clear, resume): views reset scroll, refetch the session list. */
  helloSeq: number;
  session: SessionState | null;
  transcript: Transcript;
  /** The running turn, for the "Worked for 12s" footer. */
  turn: { startedAt: number } | null;
  /** Permission prompts waiting for an answer, oldest first. */
  asks: PendingAsk[];
  toasts: Toast[];
  toastSeq: number;
  /** This tab has a prompt or command expansion in flight (set before the server's busy state arrives). */
  sending: boolean;
  /** Messages waiting for the running turn to finish, oldest first. */
  queue: QueuedMessage[];
  queueSeq: number;
  /** Set when the user interrupts a turn with messages queued: they wait until sent, edited or discarded. */
  queuePaused: boolean;
}

export type AppAction =
  | { type: "connection"; status: ConnectionStatus; attempt: number }
  | { type: "server"; message: ServerMessage; now: number }
  /** This tab sent a prompt: show it at once (the server does not echo user messages). */
  | { type: "prompt_sent"; text: string; now: number }
  /** This tab answered an ask; the server's ask_closed may follow and is then a no-op. */
  | { type: "ask_answered"; id: number }
  | { type: "toast"; tone: ToastTone; title: string; description?: string }
  | { type: "toast_dismiss"; id: number }
  /** The server refused a prompt this tab already showed (busy): take its row back out. */
  | { type: "prompt_unsent"; itemId: string }
  | { type: "sending"; sending: boolean }
  /** `front` puts it back at the head (a refused prompt keeps its place). Adding unpauses the queue, as in the terminal. */
  | { type: "queue_add"; text: string; front?: boolean }
  | { type: "queue_remove"; id: number }
  | { type: "queue_clear" }
  | { type: "queue_pause"; paused: boolean };

export const MAX_TOASTS = 4;

export const initialAppState: AppState = {
  connection: { status: "idle", attempt: 0, everOpened: false },
  hello: null,
  helloSeq: 0,
  session: null,
  transcript: emptyTranscript,
  turn: null,
  asks: [],
  toasts: [],
  toastSeq: 0,
  sending: false,
  queue: [],
  queueSeq: 0,
  queuePaused: false,
};

function onServer(state: AppState, message: ServerMessage, now: number): AppState {
  switch (message.t) {
    case "hello":
      return {
        ...state,
        hello: message.server,
        helloSeq: state.helloSeq + 1,
        transcript: historyToTranscript(message.server.history),
        turn: null,
        // A new session (or a fresh connection): the server re-sends any ask that is still open.
        asks: [],
      };
    case "state": {
      const { busy, turnStartedAt } = message.state;
      if (busy) {
        // The server's clock wins: a tab that joins mid-turn still shows the turn's real length.
        const startedAt = turnStartedAt ?? state.turn?.startedAt ?? now;
        const turn = state.turn?.startedAt === startedAt ? state.turn : { startedAt };
        return { ...state, session: message.state, turn };
      }
      // Idle: nothing can still be streaming (turn_end already came for a turn; an expansion has none).
      return { ...state, session: message.state, turn: null, transcript: flush(state.transcript) };
    }
    case "user":
      return { ...state, transcript: addUser(state.transcript, message.text), turn: state.turn ?? { startedAt: now } };
    case "event": {
      const event = message.event;
      let transcript = reduce(state.transcript, event);
      let turn = state.turn;
      let session = state.session;
      if (event.type === "turn_end") {
        if (turn) transcript = addTurnDone(transcript, (now - turn.startedAt) / 1000);
        turn = null;
      } else if (!turn) {
        // A tab that connected mid-turn starts its clock at the first event it sees.
        turn = { startedAt: now };
      }
      if (event.type === "usage" && session) {
        session = {
          ...session,
          contextTokens: event.contextTokens,
          ...(event.totalCostUsd !== undefined ? { totalCostUsd: event.totalCostUsd } : {}),
        };
      }
      return { ...state, transcript, turn, session };
    }
    case "ask":
      if (state.asks.some((a) => a.id === message.id)) return state;
      return { ...state, asks: [...state.asks, { id: message.id, prompt: message.prompt }] };
    case "ask_closed":
      return removeAsk(state, message.id);
    default:
      // rpc_result is correlated by the client and never reaches the store.
      return state;
  }
}

function removeAsk(state: AppState, id: number): AppState {
  if (!state.asks.some((a) => a.id === id)) return state;
  return { ...state, asks: state.asks.filter((a) => a.id !== id) };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "connection": {
      const open = action.status === "open";
      const connection: ConnectionState = {
        status: action.status,
        attempt: action.attempt,
        everOpened: state.connection.everOpened || open,
      };
      // Asks can only be answered on the socket they arrived on; after a drop the server re-sends what is still open.
      const asks = open ? state.asks : [];
      return { ...state, connection, asks: asks.length === state.asks.length ? state.asks : asks };
    }
    case "server":
      return onServer(state, action.message, action.now);
    case "prompt_sent":
      return { ...state, transcript: addUser(state.transcript, action.text), turn: state.turn ?? { startedAt: action.now } };
    case "ask_answered":
      return removeAsk(state, action.id);
    case "toast": {
      const id = state.toastSeq + 1;
      const toast: Toast = { id, tone: action.tone, title: action.title, ...(action.description ? { description: action.description } : {}) };
      return { ...state, toastSeq: id, toasts: [...state.toasts, toast].slice(-MAX_TOASTS) };
    }
    case "toast_dismiss":
      if (!state.toasts.some((t) => t.id === action.id)) return state;
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "prompt_unsent": {
      const { done, live } = state.transcript;
      if (!done.some((i) => i.id === action.itemId) && !live.some((i) => i.id === action.itemId)) return state;
      const transcript = { ...state.transcript, done: done.filter((i) => i.id !== action.itemId), live: live.filter((i) => i.id !== action.itemId) };
      return { ...state, transcript, turn: state.session?.busy ? state.turn : null };
    }
    case "sending":
      return state.sending === action.sending ? state : { ...state, sending: action.sending };
    case "queue_add": {
      const text = action.text.trim();
      if (!text) return state;
      const item: QueuedMessage = { id: state.queueSeq + 1, text };
      const queue = action.front ? [item, ...state.queue] : [...state.queue, item];
      return { ...state, queue, queueSeq: item.id, queuePaused: action.front ? state.queuePaused : false };
    }
    case "queue_remove": {
      if (!state.queue.some((q) => q.id === action.id)) return state;
      const queue = state.queue.filter((q) => q.id !== action.id);
      return { ...state, queue, queuePaused: queue.length === 0 ? false : state.queuePaused };
    }
    case "queue_clear":
      return state.queue.length === 0 && !state.queuePaused ? state : { ...state, queue: [], queuePaused: false };
    case "queue_pause": {
      const paused = action.paused && state.queue.length > 0;
      return paused === state.queuePaused ? state : { ...state, queuePaused: paused };
    }
  }
}

/** The next queued message to run, when this tab may start a turn now; null otherwise. */
export function nextQueued(state: AppState): QueuedMessage | null {
  if (state.queue.length === 0 || state.queuePaused || state.sending) return null;
  if (state.connection.status !== "open" || !state.hello || !state.session || state.session.busy) return null;
  if (state.asks.length > 0) return null;
  return state.queue[0]!;
}

/** Busy from this tab's point of view: the server runs something, or this tab is about to. */
export function isBusy(state: AppState): boolean {
  return state.sending || (state.session?.busy ?? false);
}
