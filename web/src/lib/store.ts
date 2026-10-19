// web/src/lib/store.ts — the app's external store: wires a TcodeClient into appReducer and exposes React hooks
// (useSyncExternalStore). The state logic itself lives in app-state.ts.
import { createContext, createElement, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { PermissionAnswer, TurnEndReason } from "@core/agent/events";
import type { Attachment } from "@core/attachments/attachments";
import type { AdminMethod, AdminResult } from "@core/web/admin/api";
import type { HelloInfo, RpcMethod, SessionState } from "@core/web/protocol";
import type { Transcript } from "@core/ui/transcript";
import { BUSY_ERROR } from "@core/web/protocol";
import { parseCommand } from "@core/ui/commands";

import { appReducer, initialAppState, isBusy, nextQueued, type AppAction, type AppState, type ConnectionState, type PendingAsk, type QueuedMessage, type Toast, type ToastTone } from "@/lib/app-state";
import { toPromptAttachment } from "@/lib/attachments";
import { RpcError, TcodeClient, type AdminArgs, type RpcArgs, type RpcResult } from "@/lib/client";
import type { Credentials } from "@/lib/credentials";
import { createDemoSocket, DEMO_QUEUED } from "@/lib/demo";

export type { AppState, ConnectionState, PendingAsk, QueuedMessage, Toast, ToastTone } from "@/lib/app-state";

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
}

export interface AppStore {
  getState(): AppState;
  subscribe(listener: () => void): () => void;
  dispatch(action: AppAction): void;
  readonly client: TcodeClient;
  /** True when the store talks to the scripted demo server (`?demo=1`). */
  readonly demo: boolean;
  /** Typed RPC; failures reject with RpcError. */
  rpc<M extends RpcMethod>(method: M, ...args: RpcArgs<M>): Promise<RpcResult<M>>;
  /** Typed host-level admin call (status, doctor, config, projects, cron …); failures reject with RpcError. */
  admin<M extends AdminMethod>(method: M, ...args: AdminArgs<M>): Promise<AdminResult<M>>;
  /**
   * Shows the prompt in the transcript and runs one turn. Resolves with the turn's end reason, or null when the server
   * refused it ("busy" — the composer queues instead) or the connection dropped; refusals other than busy also toast.
   */
  sendPrompt(text: string, options?: { display?: string; model?: string }): Promise<TurnEndReason | null>;
  /**
   * Runs typed input that becomes a turn: a plain prompt, a prompt command (/init, /learn) or a custom command or skill
   * (expanded by the server first). Anything else is the caller's to handle. A busy refusal puts it back in the queue.
   */
  runInput(text: string, attachments?: Attachment[]): Promise<void>;
  /** Queues typed input (and what was attached to it) to run when the agent is free. */
  enqueue(text: string, attachments?: Attachment[]): void;
  dequeue(id: number): void;
  clearQueue(): void;
  setQueuePaused(paused: boolean): void;
  /** Interrupts the running turn or expansion; queued messages then wait (paused) as in the terminal. */
  interrupt(): Promise<void>;
  answerPermission(id: number, answer: PermissionAnswer): void;
  toast(input: ToastInput): void;
  dismissToast(id: number): void;
  /** Logs this browser in with a 6-digit code (or a one-time key); rejects with RpcError("login", "invalid" | "locked"). */
  login(value: string): Promise<void>;
  /** False when the browser cannot keep the device key (blocked storage): the login ends with the tab. */
  readonly loginRemembered: boolean;
  /** Opens the connection (idempotent). */
  start(): void;
  stop(): void;
}

export interface CreateAppStoreOptions {
  client?: TcodeClient;
  /** Replay the scripted demo session instead of talking to tcode (`?demo=1`). */
  demo?: boolean;
  /** Where the device key lives; absent in demo mode and in tests that do not model the handshake. */
  credentials?: Credentials;
  /** A one-time key taken from the `#login=` fragment. */
  pendingLogin?: string;
  now?: () => number;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAppStore(options: CreateAppStoreOptions = {}): AppStore {
  const now = options.now ?? (() => Date.now());
  const client = options.client ?? new TcodeClient(options.demo ? { url: "demo://tcode", socket: createDemoSocket } : { ...(options.credentials ? { credentials: options.credentials } : {}), ...(options.pendingLogin ? { pendingLogin: options.pendingLogin } : {}) });
  let state = initialAppState;
  const listeners = new Set<() => void>();

  const dispatch = (action: AppAction): void => {
    const next = appReducer(state, action);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  client.subscribe((event) => {
    if (event.type === "status") dispatch({ type: "connection", status: event.status, attempt: event.attempt });
    else dispatch({ type: "server", message: event.message, now: now() });
  });

  const toast = (input: ToastInput): void => dispatch({ type: "toast", tone: input.tone ?? "info", title: input.title, ...(input.description ? { description: input.description } : {}) });

  /** Set by interrupt() while a command expansion runs, so its failure reads as a cancel. */
  let interrupted = false;

  type Sent = TurnEndReason | typeof BUSY_ERROR | null;

  const runPrompt = async (text: string, opts: { display?: string; model?: string; attachments?: Attachment[] }): Promise<Sent> => {
    const attachments = opts.attachments ?? [];
    dispatch({ type: "prompt_sent", text: opts.display ?? text, ...(attachments.length > 0 ? { attachments } : {}), now: now() });
    const itemId = state.transcript.done.at(-1)?.id;
    const params = {
      text,
      ...(opts.display !== undefined ? { display: opts.display } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(attachments.length > 0 ? { attachments: attachments.map(toPromptAttachment) } : {}),
    };
    try {
      return await client.rpc("prompt", params);
    } catch (error) {
      const message = errorMessage(error);
      if (message === BUSY_ERROR) {
        if (itemId) dispatch({ type: "prompt_unsent", itemId });
        return BUSY_ERROR;
      }
      toast({ tone: "error", title: "The prompt did not run", description: message });
      return null;
    }
  };

  const runInput = async (text: string, attachments: Attachment[] = []): Promise<void> => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || state.sending) return;
    // Images alone are a plain message; attachments ride along with whatever becomes a turn.
    const command = trimmed ? parseCommand(trimmed, state.hello?.commands ?? []) : ({ kind: "none" } as const);
    const attached = attachments.length > 0 ? { attachments } : {};
    dispatch({ type: "sending", sending: true });
    interrupted = false;
    let result: Sent = null;
    try {
      if (command.kind === "none") result = await runPrompt(trimmed, attached);
      else if (command.kind === "prompt") result = await runPrompt(command.text, { display: trimmed, ...attached });
      else if (command.kind === "custom") {
        // One request: the server expands the command and runs it in the same busy period.
        dispatch({ type: "prompt_sent", text: trimmed, ...attached, now: now() });
        const itemId = state.transcript.done.at(-1)?.id;
        try {
          const wire = attachments.length > 0 ? { attachments: attachments.map(toPromptAttachment) } : {};
          result = await client.rpc("prompt", { text: "", display: trimmed, command: { name: command.name, args: command.args }, ...wire });
        } catch (error) {
          const message = errorMessage(error);
          if (itemId) dispatch({ type: "prompt_unsent", itemId });
          if (message === BUSY_ERROR) result = BUSY_ERROR;
          else if (interrupted) toast({ tone: "info", title: `/${command.name} cancelled` });
          else toast({ tone: "error", title: `/${command.name} did not run`, description: message });
        }
      }
    } finally {
      // Another tab started a turn first: keep the message, at the head of the queue, for when it is free.
      if (result === BUSY_ERROR) dispatch({ type: "queue_add", text: trimmed, ...(attachments.length > 0 ? { attachments } : {}), front: true });
      dispatch({ type: "sending", sending: false });
    }
  };

  let drainScheduled = false;
  /** Runs the next queued message once the agent is free (checked after every state change). */
  const drain = (): void => {
    drainScheduled = false;
    const next = nextQueued(state);
    if (!next) return;
    dispatch({ type: "queue_remove", id: next.id });
    void runInput(next.text, next.attachments);
  };
  listeners.add(() => {
    if (drainScheduled || !nextQueued(state)) return;
    drainScheduled = true;
    queueMicrotask(drain);
  });

  // The demo shows a follow-up waiting in the queue; it runs when the scripted first turn ends.
  if (options.demo) dispatch({ type: "queue_add", text: DEMO_QUEUED });

  const store: AppStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch,
    client,
    demo: options.demo ?? false,
    rpc: (method, ...args) => client.rpc(method, ...args),
    admin: (method, ...args) => client.admin(method, ...args),
    async sendPrompt(text, opts = {}) {
      dispatch({ type: "sending", sending: true });
      try {
        const result = await runPrompt(text, opts);
        return result === BUSY_ERROR ? null : result;
      } finally {
        dispatch({ type: "sending", sending: false });
      }
    },
    runInput,
    enqueue: (text, attachments) => dispatch({ type: "queue_add", text, ...(attachments?.length ? { attachments } : {}) }),
    dequeue: (id) => dispatch({ type: "queue_remove", id }),
    clearQueue: () => dispatch({ type: "queue_clear" }),
    setQueuePaused: (paused) => dispatch({ type: "queue_pause", paused }),
    async interrupt() {
      interrupted = true;
      if (state.queue.length > 0) dispatch({ type: "queue_pause", paused: true });
      try {
        await client.rpc("interrupt");
      } catch (error) {
        toast({ tone: "error", title: "Could not interrupt", description: errorMessage(error) });
      }
    },
    answerPermission(id, answer) {
      if (client.answerPermission(id, answer)) dispatch({ type: "ask_answered", id });
      else toast({ tone: "warn", title: "Not connected", description: "The answer could not be sent; it will be asked again after reconnecting." });
    },
    toast,
    dismissToast: (id) => dispatch({ type: "toast_dismiss", id }),
    login: (value) => client.login(value),
    get loginRemembered() {
      return options.credentials?.persistent ?? true;
    },
    start: () => client.connect(),
    stop: () => client.close(),
  };
  return store;
}

// ───────────────────────── React bindings ─────────────────────────

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children?: ReactNode }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useAppStore must be used inside <StoreProvider>");
  return store;
}

/** Subscribes to one slice. The selector must return a value that only changes when the slice does (no new objects). */
export function useAppSelector<T>(selector: (state: AppState) => T): T {
  const store = useAppStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

export function useConnection(): ConnectionState {
  return useAppSelector((s) => s.connection);
}

export function useHello(): HelloInfo | null {
  return useAppSelector((s) => s.hello);
}

/** Bumps on every hello (connect, clear, resume). */
export function useHelloSeq(): number {
  return useAppSelector((s) => s.helloSeq);
}

export function useSessionState(): SessionState | null {
  return useAppSelector((s) => s.session);
}

export function useTranscript(): Transcript {
  return useAppSelector((s) => s.transcript);
}

/** Busy from this tab's point of view: a turn or expansion runs on the server, or this tab is starting one. */
export function useBusy(): boolean {
  return useAppSelector(isBusy);
}

export interface QueueApi {
  items: QueuedMessage[];
  paused: boolean;
}

export function useQueue(): QueueApi {
  const items = useAppSelector((s) => s.queue);
  const paused = useAppSelector((s) => s.queuePaused);
  return useMemo(() => ({ items, paused }), [items, paused]);
}

/** When the running turn started (ms epoch), or null when idle. */
export function useTurnStartedAt(): number | null {
  return useAppSelector((s) => s.turn?.startedAt ?? null);
}

export interface PermissionApi {
  /** The oldest open ask, or null. */
  ask: PendingAsk | null;
  /** How many asks are waiting, including `ask`. */
  count: number;
  answer(answer: PermissionAnswer): void;
}

export function usePermission(): PermissionApi {
  const store = useAppStore();
  const asks = useAppSelector((s) => s.asks);
  const ask = asks[0] ?? null;
  const answer = useCallback(
    (value: PermissionAnswer) => {
      if (ask) store.answerPermission(ask.id, value);
    },
    [store, ask],
  );
  return useMemo(() => ({ ask, count: asks.length, answer }), [ask, asks.length, answer]);
}

export interface ToastsApi {
  toasts: Toast[];
  push(input: ToastInput): void;
  dismiss(id: number): void;
}

export function useToasts(): ToastsApi {
  const store = useAppStore();
  const toasts = useAppSelector((s) => s.toasts);
  return useMemo(() => ({ toasts, push: store.toast, dismiss: store.dismissToast }), [toasts, store]);
}

/** The typed admin function, stable for the store's lifetime. */
export function useAdmin(): AppStore["admin"] {
  return useAppStore().admin;
}

/** The typed RPC function, stable for the store's lifetime. */
export function useRpc(): AppStore["rpc"] {
  return useAppStore().rpc;
}

export { RpcError };
