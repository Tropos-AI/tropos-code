import { describe, expect, test } from "bun:test";
import { AgentActivity, oneLine, tailLines, type ActivityEvent } from "./activity";

/** A clock and a timer queue the test advances by hand. */
function fakeTime() {
  let now = 1_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.live && x.at <= now)) {
        t.live = false;
        t.fn();
      }
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

function setup() {
  const time = fakeTime();
  const activity = new AgentActivity({ now: time.now, schedule: time.schedule, intervalMs: 100 });
  const seen: ActivityEvent[] = [];
  activity.subscribe((e) => seen.push(e));
  return { time, activity, seen };
}

describe("AgentActivity", () => {
  test("a run starts, reports its tool and text, waits for approval and ends with a one-line result", () => {
    const { time, activity, seen } = setup();
    const run = activity.start({ kind: "specialist", agent: "reviewer", model: "claude-sonnet-5-5", sessionId: "s1", task: "review the diff" });
    expect(seen[0]).toMatchObject({ type: "start", run: { id: run.id, kind: "specialist", agent: "reviewer", model: "claude-sonnet-5-5", state: "working", task: "review the diff", session: { id: "s1" } } });
    expect(activity.snapshot().running).toHaveLength(1);

    run.tool("Bash", "bun test");
    expect(seen[1]).toEqual({ type: "delta", id: run.id, tool: "Bash: bun test", text: null });
    time.advance(100);
    run.waiting(true);
    expect(seen[2]).toEqual({ type: "delta", id: run.id, state: "waiting" });
    expect(activity.snapshot().running[0]!.state).toBe("waiting");

    time.advance(5_000);
    run.end(true, "All 12 tests pass.\nDetails follow");
    const end = seen.at(-1)!;
    expect(end).toMatchObject({ type: "end", run: { id: run.id, agent: "reviewer", ok: true, result: "All 12 tests pass.", endedAt: 6_100 } });
    expect(activity.snapshot()).toMatchObject({ running: [], last: [{ id: run.id, result: "All 12 tests pass." }] });
    // Ending twice does nothing.
    run.end(false, "again");
    expect(seen.filter((e) => e.type === "end")).toHaveLength(1);
  });

  test("updates are throttled per run: the first goes at once, the rest are merged into one per interval", () => {
    const { time, activity, seen } = setup();
    const run = activity.start({ kind: "chief", agent: "Tropos", model: "m", sessionId: "s1", chat: "Telegram" });
    for (let i = 0; i < 50; i++) run.text(`word${i} `);
    const deltas = () => seen.filter((e) => e.type === "delta");
    expect(deltas()).toHaveLength(1);
    expect(time.pending()).toBe(1);
    time.advance(100);
    expect(deltas()).toHaveLength(2);
    expect(deltas()[1]).toMatchObject({ text: expect.stringContaining("word49") });
    // Nothing new: no timer, no event.
    time.advance(500);
    expect(deltas()).toHaveLength(2);
    // An end drops what is still pending: the end carries the outcome.
    run.text("more");
    run.text("and more");
    run.end(true, "done");
    time.advance(500);
    expect(seen.at(-1)!.type).toBe("end");
    expect(deltas()).toHaveLength(3);
  });

  test("text keeps only the last lines, clipped; a tool call starts a fresh text", () => {
    const { activity } = setup();
    const run = activity.start({ kind: "chief", agent: "Tropos", model: "m", sessionId: "s1" });
    run.text(`one\ntwo\n\nthree ${"x".repeat(400)}`);
    const text = activity.snapshot().running[0]!.text!;
    expect(text.split("\n")).toHaveLength(2);
    expect(text.startsWith("two\n…")).toBe(true);
    expect(text.length).toBeLessThan(200);
    run.tool("Read", "src/a.ts");
    run.text("after");
    expect(activity.snapshot().running[0]).toMatchObject({ text: "after", tool: null });
  });

  test("a specialist's run names the chat its session's chief runs in", () => {
    const { activity } = setup();
    activity.start({ kind: "chief", agent: "Tropos", model: "m", sessionId: "s1", chat: "Telegram" });
    const spec = activity.start({ kind: "specialist", agent: "reviewer", model: "m", sessionId: "s1" });
    expect(activity.snapshot().running.find((r) => r.id === spec.id)!.session).toEqual({ id: "s1", chat: "Telegram" });
  });

  test("a listener that throws never breaks the run; unsubscribe stops events", () => {
    const { activity } = setup();
    const off = activity.subscribe(() => {
      throw new Error("closing socket");
    });
    const run = activity.start({ kind: "chief", agent: "Tropos", model: "m", sessionId: "s1" });
    run.text("hi");
    off();
    run.end(true, "ok");
    expect(activity.snapshot().last).toHaveLength(1);
  });

  test("the last run is kept per agent, newest first, and bounded", () => {
    const { activity } = setup();
    for (let i = 0; i < 3; i++) activity.start({ kind: "specialist", agent: "a", model: "m", sessionId: "s" }).end(true, `run ${i}`);
    activity.start({ kind: "chief", agent: "Tropos", model: "m", sessionId: "s" }).end(false, "stopped");
    expect(activity.snapshot().last.map((r) => [r.agent, r.result])).toEqual([
      ["Tropos", "stopped"],
      ["a", "run 2"],
    ]);
  });
});

describe("text helpers", () => {
  test("oneLine takes the first non-empty line, collapsed and clipped", () => {
    expect(oneLine("\n  hello   world \nnext", 100)).toBe("hello world");
    expect(oneLine("abcdef", 4)).toBe("abc…");
    expect(oneLine("", 4)).toBe("");
  });
  test("tailLines keeps the last two non-empty lines, each clipped from the left", () => {
    expect(tailLines("a\nb\nc")).toBe("b\nc");
    expect(tailLines(`${"y".repeat(300)}`)).toBe(`…${"y".repeat(159)}`);
  });
});
