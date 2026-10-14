import { describe, expect, test } from "bun:test";

import type { ClientMessage, ServerMessage } from "@core/web/protocol";

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

function setup() {
  let socket: FakeSocket | null = null;
  const client = new TcodeClient({
    url: "ws://test/ws",
    socket: () => (socket = new FakeSocket()),
    setTimer: () => null,
    clearTimer: () => {},
  });
  let clock = 0;
  const store = createAppStore({ client, now: () => clock });
  store.start();
  socket!.open();
  return { store, socket: socket!, tick: (ms: number) => (clock += ms) };
}

describe("createAppStore", () => {
  test("sendPrompt shows the user's text, runs the turn and resolves with its end reason", async () => {
    const { store, socket, tick } = setup();
    let notified = 0;
    store.subscribe(() => notified++);
    const done = store.sendPrompt("expanded prompt", { display: "/review a.ts" });
    expect(store.getState().transcript.done.at(-1)).toMatchObject({ kind: "user", text: "/review a.ts" });
    expect(socket.sent[0]).toEqual({ t: "rpc", id: 1, method: "prompt", params: { text: "expanded prompt", display: "/review a.ts" } });

    socket.deliver({ t: "event", event: { type: "text", delta: "ok" } });
    tick(8_000);
    socket.deliver({ t: "event", event: { type: "turn_end", reason: "end_turn" } });
    socket.deliver({ t: "rpc_result", id: 1, ok: true, result: "end_turn" });
    expect(await done).toBe("end_turn");
    expect(store.getState().transcript.done.map((i) => i.kind)).toEqual(["user", "assistant", "turn_done"]);
    expect(notified).toBeGreaterThan(0);
  });

  test("a busy refusal resolves null quietly; other failures toast", async () => {
    const { store, socket } = setup();
    const busy = store.sendPrompt("one");
    socket.deliver({ t: "rpc_result", id: 1, ok: false, error: "busy" });
    expect(await busy).toBeNull();
    expect(store.getState().toasts).toEqual([]);

    const broken = store.sendPrompt("two");
    socket.deliver({ t: "rpc_result", id: 2, ok: false, error: "no model" });
    expect(await broken).toBeNull();
    expect(store.getState().toasts[0]).toMatchObject({ tone: "error", description: "no model" });
  });

  test("answering a permission ask sends it and removes the ask", () => {
    const { store, socket } = setup();
    socket.deliver({ t: "ask", id: 5, prompt: { toolName: "Bash", kind: "exec", summary: "ls", input: {} } });
    expect(store.getState().asks).toHaveLength(1);
    store.answerPermission(5, { kind: "deny", feedback: "not now" });
    expect(socket.sent.at(-1)).toEqual({ t: "permission", id: 5, answer: { kind: "deny", feedback: "not now" } });
    expect(store.getState().asks).toEqual([]);
  });
});

const HELLO = { version: "1", cwd: "/r", sessionId: "s", modes: ["default"], commands: [{ name: "review", description: "Review", argumentHint: "[path]" }], history: [] } as const;
const IDLE = { model: "m", effort: "high", mode: "default", busy: false, contextTokens: 0, turns: 0 } as const;

function ready() {
  const ctx = setup();
  ctx.socket.deliver({ t: "hello", server: { ...HELLO, modes: [...HELLO.modes], commands: [...HELLO.commands], history: [] } });
  ctx.socket.deliver({ t: "state", state: IDLE });
  return ctx;
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const lastRpc = (socket: FakeSocket) => socket.sent.filter((m) => m.t === "rpc").at(-1) as Extract<ClientMessage, { t: "rpc" }>;

describe("runInput and the queue", () => {
  test("a queued message runs once the turn ends and this tab's prompt resolves", async () => {
    const { store, socket } = ready();
    void store.runInput("first");
    expect(store.getState().sending).toBe(true);
    store.enqueue("second");
    socket.deliver({ t: "state", state: { ...IDLE, busy: true } });
    await flushAsync();
    expect(socket.sent.filter((m) => m.t === "rpc")).toHaveLength(1);

    socket.deliver({ t: "event", event: { type: "turn_end", reason: "end_turn" } });
    socket.deliver({ t: "state", state: IDLE });
    await flushAsync();
    expect(socket.sent.filter((m) => m.t === "rpc")).toHaveLength(1);

    socket.deliver({ t: "rpc_result", id: 1, ok: true, result: "end_turn" });
    await flushAsync();
    expect(lastRpc(socket)).toMatchObject({ method: "prompt", params: { text: "second" } });
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().transcript.done.filter((i) => i.kind === "user").map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["first", "second"]);
  });

  test("interrupting pauses the queue until the user resumes it", async () => {
    const { store, socket } = ready();
    void store.runInput("first");
    store.enqueue("later");
    void store.interrupt();
    expect(store.getState().queuePaused).toBe(true);
    socket.deliver({ t: "rpc_result", id: 1, ok: true, result: "aborted" });
    socket.deliver({ t: "rpc_result", id: 2, ok: true, result: null });
    await flushAsync();
    expect(socket.sent.filter((m) => m.t === "rpc" && m.method === "prompt")).toHaveLength(1);
    store.setQueuePaused(false);
    await flushAsync();
    expect(lastRpc(socket)).toMatchObject({ method: "prompt", params: { text: "later" } });
  });

  test("a busy refusal takes the row back and requeues the message at the front", async () => {
    const { store, socket } = ready();
    store.enqueue("waiting");
    const run = store.runInput("mine");
    // runInput started before the drain could: the queued message is still there.
    socket.deliver({ t: "state", state: { ...IDLE, busy: true } });
    socket.deliver({ t: "rpc_result", id: 1, ok: false, error: "busy" });
    await run;
    expect(store.getState().queue.map((q) => q.text)).toEqual(["mine", "waiting"]);
    expect(store.getState().transcript.done).toEqual([]);
    expect(store.getState().toasts).toEqual([]);
  });

  test("prompt commands send their prompt and show what was typed", async () => {
    const { store, socket } = ready();
    void store.runInput("/init");
    const rpc = lastRpc(socket);
    expect(rpc.method).toBe("prompt");
    expect((rpc.params as { text: string; display: string }).display).toBe("/init");
    expect((rpc.params as { text: string }).text).toContain("TROPOS.md");
    expect(store.getState().transcript.done.at(-1)).toMatchObject({ kind: "user", text: "/init" });
  });

  test("custom commands go to the server in one prompt, with the typed text shown", async () => {
    const { store, socket } = ready();
    const run = store.runInput("/review src/a.ts");
    expect(lastRpc(socket)).toMatchObject({ method: "prompt", params: { text: "", display: "/review src/a.ts", command: { name: "review", args: "src/a.ts" } } });
    expect(store.getState().transcript.done.at(-1)).toMatchObject({ kind: "user", text: "/review src/a.ts" });
    socket.deliver({ t: "rpc_result", id: 1, ok: true, result: "end_turn" });
    await run;
    expect(store.getState().sending).toBe(false);
  });

  test("a failed expansion takes the row back, toasts, and runs nothing", async () => {
    const { store, socket } = ready();
    const run = store.runInput("/review");
    socket.deliver({ t: "rpc_result", id: 1, ok: false, error: "/review: command file missing" });
    await run;
    expect(store.getState().toasts[0]).toMatchObject({ tone: "error", title: "/review did not run", description: "/review: command file missing" });
    expect(store.getState().transcript.done.some((i) => i.kind === "user" && i.text === "/review")).toBe(false);
  });
});

describe("demo mode", () => {
  test("the fake server says hello and answers RPCs", async () => {
    const store = createAppStore({ demo: true });
    expect(store.demo).toBe(true);
    const hello = new Promise<void>((resolve) => {
      const off = store.subscribe(() => {
        if (store.getState().hello) {
          off();
          resolve();
        }
      });
    });
    store.start();
    await hello;
    const state = store.getState();
    expect(state.connection.status).toBe("open");
    expect(state.transcript.done[0]).toMatchObject({ kind: "user" });

    const sessions = await store.rpc("sessions");
    expect(sessions.length).toBeGreaterThan(2);
    const panel = await store.rpc("panel", "mcp");
    expect(panel.sections[0]?.items.some((i) => i.status === "error")).toBe(true);
    const undo = await store.rpc("undo");
    expect(undo.ok).toBe(true);
    store.stop();
    expect(store.getState().connection.status).toBe("closed");
  });

  test("the demo agent has an identity, a learned panel, and /learned undo answers", async () => {
    const store = createAppStore({ demo: true });
    const hello = new Promise<void>((resolve) => {
      const off = store.subscribe(() => {
        if (store.getState().hello) {
          off();
          resolve();
        }
      });
    });
    store.start();
    await hello;
    expect(store.getState().hello?.identity).toEqual({ name: "Nova", emoji: "🦊" });

    const learned = await store.rpc("panel", "learned");
    expect(learned.title).toBe("Learned");
    const items = learned.sections.flatMap((s) => s.items);
    expect(items.map((i) => i.key)).toEqual(["l3", "l2", "l1"]);
    expect(items.some((i) => i.label.startsWith("identity:"))).toBe(true);
    expect(learned.empty).toContain("Nothing learned yet");

    const undone = await store.rpc("learned.undo", undefined);
    expect(undone.summary).toContain("bun-testing");
    store.stop();
    expect(store.getState().connection.status).toBe("closed");
  });
});
