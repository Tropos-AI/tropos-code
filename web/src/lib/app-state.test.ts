import { describe, expect, test } from "bun:test";

import type { AgentEvent, PermissionPrompt } from "@core/agent/events";
import type { HelloInfo, ServerMessage, SessionState } from "@core/web/protocol";

import { appReducer, initialAppState, isBusy, MAX_TOASTS, nextQueued, type AppAction, type AppState } from "@/lib/app-state";

const HELLO: HelloInfo = {
  version: "0.5.1",
  cwd: "/repo",
  sessionId: "s1",
  modes: ["default", "acceptEdits", "plan"],
  commands: [],
  history: [
    { role: "user", content: "<context>injected</context>" },
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/repo/a.ts" } }] },
  ],
};

const STATE: SessionState = { model: "m", effort: "high", mode: "default", busy: false, contextTokens: 100, contextWindow: 1000, totalCostUsd: 0.1, turns: 0 };

const PROMPT: PermissionPrompt = { toolName: "Bash", kind: "exec", summary: "rm -rf build", input: { command: "rm -rf build" } };

function server(message: ServerMessage, now = 0): AppAction {
  return { type: "server", message, now };
}

function event(e: AgentEvent, now = 0): AppAction {
  return server({ t: "event", event: e }, now);
}

function run(actions: AppAction[], from: AppState = initialAppState): AppState {
  return actions.reduce(appReducer, from);
}

describe("hello", () => {
  test("rebuilds the transcript from history and drops injected blocks", () => {
    const s = run([server({ t: "hello", server: HELLO })]);
    expect(s.hello?.sessionId).toBe("s1");
    expect(s.helloSeq).toBe(1);
    expect(s.transcript.done.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(s.transcript.done[0]).toMatchObject({ kind: "user", text: "fix the bug" });
    expect(s.transcript.done[2]).toMatchObject({ kind: "tool", name: "Read", summary: "/repo/a.ts", status: "done" });
  });

  test("a second hello (clear/resume) replaces the transcript, clears asks and the running turn", () => {
    const s = run([
      server({ t: "hello", server: HELLO }),
      server({ t: "ask", id: 1, prompt: PROMPT }),
      event({ type: "text", delta: "hi" }, 10),
      server({ t: "hello", server: { ...HELLO, sessionId: "s2", history: [] } }),
    ]);
    expect(s.hello?.sessionId).toBe("s2");
    expect(s.helloSeq).toBe(2);
    expect(s.transcript.done).toEqual([]);
    expect(s.transcript.live).toEqual([]);
    expect(s.asks).toEqual([]);
    expect(s.turn).toBeNull();
  });
});

describe("events", () => {
  test("text deltas stream into one live assistant item, tools settle into done", () => {
    const s = run([
      server({ t: "hello", server: { ...HELLO, history: [] } }),
      event({ type: "text", delta: "Hel" }),
      event({ type: "text", delta: "lo" }),
      event({ type: "tool_start", id: "t1", name: "Bash", summary: "ls", input: { command: "ls" } }),
      event({ type: "tool_progress", id: "t1", text: "listing" }),
    ]);
    expect(s.transcript.done.map((i) => i.kind)).toEqual(["assistant"]);
    expect(s.transcript.done[0]).toMatchObject({ text: "Hello" });
    expect(s.transcript.live[0]).toMatchObject({ kind: "tool", status: "running", progress: "listing", progressCount: 1 });

    const ended = run([event({ type: "tool_end", id: "t1", name: "Bash", status: "done", output: { content: "a\nb", summary: "ok" } })], s);
    expect(ended.transcript.live).toEqual([]);
    expect(ended.transcript.done.at(-1)).toMatchObject({ kind: "tool", status: "done" });
  });

  test("turn_end flushes and adds the footer for turns longer than 5s", () => {
    const s = run([
      { type: "prompt_sent", text: "go", now: 1_000 },
      event({ type: "text", delta: "done" }, 2_000),
      event({ type: "turn_end", reason: "end_turn" }, 13_400),
    ]);
    expect(s.transcript.live).toEqual([]);
    expect(s.transcript.done.map((i) => i.kind)).toEqual(["user", "assistant", "turn_done"]);
    expect(s.transcript.done.at(-1)).toMatchObject({ kind: "turn_done", seconds: 12 });
    expect(s.turn).toBeNull();
  });

  test("short turns get no footer", () => {
    const s = run([{ type: "prompt_sent", text: "hi", now: 0 }, event({ type: "text", delta: "yo" }, 500), event({ type: "turn_end", reason: "end_turn" }, 3_000)]);
    expect(s.transcript.done.map((i) => i.kind)).toEqual(["user", "assistant"]);
  });

  test("a tab that joins mid-turn starts its clock at the first event", () => {
    const s = run([event({ type: "thinking", delta: "hmm" }, 50_000), event({ type: "turn_end", reason: "end_turn" }, 60_000)]);
    expect(s.transcript.done.at(-1)).toMatchObject({ kind: "turn_done", seconds: 10 });
  });

  test("busy state starts the turn clock; usage updates context and cost", () => {
    let s = run([server({ t: "state", state: { ...STATE, busy: true } }, 7_000)]);
    expect(s.turn).toEqual({ startedAt: 7_000 });
    s = run([event({ type: "usage", inputTokens: 10, outputTokens: 5, contextTokens: 640, costUsd: 0.02, totalCostUsd: 0.12 }, 8_000)], s);
    expect(s.session).toMatchObject({ contextTokens: 640, totalCostUsd: 0.12 });
    expect(s.turn).toEqual({ startedAt: 7_000 });
  });

  test("notices land in the transcript", () => {
    const s = run([event({ type: "notice", level: "warn", text: "careful" }), event({ type: "turn_end", reason: "end_turn" })]);
    expect(s.transcript.done[0]).toMatchObject({ kind: "notice", level: "warn", text: "careful" });
  });
});

describe("permission asks", () => {
  test("arrive in order, ignore duplicates, close remotely or when answered here", () => {
    let s = run([server({ t: "ask", id: 1, prompt: PROMPT }), server({ t: "ask", id: 2, prompt: { ...PROMPT, summary: "b" } }), server({ t: "ask", id: 1, prompt: PROMPT })]);
    expect(s.asks.map((a) => a.id)).toEqual([1, 2]);
    s = run([server({ t: "ask_closed", id: 1 })], s);
    expect(s.asks.map((a) => a.id)).toEqual([2]);
    s = run([{ type: "ask_answered", id: 2 }], s);
    expect(s.asks).toEqual([]);
    // The server's ask_closed after a local answer is a no-op.
    expect(run([server({ t: "ask_closed", id: 2 })], s)).toBe(s);
  });

  test("are dropped when the connection drops (the server re-sends open asks)", () => {
    const s = run([{ type: "connection", status: "open", attempt: 0 }, server({ t: "ask", id: 3, prompt: PROMPT }), { type: "connection", status: "reconnecting", attempt: 1 }]);
    expect(s.asks).toEqual([]);
  });
});

describe("connection", () => {
  test("tracks status, attempts and whether it ever connected", () => {
    let s = run([{ type: "connection", status: "connecting", attempt: 0 }]);
    expect(s.connection).toEqual({ status: "connecting", attempt: 0, everOpened: false });
    s = run([{ type: "connection", status: "reconnecting", attempt: 1 }], s);
    expect(s.connection.everOpened).toBe(false);
    s = run([{ type: "connection", status: "open", attempt: 0 }], s);
    expect(s.connection).toEqual({ status: "open", attempt: 0, everOpened: true });
    s = run([{ type: "connection", status: "reconnecting", attempt: 2 }], s);
    expect(s.connection).toEqual({ status: "reconnecting", attempt: 2, everOpened: true });
  });
});

describe("toasts", () => {
  test("get ids, are capped, and can be dismissed", () => {
    const pushes: AppAction[] = Array.from({ length: MAX_TOASTS + 2 }, (_, i) => ({ type: "toast", tone: "info", title: `t${i}` }));
    let s = run(pushes);
    expect(s.toasts).toHaveLength(MAX_TOASTS);
    expect(s.toasts[0]?.title).toBe("t2");
    const id = s.toasts[1]!.id;
    s = run([{ type: "toast_dismiss", id }], s);
    expect(s.toasts.map((t) => t.id)).not.toContain(id);
    expect(run([{ type: "toast_dismiss", id: 999 }], s)).toBe(s);
  });
});

describe("messages from other tabs", () => {
  test("a user message another tab sent becomes a user row and starts the clock", () => {
    const s = run([server({ t: "hello", server: { ...HELLO, history: [] } }), server({ t: "user", text: "from the other tab" }, 4_000)]);
    expect(s.transcript.done.at(-1)).toMatchObject({ kind: "user", text: "from the other tab" });
    expect(s.turn).toEqual({ startedAt: 4_000 });
  });
});

describe("turn clock", () => {
  test("uses the server's turnStartedAt for a tab that joins mid-turn", () => {
    const s = run([server({ t: "state", state: { ...STATE, busy: true, turnStartedAt: 1_000 } }, 9_000), event({ type: "turn_end", reason: "end_turn" }, 21_000)]);
    expect(s.transcript.done.at(-1)).toMatchObject({ kind: "turn_done", seconds: 20 });
  });

  test("an idle state clears the clock and settles anything left live", () => {
    const s = run([server({ t: "state", state: { ...STATE, busy: true } }, 0), event({ type: "notice", level: "info", text: "hook ran" }), server({ t: "state", state: STATE }, 2_000)]);
    expect(s.turn).toBeNull();
    expect(s.transcript.live).toEqual([]);
    expect(s.transcript.done.at(-1)).toMatchObject({ kind: "notice", text: "hook ran" });
  });
});

describe("prompt_unsent", () => {
  test("takes back the optimistic user row", () => {
    const sent = run([{ type: "prompt_sent", text: "hi", now: 0 }]);
    const id = sent.transcript.done[0]!.id;
    const s = run([{ type: "prompt_unsent", itemId: id }], sent);
    expect(s.transcript.done).toEqual([]);
    expect(s.turn).toBeNull();
    expect(run([{ type: "prompt_unsent", itemId: "nope" }], s)).toBe(s);
  });
});

describe("queue", () => {
  const ready = (): AppState =>
    run([{ type: "connection", status: "open", attempt: 0 }, server({ t: "hello", server: { ...HELLO, history: [] } }), server({ t: "state", state: STATE })]);

  test("adds in order with ids, trims, ignores blanks, removes and clears", () => {
    let s = run([
      { type: "queue_add", text: "  one " },
      { type: "queue_add", text: "   " },
      { type: "queue_add", text: "two" },
    ]);
    expect(s.queue).toEqual([
      { id: 1, text: "one" },
      { id: 2, text: "two" },
    ]);
    s = run([{ type: "queue_add", text: "zero", front: true }], s);
    expect(s.queue.map((q) => q.text)).toEqual(["zero", "one", "two"]);
    s = run([{ type: "queue_remove", id: 1 }], s);
    expect(s.queue.map((q) => q.text)).toEqual(["zero", "two"]);
    s = run([{ type: "queue_clear" }], s);
    expect(s.queue).toEqual([]);
  });

  test("pausing needs something queued; adding unpauses; emptying the queue unpauses", () => {
    expect(run([{ type: "queue_pause", paused: true }]).queuePaused).toBe(false);
    let s = run([{ type: "queue_add", text: "a" }, { type: "queue_add", text: "b" }, { type: "queue_pause", paused: true }]);
    expect(s.queuePaused).toBe(true);
    expect(run([{ type: "queue_add", text: "c" }], s).queuePaused).toBe(false);
    s = run([{ type: "queue_remove", id: 1 }], s);
    expect(s.queuePaused).toBe(true);
    s = run([{ type: "queue_remove", id: 2 }], s);
    expect(s.queuePaused).toBe(false);
  });

  test("nextQueued waits for an open, idle, unpaused session with no ask or send in flight", () => {
    const idle = run([{ type: "queue_add", text: "next" }], ready());
    expect(nextQueued(idle)).toEqual({ id: 1, text: "next" });
    expect(nextQueued(run([server({ t: "state", state: { ...STATE, busy: true } })], idle))).toBeNull();
    expect(nextQueued(run([{ type: "sending", sending: true }], idle))).toBeNull();
    expect(nextQueued(run([{ type: "queue_pause", paused: true }], idle))).toBeNull();
    expect(nextQueued(run([server({ t: "ask", id: 1, prompt: PROMPT })], idle))).toBeNull();
    expect(nextQueued(run([{ type: "connection", status: "reconnecting", attempt: 1 }], idle))).toBeNull();
    expect(nextQueued(ready())).toBeNull();
  });

  test("isBusy covers both the server's turn and this tab's send", () => {
    expect(isBusy(ready())).toBe(false);
    expect(isBusy(run([{ type: "sending", sending: true }], ready()))).toBe(true);
    expect(isBusy(run([server({ t: "state", state: { ...STATE, busy: true } })], ready()))).toBe(true);
  });
});
