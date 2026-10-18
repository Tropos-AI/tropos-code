// web/src/lib/client.ts — the browser side of the `tcode web` protocol (src/web/protocol.ts): one WebSocket, typed RPCs,
// permission answers, and reconnection with backoff. No React here; lib/store.ts subscribes to it.
import type { PermissionAnswer } from "@core/agent/events";
import { AUTH_CLOSE_CODE, WS_PATH, type ClientMessage, type RpcMap, type RpcMethod, type ServerMessage } from "@core/web/protocol";
import type { AdminMethod, AdminParams, AdminResult } from "@core/web/admin/api";

import type { Credentials } from "@/lib/credentials";
import { deviceNameFromUserAgent } from "@/lib/device-name";

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "login";

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
  /** Where the device key lives. Absent = no handshake (demo mode, plain test sockets): the socket is open on connect. */
  credentials?: Credentials;
  deviceName?: () => string;
  /** A one-time key from a `#login=` link; used when this browser has no key or its key is refused. */
  pendingLogin?: string;
  /** How long to wait for an answer to `auth` before trying again on a new socket, ms. */
  authTimeout?: number;
}

const OPEN = 1;
const AUTH_TIMEOUT = 8000;
const DEFAULT_BACKOFF: Backoff = { initial: 500, max: 8000, factor: 2 };

/** An RPC that failed on the server ("busy", "unknown session" …) or because the socket went away. */
export class RpcError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
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

export type AdminArgs<M extends AdminMethod> = AdminParams<M> extends undefined ? [] : undefined extends AdminParams<M> ? [params?: AdminParams<M>] : [params: AdminParams<M>];

interface Pending {
  method: string;
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
  private readonly credentials: Credentials | undefined;
  private readonly deviceName: () => string;
  private readonly authTimeout: number;
  private authTimer: unknown = null;
  /** Past the handshake (or none needed): rpc/admin may go out. */
  private authed = false;
  /** A one-time key or code waiting for a socket that has no device key. */
  private loginValue: string | undefined;
  private loginWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(options: ClientOptions = {}) {
    this.url = options.url;
    this.makeSocket = options.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.credentials = options.credentials;
    this.deviceName = options.deviceName ?? (() => deviceNameFromUserAgent(typeof navigator === "undefined" ? "" : navigator.userAgent));
    this.authTimeout = options.authTimeout ?? AUTH_TIMEOUT;
    this.loginValue = options.pendingLogin;
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
    this.stopAuthTimer();
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
    if (!socket || socket.readyState !== OPEN || !this.authed) {
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

  /** Calls a host-level admin method (src/web/admin/api.ts). Rejects with RpcError like rpc(). */
  admin<M extends AdminMethod>(method: M, ...args: AdminArgs<M>): Promise<AdminResult<M>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || !this.authed) return Promise.reject(new RpcError(method, "not connected"));
    const id = this.nextId++;
    const params = args[0];
    const message: ClientMessage = params === undefined ? { t: "admin", id, method } : { t: "admin", id, method, params };
    return new Promise<AdminResult<M>>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        reject(new RpcError(method, error instanceof Error ? error.message : "send failed"));
      }
    });
  }

  /** Logs this browser in with a 6-digit code or a one-time key. Rejects with RpcError("login", "invalid" | "locked"). */
  login(value: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.socket;
      if (socket && !(socket.readyState === OPEN && this._status === "login")) {
        reject(new RpcError("login", "not connected"));
        return;
      }
      // A server that never answers must not leave the login screen waiting for good.
      const timer = this.setTimer(() => {
        if (this.loginWaiter?.reject !== settle.reject) return;
        this.loginWaiter = null;
        reject(new RpcError("login", "timeout"));
      }, this.authTimeout);
      const settle = {
        resolve: () => (this.clearTimer(timer), resolve()),
        reject: (error: Error) => (this.clearTimer(timer), reject(error)),
      };
      this.loginWaiter = settle;
      if (socket) {
        this.sendLogin(socket, value);
        return;
      }
      // The socket is gone (logged out elsewhere): one fresh connection, which sends this on open.
      this.loginValue = value;
      if (!socket) {
        this.stopped = false;
        this.open();
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
    this.authed = false;
    socket.onopen = () => {
      const credentials = this.credentials;
      if (!credentials) {
        this.attempt = 0;
        this.authed = true;
        this.setStatus("open");
        return;
      }
      const key = credentials.load();
      if (key) {
        this.send(socket, { t: "auth", key });
        // No answer (the server's device store failed): try again, but never throw the key away for silence.
        this.authTimer = this.setTimer(() => {
          this.authTimer = null;
          if (this.socket !== socket || this.authed) return;
          this.socket = null;
          socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
          socket.close();
          if (!this.stopped) this.scheduleReconnect();
        }, this.authTimeout);
      } else this.sendPendingOrAskForLogin(socket);
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authed = false;
      this.stopAuthTimer();
      this.failPending("connection lost");
      if ((event as { code?: number } | null)?.code === AUTH_CLOSE_CODE && this.credentials) {
        // Logged out from another device: forget the key and show the login screen; login() reconnects on demand.
        this.credentials.clear();
        this.setStatus("login");
        return;
      }
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
    if (this.receiveAuth(parsed)) return;
    if (parsed.t === "rpc_result" || parsed.t === "admin_result") {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.ok) pending.resolve(parsed.result);
      else pending.reject(new RpcError(pending.method, parsed.error));
      return;
    }
    this.emit({ type: "message", message: parsed });
  }

  private send(socket: SocketLike, message: ClientMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // onclose follows and handles reconnection.
    }
  }

  private sendLogin(socket: SocketLike, value: string): void {
    this.send(socket, { t: "login", value, name: this.deviceName() });
  }

  private sendPendingOrAskForLogin(socket: SocketLike): void {
    const value = this.loginValue;
    this.loginValue = undefined;
    if (value !== undefined) this.sendLogin(socket, value);
    else this.waitForLogin();
  }

  private waitForLogin(): void {
    this.attempt = 0;
    this.setStatus("login");
  }

  private stopAuthTimer(): void {
    if (this.authTimer !== null) this.clearTimer(this.authTimer);
    this.authTimer = null;
  }

  private becomeOpen(): void {
    this.stopAuthTimer();
    this.authed = true;
    this.attempt = 0;
    this.setStatus("open");
  }

  /** The handshake messages; true when the message was one of them. */
  private receiveAuth(message: ServerMessage): boolean {
    const socket = this.socket;
    switch (message.t) {
      case "auth_ok":
        this.becomeOpen();
        return true;
      case "auth_failed":
        this.stopAuthTimer();
        this.credentials?.clear();
        if (socket) this.sendPendingOrAskForLogin(socket);
        return true;
      case "login_ok":
        this.credentials?.save(message.key);
        this.becomeOpen();
        this.loginWaiter?.resolve();
        this.loginWaiter = null;
        return true;
      case "login_failed": {
        const waiter = this.loginWaiter;
        this.loginWaiter = null;
        this.waitForLogin();
        waiter?.reject(new RpcError("login", message.reason));
        return true;
      }
      default:
        return false;
    }
  }

  private failPending(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new RpcError(p.method, reason));
    this.loginWaiter?.reject(new RpcError("login", reason));
    this.loginWaiter = null;
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.emit({ type: "status", status, attempt: this.attempt });
  }

  private emit(event: ClientEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
