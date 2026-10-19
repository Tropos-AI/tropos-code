import { describe, expect, test } from "bun:test";

import type { AgentRunEnd, AgentRunView } from "@core/agents/activity";

import { applyActivity, emptyActivity, lastRunOf, liveState, runsOf, workingInSession } from "@/lib/agent-activity";

const view = (over: Partial<AgentRunView> = {}): AgentRunView => ({
  id: "run-1",
  kind: "specialist",
  agent: "reviewer",
  model: "claude-sonnet-5-5",
  state: "working",
  startedAt: 1_000,
  session: { id: "s1", chat: "Dashboard" },
  ...over,
});
const end = (over: Partial<AgentRunEnd> = {}): AgentRunEnd => ({
  id: "run-1",
  kind: "specialist",
  agent: "reviewer",
  ok: true,
  result: "LGTM",
  startedAt: 1_000,
  endedAt: 9_000,
  session: { id: "s1", chat: "Dashboard" },
  ...over,
});

describe("applyActivity", () => {
  test("start adds a run, delta patches it (null clears), end moves it to the agent's last run", () => {
    let s = applyActivity(emptyActivity, { type: "start", run: view() });
    expect(runsOf(s, "specialist", "reviewer")).toHaveLength(1);
    s = applyActivity(s, { type: "delta", id: "run-1", tool: "Bash: bun test", text: null });
    expect(s.running[0]).toMatchObject({ tool: "Bash: bun test", text: null });
    s = applyActivity(s, { type: "delta", id: "run-1", state: "waiting" });
    expect(liveState(runsOf(s, "specialist", "reviewer"))).toBe("waiting");
    s = applyActivity(s, { type: "end", run: end() });
    expect(s.running).toEqual([]);
    expect(liveState(runsOf(s, "specialist", "reviewer"))).toBe("idle");
    expect(lastRunOf(s, "specialist", "reviewer")?.result).toBe("LGTM");
  });

  test("a delta or end for an unknown run changes nothing it shouldn't; a repeated start replaces", () => {
    const s = applyActivity(emptyActivity, { type: "delta", id: "nope", text: "x" });
    expect(s).toBe(emptyActivity);
    const twice = applyActivity(applyActivity(s, { type: "start", run: view() }), { type: "start", run: view({ model: "other" }) });
    expect(twice.running).toHaveLength(1);
    expect(twice.running[0]!.model).toBe("other");
  });

  test("the last run keeps one entry per agent, newest first", () => {
    let s = applyActivity(emptyActivity, { type: "end", run: end({ id: "a", result: "old" }) });
    s = applyActivity(s, { type: "end", run: end({ id: "b", kind: "chief", agent: "Tropos", result: "chief" }) });
    s = applyActivity(s, { type: "end", run: end({ id: "c", result: "new" }) });
    expect(s.last.map((r) => r.result)).toEqual(["new", "chief"]);
  });
});

describe("selectors", () => {
  test("waiting wins over working; any chief run counts for the chief", () => {
    const s = { running: [view({ id: "1", kind: "chief", agent: "Ada" }), view({ id: "2", kind: "chief", agent: "Ada", state: "waiting" })], last: [] };
    expect(runsOf(s, "chief")).toHaveLength(2);
    expect(liveState(runsOf(s, "chief"))).toBe("waiting");
  });

  test("workingInSession counts this conversation's specialists only", () => {
    const s = {
      running: [view({ id: "1" }), view({ id: "2", agent: "writer" }), view({ id: "3", kind: "chief" }), view({ id: "4", session: { id: "other" } })],
      last: [],
    };
    expect(workingInSession(s, "s1")).toBe(2);
    expect(workingInSession(s, undefined)).toBe(0);
  });
});
