// web/src/lib/client.ts — the browser side of the `tcode web` protocol (src/web/protocol.ts): one WebSocket, typed RPCs,
// permission answers, and reconnection with backoff. No React here; lib/store.ts subscribes to it.
import type { PermissionAnswer } from "@core/agent/events";
import { WS_PATH, type ClientMessage, type RpcMap, type RpcMethod, type ServerMessage } from "@core/web/protocol";

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The part of the WebSocket API the client uses, so tests and demo mode can supply their own socket. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export type ClientEvent =
  | { type: "status"; status: ConnectionStatus; attempt: number }
  | { type: "message"; message: ServerMessage };

export type ClientListener = (event: ClientEvent) => void;

/** Params are omitted for methods whose params are `undefined`. */
export type RpcArgs<M extends RpcMethod> = RpcMap[M]["params"] extends undefined ? [] : [params: RpcMap[M]["params"]];
export type RpcResult<M extends RpcMethod> = RpcMap[M]["result"];

export interface Backoff {
  /** Delay before the first reconnect attempt, ms. */
  initial: number;
  /** Upper bound, ms. */
  max: number;
  factor: number;
}

export interface ClientOptions {
  url?: string;
  socket?: SocketFactory;
  backoff?: Partial<Backoff>;
  /** Injectable timers for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;
const DEFAULT_BACKOFF: Backoff = { initial: 500, max: 8000, factor: 2 };

/** An RPC that failed on the server ("busy", "unknown session" …) or because the socket went away. */
export class RpcError extends Error {
  readonly method: RpcMethod;
  constructor(method: RpcMethod, message: string) {
    super(message);
    this.name = "RpcError";
    this.method = method;
  }
}

/** ws:// or wss:// on the page's own origin, so the session cookie and the server's Origin check both apply. */
export function defaultSocketUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}${WS_PATH}`;
}

/** Delay before reconnect attempt `attempt` (1-based). */
export function backoffDelay(attempt: number, backoff: Backoff = DEFAULT_BACKOFF): number {
  return Math.min(backoff.max, backoff.initial * backoff.factor ** Math.max(0, attempt - 1));
}

function isServerMessage(value: unknown): value is ServerMessage {
  return !!value && typeof value === "object" && typeof (value as { t?: unknown }).t === "string";
}

interface Pending {
  method: RpcMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class TcodeClient {
  private readonly url: string | undefined;
  private readonly makeSocket: SocketFactory;
  private readonly backoff: Backoff;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private socket: SocketLike | null = null;
  private listeners = new Set<ClientListener>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private attempt = 0;
  private timer: unknown = null;
  private stopped = false;
  private _status: ConnectionStatus = "idle";

  constructor(options: ClientOptions = {}) {
    this.url = options.url;
    this.makeSocket = options.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  /** How many reconnect attempts have been made since the socket was last open. */
  get reconnectAttempt(): number {
    return this.attempt;
  }

  subscribe(listener: ClientListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): void {
    this.stopped = false;
    if (this.socket) return;
    this.open();
  }

  /** Closes for good: no reconnect, pending RPCs fail. */
  close(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(1000, "client closed");
    }
    this.failPending("connection closed");
    this.setStatus("closed");
  }

  /** Calls a server method. Rejects with RpcError when the server says no or the connection drops before it answers. */
  rpc<M extends RpcMethod>(method: M, ...args: RpcArgs<M>): Promise<RpcResult<M>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      return Promise.reject(new RpcError(method, "not connected"));
    }
    const id = this.nextId++;
    const message: ClientMessage = args.length > 0 ? { t: "rpc", id, method, params: args[0] } : { t: "rpc", id, method };
    return new Promise<RpcResult<M>>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        reject(new RpcError(method, error instanceof Error ? error.message : "send failed"));
      }
    });
  }

  /** Answers a server "ask". Returns false when there is no open socket to answer on. */
  answerPermission(id: number, answer: PermissionAnswer): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    const message: ClientMessage = { t: "permission", id, answer };
    socket.send(JSON.stringify(message));
    return true;
  }

  private open(): void {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    try {
      socket = this.makeSocket(this.url ?? defaultSocketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending("connection lost");
      if (this.stopped) {
        this.setStatus("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    this.setStatus("reconnecting");
    const delay = backoffDelay(this.attempt, this.backoff);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isServerMessage(parsed)) return;
    if (parsed.t === "rpc_result") {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.ok) pending.resolve(parsed.result);
      else pending.reject(new RpcError(pending.method, parsed.error));
      return;
    }
    this.emit({ type: "message", message: parsed });
  }

  private failPending(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new RpcError(p.method, reason));
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.emit({ type: "status", status, attempt: this.attempt });
  }

  private emit(event: ClientEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
