import { afterEach, describe, expect, test } from "bun:test";

import type { ClientMessage, ServerMessage } from "@core/web/protocol";

import { TcodeClient, type SocketLike } from "@/lib/client";
import type { Credentials } from "@/lib/credentials";
import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup: unmount, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LoginScreen } = await import("@/app/LoginScreen");
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
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(): void {
    this.readyState = 3;
  }
  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

afterEach(() => unmount());

async function mount(persistent = true, withApp = false) {
  const socket = new FakeSocket();
  const credentials: Credentials = { load: () => null, save: () => {}, clear: () => {}, persistent };
  const client = new TcodeClient({ url: "ws://t/ws", socket: () => socket, setTimer: () => null, clearTimer: () => {}, credentials, deviceName: () => "Chrome on macOS" });
  const store = createAppStore({ client, credentials });
  store.start();
  render(createElement(StoreProvider, { store }, createElement(withApp ? App : LoginScreen)));
  await act(async () => {
    socket.readyState = 1;
    socket.onopen?.({});
    await Promise.resolve();
  });
  return socket;
}

async function enter(code: string) {
  const input = screen.getByLabelText(/code/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value: code } });
  await act(async () => {
    fireEvent.submit(input.closest("form")!);
    await Promise.resolve();
  });
}

describe("LoginScreen", () => {
  test("six digits, Enter logs in; wrong code shows the reason; locked says wait", async () => {
    const socket = await mount();
    const input = screen.getByLabelText(/code/i) as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    await enter("123 456");
    expect(socket.sent[0]).toEqual({ t: "login", value: "123456", name: "Chrome on macOS" });
    await act(async () => {
      socket.deliver({ t: "login_failed", reason: "invalid" });
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toBe("That code didn't work. Codes work once, for 10 minutes.");
    await enter("654321");
    await act(async () => {
      socket.deliver({ t: "login_failed", reason: "locked" });
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toBe("Too many wrong codes. Wait a few minutes, then get a new one.");
  });

  test("explains where codes come from", async () => {
    await mount();
    const text = document.body.textContent ?? "";
    expect(text).toContain("tcode dashboard --code");
    expect(text).toContain("/login");
  });

  test("says the login won't be remembered when storage is blocked", async () => {
    await mount(false);
    expect(document.body.textContent).toContain("won't be remembered");
  });

  test("remembered browsers see no private-window note", async () => {
    await mount(true);
    expect(document.body.textContent).not.toContain("won't be remembered");
  });

  test("the app shows the login screen alone when the status is login", async () => {
    await mount(true, true);
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Log in to Tropos" })).toBeTruthy();
  });
});
