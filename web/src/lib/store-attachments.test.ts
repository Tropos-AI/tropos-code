import { describe, expect, test } from "bun:test";

import type { Attachment } from "@core/attachments/attachments";
import type { ClientMessage, ServerMessage, SessionState } from "@core/web/protocol";

import { appReducer, initialAppState } from "@/lib/app-state";
import { TcodeClient, type SocketLike } from "@/lib/client";
import { createAppStore } from "@/lib/store";

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
}

const IDLE: SessionState = { model: "m", effort: "high", mode: "default", busy: false, contextTokens: 0, turns: 0 };

function setup() {
  let socket: FakeSocket | null = null;
  const client = new TcodeClient({ url: "ws://test/ws", socket: () => (socket = new FakeSocket()), setTimer: () => null, clearTimer: () => {} });
  const store = createAppStore({ client, now: () => 0 });
  store.start();
  socket!.open();
  socket!.deliver({ t: "hello", server: { version: "1", cwd: "/w", sessionId: "s", modes: ["default"], commands: [], history: [] } });
  socket!.deliver({ t: "state", state: IDLE });
  return { store, socket: socket! };
}

const image: Attachment = { kind: "image", name: "a.png", mediaType: "image/png", data: "QUJD" };
const file: Attachment = { kind: "text", name: "pasted-1.txt", text: "hi" };
const rpcs = (socket: FakeSocket) => socket.sent.filter((m): m is Extract<ClientMessage, { t: "rpc" }> => m.t === "rpc" && m.method === "prompt");

describe("attachments in the store", () => {
  test("runInput sends the attachments in wire form and shows them on the user's row", () => {
    const { store, socket } = setup();
    void store.runInput("look", [image, file]);
    expect(rpcs(socket)[0]!.params).toEqual({
      text: "look",
      attachments: [
        { name: "a.png", mediaType: "image/png", data: "QUJD" },
        { name: "pasted-1.txt", mediaType: "text/plain", data: btoa("hi") },
      ],
    });
    expect(store.getState().transcript.done.at(-1)).toMatchObject({ kind: "user", text: "look", attachments: [image, file] });
  });

  test("attachments without text are sent", () => {
    const { store, socket } = setup();
    void store.runInput("", [image]);
    expect(rpcs(socket)[0]!.params).toMatchObject({ text: "", attachments: [{ name: "a.png" }] });
  });

  test("a custom command takes the attachments along to the turn it expands to", () => {
    const { store, socket } = setup();
    socket.deliver({ t: "hello", server: { version: "1", cwd: "/w", sessionId: "s", modes: ["default"], commands: [{ name: "review", description: "r" }], history: [] } });
    void store.runInput("/review this", [image]);
    expect(rpcs(socket)[0]!.params).toMatchObject({ command: { name: "review", args: "this" }, attachments: [{ name: "a.png" }] });
  });

  test("a busy refusal puts the message back in the queue with its attachments", async () => {
    const { store, socket } = setup();
    const run = store.runInput("look", [image]);
    const sent = rpcs(socket)[0]!;
    // Another tab's turn holds the session.
    socket.deliver({ t: "state", state: { ...IDLE, busy: true } });
    socket.deliver({ t: "rpc_result", id: sent.id, ok: false, error: "busy" });
    await run;
    expect(store.getState().queue).toEqual([{ id: 1, text: "look", attachments: [image] }]);
  });
});

describe("attachments in the reducer", () => {
  test("a queued message may be attachments alone; an empty one is still dropped", () => {
    let s = appReducer(initialAppState, { type: "queue_add", text: "", attachments: [image] });
    expect(s.queue).toEqual([{ id: 1, text: "", attachments: [image] }]);
    s = appReducer(s, { type: "queue_add", text: "  " });
    expect(s.queue).toHaveLength(1);
  });

  test("another tab's message arrives with its attachments", () => {
    const s = appReducer(initialAppState, { type: "server", message: { t: "user", text: "look", attachments: [image] }, now: 0 });
    expect(s.transcript.done.at(-1)).toMatchObject({ kind: "user", text: "look", attachments: [image] });
  });
});
