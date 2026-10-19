import { describe, expect, test } from "bun:test";

import { LOGIN_TIMEOUT_CLOSE_CODE, type ClientMessage, type ServerMessage } from "@core/web/protocol";

import type { Credentials } from "@/lib/credentials";
import { TcodeClient, type ClientEvent, type SocketLike } from "@/lib/client";

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
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  closeWith(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness() {
  let key: string | null = null;
  const credentials: Credentials = { load: () => key, save: (k) => void (key = k), clear: () => void (key = null), persistent: true };
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const client = new TcodeClient({
    url: "ws://x/ws",
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    credentials,
    deviceName: () => "Safari on iPhone",
  });
  const events: ClientEvent[] = [];
  client.subscribe((e) => events.push(e));
  client.connect();
  return { client, sockets, timers, events };
}

describe("the server's login timeout (close code 4408)", () => {
  test("reconnects at once and silently: the login screen sees no status change", () => {
    const { client, sockets, timers, events } = harness();
    sockets[0]!.open();
    expect(client.status).toBe("login");
    events.length = 0;
    sockets[0]!.closeWith(LOGIN_TIMEOUT_CLOSE_CODE);
    expect(sockets).toHaveLength(2);
    expect(timers.filter((t) => t.ms !== 8000)).toEqual([]);
    sockets[1]!.open();
    expect(events.filter((e) => e.type === "status" && e.status !== "login")).toEqual([]);
    expect(client.status).toBe("login");
    expect(client.reconnectAttempt).toBe(0);
    expect(sockets[1]!.sent).toEqual([]);
  });

  test("a code typed after the reconnect logs in on the new socket", async () => {
    const { client, sockets } = harness();
    sockets[0]!.open();
    sockets[0]!.closeWith(LOGIN_TIMEOUT_CLOSE_CODE);
    sockets[1]!.open();
    const done = client.login("123456");
    expect(sockets[1]!.sent[0]).toEqual({ t: "login", value: "123456", name: "Safari on iPhone" });
    sockets[1]!.deliver({ t: "login_ok", key: "K", device: { id: "d", name: "n" } });
    await done;
    expect(client.status).toBe("open");
  });

  test("a code that was on its way when the socket timed out is sent again, not lost", async () => {
    const { client, sockets } = harness();
    sockets[0]!.open();
    const done = client.login("654321");
    sockets[0]!.closeWith(LOGIN_TIMEOUT_CLOSE_CODE);
    expect(client.status).toBe("login");
    sockets[1]!.open();
    expect(sockets[1]!.sent[0]).toEqual({ t: "login", value: "654321", name: "Safari on iPhone" });
    sockets[1]!.deliver({ t: "login_ok", key: "K", device: { id: "d", name: "n" } });
    await done;
    expect(client.status).toBe("open");
  });
});
