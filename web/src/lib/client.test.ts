import { describe, expect, test } from "bun:test";

import type { ClientMessage, ServerMessage } from "@core/web/protocol";

import { backoffDelay, RpcError, TcodeClient, type ClientEvent, type SocketLike } from "@/lib/client";

/** A scriptable WebSocket stand-in. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  // test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(message: ServerMessage | string): void {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const events: ClientEvent[] = [];
  const client = new TcodeClient({
    url: "ws://127.0.0.1:4317/ws",
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const i = timers.indexOf(handle as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  client.subscribe((e) => events.push(e));
  const last = () => sockets.at(-1)!;
  const fire = () => {
    const timer = timers.shift();
    if (!timer) throw new Error("no timer scheduled");
    timer.fn();
    return timer.ms;
  };
  return { client, sockets, timers, events, last, fire };
}

const statuses = (events: ClientEvent[]) => events.filter((e) => e.type === "status").map((e) => (e.type === "status" ? `${e.status}:${e.attempt}` : ""));

describe("TcodeClient", () => {
  test("connects to the given url and reports status", () => {
    const h = harness();
    h.client.connect();
    expect(h.last().url).toBe("ws://127.0.0.1:4317/ws");
    expect(h.client.status).toBe("connecting");
    h.last().open();
    expect(h.client.status).toBe("open");
    expect(statuses(h.events)).toEqual(["connecting:0", "open:0"]);
  });

  test("correlates RPC results by id, even out of order", async () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    const sessions = h.client.rpc("sessions");
    const panel = h.client.rpc("panel", "skills");
    const [first, second] = h.last().sent;
    expect(first).toEqual({ t: "rpc", id: 1, method: "sessions" });
    expect(second).toEqual({ t: "rpc", id: 2, method: "panel", params: "skills" });
    h.last().deliver({ t: "rpc_result", id: 2, ok: true, result: { title: "Skills", sections: [] } });
    h.last().deliver({ t: "rpc_result", id: 1, ok: true, result: [] });
    expect(await panel).toEqual({ title: "Skills", sections: [] });
    expect(await sessions).toEqual([]);
  });

  test("server errors reject with RpcError carrying the message", async () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    const prompt = h.client.rpc("prompt", { text: "hi" });
    h.last().deliver({ t: "rpc_result", id: 1, ok: false, error: "busy" });
    const error = await prompt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).message).toBe("busy");
    expect((error as RpcError).method).toBe("prompt");
  });

  test("RPCs fail fast while not connected", async () => {
    const h = harness();
    await expect(h.client.rpc("undo")).rejects.toThrow("not connected");
    h.client.connect();
    await expect(h.client.rpc("undo")).rejects.toThrow("not connected");
  });

  test("forwards server messages to subscribers and ignores junk", () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().deliver("not json");
    h.last().deliver(JSON.stringify({ nope: true }));
    h.last().deliver({ t: "rpc_result", id: 99, ok: true, result: null });
    h.last().deliver({ t: "ask_closed", id: 4 });
    const messages = h.events.filter((e) => e.type === "message");
    expect(messages).toEqual([{ type: "message", message: { t: "ask_closed", id: 4 } }]);
  });

  test("answers permission asks on the socket", () => {
    const h = harness();
    h.client.connect();
    expect(h.client.answerPermission(1, { kind: "allow" })).toBe(false);
    h.last().open();
    expect(h.client.answerPermission(7, { kind: "allow_always", rule: "Bash(ls:*)" })).toBe(true);
    expect(h.last().sent).toEqual([{ t: "permission", id: 7, answer: { kind: "allow_always", rule: "Bash(ls:*)" } }]);
  });

  test("a dropped socket fails pending RPCs and reconnects with backoff", async () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    const pending = h.client.rpc("sessions");
    h.last().drop();
    await expect(pending).rejects.toThrow("connection lost");
    expect(h.client.status).toBe("reconnecting");
    expect(h.client.reconnectAttempt).toBe(1);

    expect(h.fire()).toBe(500);
    expect(h.sockets).toHaveLength(2);
    h.last().drop(); // the server is still down
    expect(h.fire()).toBe(1000);
    h.last().drop();
    expect(h.fire()).toBe(2000);
    h.last().open();
    expect(h.client.status).toBe("open");
    expect(h.client.reconnectAttempt).toBe(0);
    expect(statuses(h.events)).toEqual(["connecting:0", "open:0", "reconnecting:1", "reconnecting:1", "reconnecting:2", "reconnecting:2", "reconnecting:3", "reconnecting:3", "open:0"]);

    // After a successful open the backoff starts over.
    h.last().drop();
    expect(h.fire()).toBe(500);
  });

  test("close() stops for good", async () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    const pending = h.client.rpc("sessions");
    h.client.close();
    await expect(pending).rejects.toThrow("connection closed");
    expect(h.client.status).toBe("closed");
    expect(h.last().closed).toBe(true);
    expect(h.timers).toHaveLength(0);
  });

  test("backoff doubles up to the cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n))).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
});
