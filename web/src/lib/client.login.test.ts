import { describe, expect, test } from "bun:test";

import type { ClientMessage, ServerMessage } from "@core/web/protocol";

import type { Credentials } from "@/lib/credentials";
import { RpcError, TcodeClient, type SocketLike } from "@/lib/client";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(): void {
    this.closed = true;
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

function fakeCredentials(initial: string | null) {
  let key = initial;
  const log: string[] = [];
  const credentials: Credentials = {
    load: () => key,
    save: (k) => {
      key = k;
      log.push(`save:${k}`);
    },
    clear: () => {
      key = null;
      log.push("clear");
    },
    persistent: true,
  };
  return { credentials, log, key: () => key };
}

function harness(initialKey: string | null, extra: { pendingLogin?: string } = {}) {
  const creds = fakeCredentials(initialKey);
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
    credentials: creds.credentials,
    deviceName: () => "Safari on iPhone",
    ...extra,
  });
  client.connect();
  return { client, creds, sockets, timers };
}

describe("client login handshake", () => {
  test("with a stored key: sends auth first; open only after auth_ok", () => {
    const { client, sockets } = harness("K");
    sockets[0]!.open();
    expect(sockets[0]!.sent[0]).toEqual({ t: "auth", key: "K" });
    expect(client.status).toBe("connecting");
    sockets[0]!.deliver({ t: "auth_ok", device: { id: "d", name: "n" } });
    expect(client.status).toBe("open");
  });

  test("no key: status login; login(code) sends the device name and saves the key", async () => {
    const { client, creds, sockets } = harness(null);
    sockets[0]!.open();
    expect(client.status).toBe("login");
    expect(sockets[0]!.sent).toEqual([]);
    const done = client.login("123456");
    expect(sockets[0]!.sent[0]).toEqual({ t: "login", value: "123456", name: "Safari on iPhone" });
    sockets[0]!.deliver({ t: "login_ok", key: "NEWKEY", device: { id: "d", name: "n" } });
    await done;
    expect(creds.log).toEqual(["save:NEWKEY"]);
    expect(client.status).toBe("open");
  });

  test("a wrong or locked code rejects login() and stays on the login screen", async () => {
    const { client, sockets } = harness(null);
    sockets[0]!.open();
    const bad = client.login("000000");
    sockets[0]!.deliver({ t: "login_failed", reason: "locked" });
    const error = await bad.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).message).toBe("locked");
    expect(client.status).toBe("login");
  });

  test("login() gives up when the server never answers, and the login screen stays usable", async () => {
    const { client, sockets, timers } = harness(null);
    sockets[0]!.open();
    const pending = client.login("123456");
    const timer = timers.find((t) => t.ms === 8000)!;
    expect(timer).toBeDefined();
    timer.fn();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).message).toBe("timeout");
    expect(client.status).toBe("login");
    // The next try works as usual.
    const again = client.login("654321");
    sockets[0]!.deliver({ t: "login_ok", key: "K2", device: { id: "d", name: "n" } });
    await again;
    expect(client.status).toBe("open");
  });

  test("a stored key wins over a pending #login value; the value is used only if auth fails", () => {
    const { client, creds, sockets } = harness("K", { pendingLogin: "ONE" });
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([{ t: "auth", key: "K" }]);
    sockets[0]!.deliver({ t: "auth_failed" });
    expect(creds.log).toEqual(["clear"]);
    expect(sockets[0]!.sent[1]).toEqual({ t: "login", value: "ONE", name: "Safari on iPhone" });
    sockets[0]!.deliver({ t: "login_ok", key: "N", device: { id: "d", name: "n" } });
    expect(client.status).toBe("open");
  });

  test("no key and a pending #login value: logs in with it straight away", () => {
    const { sockets } = harness(null, { pendingLogin: "ONE" });
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([{ t: "login", value: "ONE", name: "Safari on iPhone" }]);
  });

  test("a failed #login value falls back to the login screen", () => {
    const { client, sockets } = harness(null, { pendingLogin: "ONE" });
    sockets[0]!.open();
    sockets[0]!.deliver({ t: "login_failed", reason: "invalid" });
    expect(client.status).toBe("login");
  });

  test("auth_failed with no pending value: clears the key, status login, no reconnect", () => {
    const { client, creds, sockets, timers } = harness("K");
    sockets[0]!.open();
    sockets[0]!.deliver({ t: "auth_failed" });
    expect(creds.log).toEqual(["clear"]);
    expect(client.status).toBe("login");
    expect(sockets).toHaveLength(1);
    expect(timers).toEqual([]);
  });

  test("close code 4401 (logged out elsewhere): clears the key, shows login, no reconnect", () => {
    const { client, creds, sockets, timers } = harness("K");
    sockets[0]!.open();
    sockets[0]!.deliver({ t: "auth_ok", device: { id: "d", name: "n" } });
    sockets[0]!.closeWith(4401);
    expect(creds.log).toEqual(["clear"]);
    expect(client.status).toBe("login");
    expect(sockets).toHaveLength(1);
    expect(timers).toEqual([]);
  });

  test("login() after a 4401 reconnects once and logs in", async () => {
    const { client, sockets } = harness("K");
    sockets[0]!.open();
    sockets[0]!.deliver({ t: "auth_ok", device: { id: "d", name: "n" } });
    sockets[0]!.closeWith(4401);
    const done = client.login("123456");
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent[0]).toEqual({ t: "login", value: "123456", name: "Safari on iPhone" });
    sockets[1]!.deliver({ t: "login_ok", key: "N", device: { id: "d", name: "n" } });
    await done;
    expect(client.status).toBe("open");
  });

  test("no answer to auth (store error): keeps the key and retries on a fresh socket", () => {
    const { client, creds, sockets, timers } = harness("K");
    sockets[0]!.open();
    expect(timers).toHaveLength(1);
    timers.shift()!.fn();
    expect(sockets[0]!.closed).toBe(true);
    expect(creds.log).toEqual([]);
    expect(client.status).toBe("reconnecting");
    expect(timers).toHaveLength(1); // the reconnect timer
    timers.shift()!.fn();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent[0]).toEqual({ t: "auth", key: "K" });
  });

  test("a dropped socket before the answer reconnects and keeps the key", () => {
    const { creds, sockets, timers } = harness("K");
    sockets[0]!.open();
    sockets[0]!.closeWith(1006);
    expect(creds.log).toEqual([]);
    expect(timers.length).toBeGreaterThan(0);
  });

  test("rpc before auth_ok rejects with 'not connected'", async () => {
    const { client, sockets } = harness("K");
    sockets[0]!.open();
    const error = await client.rpc("sessions").catch((e: unknown) => e);
    expect((error as RpcError).message).toBe("not connected");
    const adminError = await client.admin("status.get").catch((e: unknown) => e);
    expect((adminError as RpcError).message).toBe("not connected");
  });
});
