// web/src/components/admin/admin-test-kit.ts — test-only: a fake socket that answers admin calls (`{t:"admin"}`) from a
// handler map, and mountAdmin(), which renders a page inside the real store (like page-test-kit's mountPage). A handler
// that throws answers with an error; a method without a handler answers "Not available in the demo." Call withDom()
// before using it.
import type { ComponentType } from "react";

import type { AdminMethod } from "@core/web/admin/api";
import type { ClientMessage, ServerMessage } from "@core/web/protocol";

import { TEST_HELLO, TEST_STATE } from "@/components/pages/page-test-kit";
import { TcodeClient, type SocketLike } from "@/lib/client";
import type { AppStore } from "@/lib/store";

export type AdminHandler = (params: unknown) => unknown;
export type AdminHandlers = Partial<Record<AdminMethod, AdminHandler>>;

export interface AdminCall {
  method: string;
  params: unknown;
}

export class AdminSocket implements SocketLike {
  readyState = 0;
  calls: AdminCall[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public handlers: AdminHandlers) {}

  send(data: string): void {
    const message = JSON.parse(data) as ClientMessage;
    if (message.t !== "admin") return;
    this.calls.push({ method: message.method, params: message.params });
    const handler = this.handlers[message.method as AdminMethod];
    Promise.resolve()
      .then(() => {
        if (!handler) throw new Error("Not available in the demo.");
        return handler(message.params);
      })
      .then(
        (result) => this.deliver({ t: "admin_result", id: message.id, ok: true, result }),
        (error: unknown) => this.deliver({ t: "admin_result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
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
  callsOf(method: AdminMethod): AdminCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

export interface MountedAdmin {
  store: AppStore;
  socket: AdminSocket;
}

export async function mountAdmin(Page: ComponentType, handlers: AdminHandlers): Promise<MountedAdmin> {
  const { render, act } = await import("@testing-library/react");
  const { createElement } = await import("react");
  const { LazyMotion, domMax } = await import("motion/react");
  const { createAppStore, StoreProvider } = await import("@/lib/store");

  const socket = new AdminSocket(handlers);
  const client = new TcodeClient({ url: "ws://test/ws", socket: () => socket, setTimer: () => null, clearTimer: () => {} });
  const store = createAppStore({ client });
  store.start();
  render(createElement(StoreProvider, { store }, createElement(LazyMotion, { features: domMax, strict: true }, createElement(Page))));
  await act(async () => {
    socket.open();
    socket.deliver({ t: "hello", server: TEST_HELLO });
    socket.deliver({ t: "state", state: TEST_STATE });
    await Promise.resolve();
  });
  return { store, socket };
}
