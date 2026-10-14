// src/ui/transcript-v2.test.ts
import { describe, expect, test } from "bun:test";
import { addTurnDone, addUser, emptyTranscript, historyToTranscript, reduce, TURN_DONE_MIN_SECONDS } from "./transcript";

describe("transcript v2 additions", () => {
  test("tool_start keeps the input on the item", () => {
    const t = reduce(emptyTranscript, { type: "tool_start", id: "a", name: "Read", summary: "x.ts", input: { file_path: "/w/x.ts" } });
    expect(t.live[0]).toMatchObject({ kind: "tool", input: { file_path: "/w/x.ts" } });
  });

  test("progress lines are counted while the tool runs", () => {
    let t = reduce(emptyTranscript, { type: "tool_start", id: "a", name: "Agent", summary: "explore: x", input: {} });
    t = reduce(t, { type: "tool_progress", id: "a", text: "Read a" });
    t = reduce(t, { type: "tool_progress", id: "a", text: "Grep b" });
    expect(t.live[0]).toMatchObject({ progress: "Grep b", progressCount: 2 });
  });

  test("history replay keeps tool inputs", () => {
    const t = historyToTranscript([
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] },
    ]);
    expect(t.done[0]).toMatchObject({ kind: "tool", summary: "ls", input: { command: "ls" } });
  });

  test("turn_done follows everything the turn produced", () => {
    let t = reduce(emptyTranscript, { type: "text", delta: "hi" });
    t = addTurnDone(t, 12.4);
    expect(t.live).toHaveLength(0);
    expect(t.done.map((i) => i.kind)).toEqual(["assistant", "turn_done"]);
    expect(t.done[1]).toMatchObject({ kind: "turn_done", seconds: 12 });
    expect(new Set(t.done.map((i) => i.id)).size).toBe(2);
  });

  test("short turns get no footer", () => {
    expect(addTurnDone(emptyTranscript, TURN_DONE_MIN_SECONDS)).toBe(emptyTranscript);
    expect(addTurnDone(emptyTranscript, 1)).toBe(emptyTranscript);
    expect(addTurnDone(emptyTranscript, Number.NaN)).toBe(emptyTranscript);
    expect(addTurnDone(emptyTranscript, TURN_DONE_MIN_SECONDS + 1).done).toHaveLength(1);
  });

  test("a full turn: text, tool, notice, footer", () => {
    let t = addUser(emptyTranscript, "go");
    for (const e of [
      { type: "thinking", delta: "hm" },
      { type: "text", delta: "On " },
      { type: "text", delta: "it" },
      { type: "tool_start", id: "a", name: "Bash", summary: "ls", input: { command: "ls" } },
      { type: "tool_end", id: "a", name: "Bash", output: { content: "x" }, status: "done" },
      { type: "notice", level: "warn", text: "careful" },
      { type: "usage", inputTokens: 1, outputTokens: 1, contextTokens: 1 },
      { type: "turn_end", reason: "end_turn" },
    ] as const) {
      t = reduce(t, e);
    }
    t = addTurnDone(t, 30);
    expect(t.done.map((i) => i.kind)).toEqual(["user", "thinking", "assistant", "tool", "notice", "turn_done"]);
    expect(t.done[2]).toMatchObject({ text: "On it" });
    expect(t.done[3]).toMatchObject({ input: { command: "ls" }, output: { content: "x" } });
  });

  test("history: string contents, injected blocks and commands", () => {
    const t = historyToTranscript([
      { role: "user", content: "<context>x</context>" },
      { role: "user", content: '<command name="review" args="a">\nbody\n</command>' },
      { role: "assistant", content: "Sure" },
      { role: "user", content: [{ type: "text", text: "next" }] },
      { role: "assistant", content: [{ type: "text", text: "Ok" }, { type: "tool_use", id: "t", name: "X", input: "raw" }] },
    ]);
    expect(t.done.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual(["/review a", "Sure", "next", "Ok", "tool"]);
    expect(t.done[4]).toMatchObject({ summary: "", input: "raw" });
  });
});
