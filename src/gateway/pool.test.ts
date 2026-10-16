// src/gateway/pool.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { reply, textBlock, toolUseBlock } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { settle } from "../../test/helpers/wait";
import { WebHost } from "../web/host";
import { SessionPool, type HostHandle } from "./pool";
import type { ChatSink } from "./types";
import type { AgentEvent, PermissionPrompt } from "../agent/events";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-pool");
});
afterEach(async () => {
  await removeDir(dir);
});

function setup(steps: Parameters<typeof fakeRuntime>[0] = [], now = { t: 1_000 }) {
  const closed: string[] = [];
  const created: Array<{ key: string; saved: string | undefined }> = [];
  const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();
  let n = 0;
  const pool = new SessionPool({
    statePath: join(dir, "sessions.json"),
    idleMs: 60_000,
    now: () => now.t,
    sweepEveryMs: 0,
    create: async (key, saved): Promise<HostHandle> => {
      created.push({ key, saved });
      const id = `session-${++n}`;
      const runtime = fakeRuntime(steps);
      runtimes.set(key, runtime);
      return { host: new WebHost(runtime), sessionId: () => id, close: async () => void closed.push(key) };
    },
  });
  return { pool, closed, created, now, runtimes };
}

const sink = () => {
  const events: AgentEvent[] = [];
  const asks: Array<{ id: number; prompt: PermissionPrompt }> = [];
  const closedAsks: number[] = [];
  const s: ChatSink = { event: (e) => events.push(e), ask: (id, prompt) => asks.push({ id, prompt }), askClosed: (id) => closedAsks.push(id), state: () => {} };
  return { s, events, asks, closedAsks };
};

describe("open", () => {
  test("one session per chat, shared by every caller, built once even when asked at the same time", async () => {
    const { pool, created } = setup();
    const [a, b] = await Promise.all([pool.open("telegram:1"), pool.open("telegram:1")]);
    expect(a).toBe(b);
    expect(await pool.open("telegram:2")).not.toBe(a);
    expect(created.map((c) => c.key)).toEqual(["telegram:1", "telegram:2"]);
  });

  test("a restarted pool hands the factory the session the chat had", async () => {
    const first = setup();
    await first.pool.open("telegram:1");
    await first.pool.closeAll();
    const second = setup();
    await second.pool.open("telegram:1");
    expect(second.created[0]).toEqual({ key: "telegram:1", saved: "session-1" });
    expect(JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"))).toEqual({ "telegram:1": "session-1" });
  });
});

describe("a chat's session", () => {
  test("runs a turn and streams its events to the attached sink", async () => {
    const { pool } = setup([() => reply([textBlock("hello there")])]);
    const chat = await pool.open("telegram:1");
    const { s, events } = sink();
    chat.attach(s);
    await chat.prompt("hi");
    expect(events.some((e) => e.type === "assistant")).toBe(true);
    expect(chat.state().turns).toBe(1);
  });

  test("a second prompt during a turn is refused with busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { pool } = setup([async () => (await gate, reply([textBlock("late")]))]);
    const chat = await pool.open("telegram:1");
    const running = chat.prompt("first");
    await Bun.sleep(5);
    await expect(chat.prompt("second")).rejects.toThrow("busy");
    release();
    await running;
  });

  test("a permission ask reaches the sink and only allow or deny can answer it", async () => {
    const { pool } = setup([() => reply([toolUseBlock("t1", "Shell", { command: "ls" })], "tool_use"), () => reply([textBlock("done")])]);
    const chat = await pool.open("telegram:1");
    const { s, asks, events } = sink();
    chat.attach(s);
    const turn = chat.prompt("list files");
    await Bun.sleep(20);
    expect(asks).toHaveLength(1);
    // A chat can't grant a standing permission: anything but a plain allow is a deny.
    chat.answer(asks[0]!.id, { kind: "allow_always", rule: "Shell(ls:*)" } as never);
    await turn;
    expect(chat.state().busy).toBe(false);
    const end = events.find((e) => e.type === "tool_end");
    expect(end && end.type === "tool_end" && end.status).not.toBe("done");
  });
});

describe("idle sessions", () => {
  test("a quiet session is closed, a busy or recent one is not", async () => {
    const now = { t: 1_000 };
    const { pool, closed } = setup([], now);
    await pool.open("telegram:1");
    now.t += 30_000;
    await pool.open("telegram:2");
    now.t += 40_000;
    expect(await pool.sweep()).toEqual(["telegram:1"]);
    expect(closed).toEqual(["telegram:1"]);
    expect(pool.keys()).toEqual(["telegram:2"]);
  });

  test("closeAll closes everything", async () => {
    const { pool, closed } = setup();
    await pool.open("telegram:1");
    await pool.open("telegram:2");
    await pool.closeAll();
    expect(closed.sort()).toEqual(["telegram:1", "telegram:2"]);
    expect(pool.keys()).toEqual([]);
  });

  test("a sweep runs alone and never closes a session that was reopened while it ran", async () => {
    const now = { t: 1_000 };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const closed: string[] = [];
    let n = 0;
    const pool = new SessionPool({
      statePath: join(dir, "sessions.json"),
      idleMs: 60_000,
      now: () => now.t,
      sweepEveryMs: 0,
      create: async (key): Promise<HostHandle> => {
        const id = `session-${++n}`;
        return {
          host: new WebHost(fakeRuntime([])),
          sessionId: () => id,
          // The first close (a final review, say) takes a while.
          close: async () => {
            if (id === "session-1") await gate;
            closed.push(id);
          },
        };
      },
    });
    await pool.open("telegram:1");
    await pool.open("telegram:2");
    now.t += 70_000;
    const first = pool.sweep();
    await settle();
    // A second sweep while the first is still closing telegram:1 doesn't start on telegram:2.
    const second = pool.sweep();
    await settle();
    expect(closed).toEqual([]);
    // Meanwhile telegram:2 is closed by someone else (the reaper) and its chat opens a fresh session.
    await pool.close("telegram:2");
    await pool.open("telegram:2");
    release();
    expect(await first).toEqual(["telegram:1"]);
    await second;
    // session-3, the reopened chat, is still open.
    expect(closed).toEqual(["session-2", "session-1"]);
    expect(pool.keys()).toEqual(["telegram:2"]);
  });

  test("close(key, { finalReview: false }) passes the option on", async () => {
    const { pool, runtimes } = setup();
    await pool.open("telegram:1");
    await pool.close("telegram:1", { finalReview: false });
    expect(runtimes.get("telegram:1")!.shutdowns).toEqual([{ finalReview: false }]);
  });

  test("retire closes idle sessions at once and a busy one when its turn ends; the chat resumes its session id", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { pool, closed, created, runtimes } = setup([async () => (await gate, reply([textBlock("slow answer")]))]);
    const busy = await pool.open("telegram:1");
    await pool.open("telegram:2");
    const turn = busy.prompt("long job");
    await Bun.sleep(5);
    // Recently active and still the idle time away from a sweep: retire closes it anyway, without a final review.
    expect(await pool.retire()).toEqual(["telegram:2"]);
    expect(closed).toEqual(["telegram:2"]);
    expect(runtimes.get("telegram:2")!.shutdowns).toEqual([{ finalReview: false }]);
    // The busy one keeps running on what it has, and an ordinary sweep leaves it alone while the turn runs.
    expect(await pool.sweep()).toEqual([]);
    release();
    expect(await turn).toBe("end_turn");
    // Its turn is over: the next sweep closes it though it was active a moment ago.
    expect(await pool.sweep()).toEqual(["telegram:1"]);
    expect(closed).toEqual(["telegram:2", "telegram:1"]);
    // Both chats come back to the session they had.
    await pool.open("telegram:1");
    await pool.open("telegram:2");
    expect(created.slice(2)).toEqual([
      { key: "telegram:1", saved: "session-1" },
      { key: "telegram:2", saved: "session-2" },
    ]);
  });

  test("a retired session whose turn has ended is not handed out again: the next open starts afresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { pool, closed, created } = setup([async () => (await gate, reply([textBlock("done")]))]);
    const first = await pool.open("telegram:1");
    const turn = first.prompt("long job");
    await Bun.sleep(5);
    expect(await pool.retire()).toEqual([]);
    // Still running: whoever asks gets the running session.
    expect(await pool.open("telegram:1")).toBe(first);
    release();
    await turn;
    // No sweep yet: the next message still gets a fresh session, resuming the same transcript.
    const next = await pool.open("telegram:1");
    expect(next).not.toBe(first);
    expect(closed).toEqual(["telegram:1"]);
    expect(created.at(-1)).toEqual({ key: "telegram:1", saved: "session-1" });
  });

  test("closeAll shuts hosts down without a final review; close(key) keeps it", async () => {
    const { pool, runtimes } = setup();
    await pool.open("telegram:1");
    await pool.open("telegram:2");
    await pool.close("telegram:1");
    expect(runtimes.get("telegram:1")!.shutdowns).toEqual([undefined]);
    // The gateway is stopping: nobody waits 30 s per chat for a review.
    await pool.closeAll();
    expect(runtimes.get("telegram:2")!.shutdowns).toEqual([{ finalReview: false }]);
  });
});
