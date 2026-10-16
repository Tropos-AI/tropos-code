// web/src/components/pages/page-test-kit.ts — test-only helpers for the data pages: a fake socket that answers RPCs from
// a handler map, a matchMedia stub (viewport width + reduced motion), a clipboard stub, and mountPage(), which renders a
// page inside the real store. Call withDom() before using mountPage (it imports react-dom lazily for that reason).
import type { ComponentType } from "react";

import type { ClientMessage, HelloInfo, RpcMethod, ServerMessage, SessionState } from "@core/web/protocol";

import { TcodeClient, type SocketLike } from "@/lib/client";
import type { AppStore } from "@/lib/store";

/** Answers one RPC; throwing (or rejecting) sends an error result. */
export type RpcHandler = (params: unknown) => unknown;
export type RpcHandlers = Partial<Record<RpcMethod, RpcHandler>>;

export interface RpcCall {
  method: RpcMethod;
  params: unknown;
}

export class PageSocket implements SocketLike {
  readyState = 0;
  calls: RpcCall[] = [];
  /** Every raw frame the client sent, to check that nothing secret went anywhere unexpected. */
  frames: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public handlers: RpcHandlers) {}

  send(data: string): void {
    this.frames.push(data);
    const message = JSON.parse(data) as ClientMessage;
    if (message.t !== "rpc") return;
    this.calls.push({ method: message.method, params: message.params });
    const handler = this.handlers[message.method];
    Promise.resolve()
      .then(() => (handler ? handler(message.params) : null))
      .then(
        (result) => this.deliver({ t: "rpc_result", id: message.id, ok: true, result }),
        (error: unknown) => this.deliver({ t: "rpc_result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
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
  callsOf(method: RpcMethod): RpcCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

/** A promise you resolve or reject from the test, for "still loading" states. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const TEST_HELLO: HelloInfo = {
  version: "0.4.0",
  cwd: "/repo",
  sessionId: "6f1c2d9a-4b7e-4e21-9c3a-1d2e3f4a5b6c",
  modes: ["default", "acceptEdits", "plan"],
  commands: [],
  history: [],
};

export const TEST_STATE: SessionState = { model: "claude-opus-5-5", effort: "high", mode: "default", busy: false, contextTokens: 1000, contextWindow: 200_000, totalCostUsd: 0.1, turns: 1 };

/** matchMedia for a viewport `width` px wide; reduced motion on by default so springs settle instantly. */
export function stubMatchMedia({ width = 1280, reducedMotion = true }: { width?: number; reducedMotion?: boolean } = {}): void {
  const matches = (query: string): boolean => {
    if (query.includes("prefers-reduced-motion")) return reducedMotion && query.includes("reduce");
    const min = /min-width:\s*(\d+)px/.exec(query);
    if (min) return width >= Number(min[1]);
    const max = /max-width:\s*(\d+)px/.exec(query);
    if (max) return width <= Number(max[1]);
    return false;
  };
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

/** Records clipboard writes. */
export function stubClipboard(): string[] {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });
  return written;
}

export interface MountedPage {
  store: AppStore;
  socket: PageSocket;
}

/** Renders `Page` with a store whose socket answers from `handlers`, then opens the connection and sends hello/state. */
export async function mountPage(Page: ComponentType, handlers: RpcHandlers, options: { state?: Partial<SessionState>; hello?: Partial<HelloInfo> } = {}): Promise<MountedPage> {
  const { render, act } = await import("@testing-library/react");
  const { createElement } = await import("react");
  const { LazyMotion, domMax } = await import("motion/react");
  const { createAppStore, StoreProvider } = await import("@/lib/store");

  const socket = new PageSocket(handlers);
  const client = new TcodeClient({ url: "ws://test/ws", socket: () => socket, setTimer: () => null, clearTimer: () => {} });
  const store = createAppStore({ client });
  store.start();
  render(createElement(StoreProvider, { store }, createElement(LazyMotion, { features: domMax, strict: true }, createElement(Page))));
  await act(async () => {
    socket.open();
    socket.deliver({ t: "hello", server: { ...TEST_HELLO, ...options.hello } });
    socket.deliver({ t: "state", state: { ...TEST_STATE, ...options.state } });
    await Promise.resolve();
  });
  return { store, socket };
}
