// web/src/components/setup/admin-test-kit.ts — test-only: mountAdminPage() renders a page inside the real store whose
// fake socket answers both RPCs (like page-test-kit) and admin calls from handler maps.
import type { ComponentType } from "react";

import type { AdminMethod } from "@core/web/admin/api";
import type { ClientMessage } from "@core/web/protocol";

import { PageSocket, TEST_HELLO, TEST_STATE, type MountedPage, type RpcHandlers } from "@/components/pages/page-test-kit";
import { TcodeClient } from "@/lib/client";

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AdminHandlers = Partial<Record<AdminMethod, (params: any) => unknown>>;

export interface AdminCall {
  method: string;
  params: unknown;
}

export class AdminSocket extends PageSocket {
  adminCalls: AdminCall[] = [];

  constructor(
    rpcHandlers: RpcHandlers,
    public admin: AdminHandlers,
  ) {
    super(rpcHandlers);
  }

  override send(data: string): void {
    const message = JSON.parse(data) as ClientMessage;
    if (message.t !== "admin") {
      super.send(data);
      return;
    }
    this.frames.push(data);
    this.adminCalls.push({ method: message.method, params: message.params });
    const handler = this.admin[message.method as AdminMethod];
    Promise.resolve()
      .then(() => {
        if (!handler) throw new Error(`No test handler for ${message.method}`);
        return handler(message.params);
      })
      .then(
        (result) => this.deliver({ t: "admin_result", id: message.id, ok: true, result }),
        (error: unknown) => this.deliver({ t: "admin_result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
  }

  adminOf(method: AdminMethod): AdminCall[] {
    return this.adminCalls.filter((c) => c.method === method);
  }
}

export interface MountedAdminPage extends MountedPage {
  socket: AdminSocket;
}

export async function mountAdminPage(Page: ComponentType, admin: AdminHandlers, rpc: RpcHandlers = {}): Promise<MountedAdminPage> {
  const { render, act } = await import("@testing-library/react");
  const { createElement } = await import("react");
  const { LazyMotion, domMax } = await import("motion/react");
  const { createAppStore, StoreProvider } = await import("@/lib/store");

  const socket = new AdminSocket(rpc, admin);
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
