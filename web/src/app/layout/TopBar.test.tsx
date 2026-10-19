import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";

import type { AgentRunView } from "@core/agents/activity";

import { PAGES } from "@/app/routes";
import { mountPage, stubMatchMedia, TEST_HELLO } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { act, cleanup, screen } = await import("@testing-library/react");
const { TopBar } = await import("@/app/layout/TopBar");

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

const page = (id: string) => PAGES.find((p) => p.id === id)!;
const run = (id: string, over: Partial<AgentRunView> = {}): AgentRunView => ({
  id,
  kind: "specialist",
  agent: `spec-${id}`,
  model: "m",
  state: "working",
  startedAt: 0,
  session: { id: TEST_HELLO.sessionId },
  ...over,
});

describe("TopBar: agents working", () => {
  test("the chat's header counts the specialists working for this conversation only", async () => {
    const { socket } = await mountPage(() => createElement(TopBar, { page: page("chat") }), {});
    expect(screen.queryByText(/working$/)).toBeNull();
    await act(async () => socket.deliver({ t: "agents", activity: { running: [run("1"), run("2", { session: { id: "elsewhere" } }), run("3", { kind: "chief" })], last: [] } }));
    expect(screen.getByText("1 agent working")).toBeTruthy();
    await act(async () => socket.deliver({ t: "agent", event: { type: "start", run: run("4") } }));
    expect(screen.getByText("2 agents working")).toBeTruthy();
    await act(async () => socket.deliver({ t: "agent", event: { type: "end", run: { id: "1", kind: "specialist", agent: "spec-1", ok: true, result: "", startedAt: 0, endedAt: 1, session: { id: TEST_HELLO.sessionId } } } }));
    await act(async () => socket.deliver({ t: "agent", event: { type: "end", run: { id: "4", kind: "specialist", agent: "spec-4", ok: true, result: "", startedAt: 0, endedAt: 1, session: { id: TEST_HELLO.sessionId } } } }));
    expect(screen.queryByText(/working$/)).toBeNull();
  });

  test("other pages don't show it", async () => {
    const { socket } = await mountPage(() => createElement(TopBar, { page: page("skills") }), {});
    await act(async () => socket.deliver({ t: "agents", activity: { running: [run("1")], last: [] } }));
    expect(screen.queryByText(/working$/)).toBeNull();
  });
});
