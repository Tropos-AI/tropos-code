// web/src/components/chat/chat-test-kit.ts — shared by the chat component tests: a fake socket that records what the
// app sends and can answer RPCs, and a connected store. Import it dynamically, after withDom() (see test-setup.ts).
import { createElement, type ReactNode } from "react";
import { LazyMotion, domMax } from "motion/react";

import type { ClientMessage, HelloInfo, RpcMethod, ServerMessage, SessionState } from "@core/web/protocol";

import { TcodeClient, type SocketLike } from "@/lib/client";
import { createAppStore, StoreProvider, type AppStore } from "@/lib/store";

/**
 * happy-dom implements Element.animate, so Motion drives opacity/transform through it — and happy-dom's
 * Animation.cancel() rejects `finished` with nobody listening, which bun reports as a failure when an exit animation is
 * interrupted. Without WAAPI, Motion falls back to its own frame loop. Test-only.
 */
function disableWaapi(): void {
  for (const ctor of [globalThis.Element, globalThis.HTMLElement]) {
    if (ctor && Object.prototype.hasOwnProperty.call(ctor.prototype, "animate")) delete (ctor.prototype as { animate?: unknown }).animate;
  }
}
disableWaapi();

export type RpcHandler = (params: unknown) => unknown;

export class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** RPCs answered automatically (on a microtask); others wait for `reply`. */
  handlers: Partial<Record<RpcMethod, RpcHandler>> = {};

  send(data: string): void {
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    if (message.t !== "rpc") return;
    const handler = this.handlers[message.method];
    if (handler) queueMicrotask(() => this.deliver({ t: "rpc_result", id: message.id, ok: true, result: handler(message.params) ?? null }));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** Every RPC sent so far, optionally for one method. */
  rpcs(method?: RpcMethod): Array<Extract<ClientMessage, { t: "rpc" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { t: "rpc" }> => m.t === "rpc" && (method === undefined || m.method === method));
  }
  permissions(): Array<Extract<ClientMessage, { t: "permission" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { t: "permission" }> => m.t === "permission");
  }
}

export const HELLO: HelloInfo = {
  version: "0.4.0",
  cwd: "/repo",
  sessionId: "s1",
  modes: ["default", "acceptEdits", "plan"],
  commands: [
    { name: "review", description: "Review the diff", argumentHint: "[path]" },
    { name: "frontend-design", description: "(skill) Distinctive UI" },
  ],
  history: [],
};

export const IDLE: SessionState = { model: "claude-opus-5-5", effort: "high", mode: "default", busy: false, contextTokens: 1000, contextWindow: 200_000, totalCostUsd: 0.1, turns: 0 };

/** A store whose socket is open and has said hello. */
export function connectedStore(handlers: FakeSocket["handlers"] = {}): { store: AppStore; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const client = new TcodeClient({
    url: "ws://test/ws",
    socket: () => {
      socket = new FakeSocket();
      socket.handlers = handlers;
      return socket;
    },
    setTimer: () => null,
    clearTimer: () => {},
  });
  const store = createAppStore({ client });
  store.start();
  socket!.open();
  socket!.deliver({ t: "hello", server: HELLO });
  socket!.deliver({ t: "state", state: IDLE });
  return { store, socket: socket! };
}

/** The providers the app needs around any component. */
export function withProviders(store: AppStore, children: ReactNode) {
  return createElement(StoreProvider, { store }, createElement(LazyMotion, { features: domMax, strict: true }, children));
}

export const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
