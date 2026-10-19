import { afterEach, describe, expect, test } from "bun:test";

import type { ClientMessage, HelloInfo, ServerMessage, SessionState } from "@core/web/protocol";

import { TcodeClient, type SocketLike } from "@/lib/client";
import type { AppStore } from "@/lib/store";
import { withDom } from "@/test-setup";

withDom();
// react-dom, testing-library and the app load after happy-dom is registered.
const { render, screen, cleanup: unmount, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LazyMotion, domMax } = await import("motion/react");
const { App } = await import("@/app/App");
const { createAppStore, StoreProvider } = await import("@/lib/store");

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void {
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    if (message.t === "rpc" && message.method === "sessions") {
      queueMicrotask(() => this.deliver({ t: "rpc_result", id: message.id, ok: true, result: [{ id: "s1", title: "Fix the flaky test", updatedAt: new Date().toISOString(), messageCount: 4 }] }));
    }
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
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const HELLO: HelloInfo = { version: "0.5.3", cwd: "/repo", sessionId: "s1", modes: ["default"], commands: [], history: [{ role: "user", content: "Fix the flaky test" }] };
const STATE: SessionState = { model: "claude-opus-5-5", effort: "high", mode: "default", busy: false, contextTokens: 50_000, contextWindow: 200_000, totalCostUsd: 0.42, turns: 1 };

afterEach(() => {
  unmount();
});

async function mount(): Promise<{ store: AppStore; socket: FakeSocket }> {
  let socket: FakeSocket | null = null;
  const client = new TcodeClient({ url: "ws://test/ws", socket: () => (socket = new FakeSocket()), setTimer: () => null, clearTimer: () => {} });
  const store = createAppStore({ client });
  store.start();
  render(createElement(StoreProvider, { store }, createElement(LazyMotion, { features: domMax, strict: true }, createElement(App))));
  await act(async () => {
    socket!.open();
    socket!.deliver({ t: "hello", server: HELLO });
    socket!.deliver({ t: "state", state: STATE });
    await Promise.resolve();
  });
  return { store, socket: socket! };
}

describe("App shell", () => {
  test("renders the landmarks, the page nav and the session title", async () => {
    await mount();
    expect(screen.getByRole("main")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Pages" });
    for (const label of ["Chat", "Skills", "Agents", "Extensions", "Memory", "Status", "Settings"]) {
      expect(nav.textContent).toContain(label);
    }
    expect(screen.getByRole("banner").textContent).toContain("Fix the flaky test");
    expect(screen.getByRole("button", { name: /Model: claude-opus-5-5/ })).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  test("shows a reconnecting banner when the socket drops", async () => {
    const { socket } = await mount();
    await act(async () => {
      socket.drop();
    });
    const statuses = screen.getAllByRole("status").map((el) => el.textContent ?? "");
    expect(statuses.some((t) => t.includes("Connection lost"))).toBe(true);
  });
});
