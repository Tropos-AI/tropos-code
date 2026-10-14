import { describe, expect, test } from "bun:test";
import { addNotice, addUser, emptyTranscript, flush, historyToTranscript, reduce, type Transcript } from "./transcript";

const apply = (t: Transcript, ...events: Parameters<typeof reduce>[1][]) => events.reduce(reduce, t);

describe("transcript reducer", () => {
  test("text deltas merge into one live assistant item", () => {
    const t = apply(emptyTranscript, { type: "text", delta: "Hel" }, { type: "text", delta: "lo" });
    expect(t.live).toHaveLength(1);
    expect(t.live[0]).toMatchObject({ kind: "assistant", text: "Hello" });
  });

  test("empty deltas between thinking deltas don't split the thinking into many items", () => {
    const t = apply(
      emptyTranscript,
      { type: "thinking", delta: "The" },
      { type: "text", delta: "" },
      { type: "thinking", delta: " user said hello" },
      { type: "thinking", delta: "" },
      { type: "text", delta: "Hi!" },
    );
    expect([...t.done, ...t.live].map((i) => [i.kind, "text" in i ? i.text : ""])).toEqual([
      ["thinking", "The user said hello"],
      ["assistant", "Hi!"],
    ]);
  });

  test("a tool start settles the text before it", () => {
    const t = apply(emptyTranscript, { type: "text", delta: "Looking" }, { type: "tool_start", id: "a", name: "Read", summary: "x.ts", input: {} });
    expect(t.done.map((i) => i.kind)).toEqual(["assistant"]);
    expect(t.live.map((i) => i.kind)).toEqual(["tool"]);
  });

  test("tool end updates the running item and settles it", () => {
    const t = apply(
      emptyTranscript,
      { type: "tool_start", id: "a", name: "Read", summary: "x.ts", input: {} },
      { type: "tool_end", id: "a", name: "Read", output: { content: "ok", summary: "3 lines" }, status: "done" },
    );
    expect(t.done[0]).toMatchObject({ kind: "tool", status: "done" });
    expect(t.live).toHaveLength(0);
  });

  test("running tools are never moved to done", () => {
    const t = apply(
      emptyTranscript,
      { type: "tool_start", id: "a", name: "Bash", summary: "sleep", input: {} },
      { type: "tool_start", id: "b", name: "Read", summary: "y", input: {} },
      { type: "tool_end", id: "b", name: "Read", output: { content: "ok" }, status: "done" },
    );
    expect(t.live.map((i) => (i.kind === "tool" ? i.toolUseId : "")) ).toEqual(["a", "b"]);
  });

  test("turn end flushes everything", () => {
    const t = apply(emptyTranscript, { type: "text", delta: "x" }, { type: "turn_end", reason: "end_turn" });
    expect(t.live).toHaveLength(0);
    expect(t.done).toHaveLength(1);
  });

  test("users and notices; ids are unique", () => {
    let t = addUser(emptyTranscript, "hi");
    t = reduce(t, { type: "text", delta: "a" });
    t = addUser(t, "again");
    t = flush(addNotice(t, "info", "note"));
    const ids = t.done.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(t.done.map((i) => i.kind)).toEqual(["user", "assistant", "user", "notice"]);
  });

  test("history replay skips context and mode blocks", () => {
    const t = historyToTranscript([
      { role: "user", content: [{ type: "text", text: "<context>x</context>" }, { type: "text", text: "fix it" }] },
      { role: "assistant", content: [{ type: "text", text: "On it" }, { type: "tool_use", id: "t", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "..." }] },
    ]);
    expect(t.done.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(t.done[2]).toMatchObject({ name: "Read", summary: "a.ts" });
  });
});

test("history replay filters context and mode blocks in string-content user messages", () => {
  const t = historyToTranscript([
    { role: "user", content: "<context>x</context>" },
    { role: "user", content: "<mode>plan</mode>" },
    { role: "user", content: "fix it" },
  ]);
  expect(t.done).toEqual([expect.objectContaining({ kind: "user", text: "fix it" })]);
});

test("tool progress updates a running row only", () => {
  let t = reduce(emptyTranscript, { type: "tool_start", id: "a", name: "Agent", summary: "explore: find", input: {} });
  t = reduce(t, { type: "tool_progress", id: "a", text: "Read src/x.ts" });
  expect(t.live[0]).toMatchObject({ kind: "tool", progress: "Read src/x.ts" });
  t = reduce(t, { type: "tool_end", id: "a", name: "Agent", output: { content: "done" }, status: "done" });
  t = reduce(t, { type: "tool_progress", id: "a", text: "late" });
  expect(JSON.stringify(t)).not.toContain("late");
});

test("resumed commands and skills show as typed; hook and reminder blocks are hidden", () => {
  const t = historyToTranscript([
    { role: "user", content: [{ type: "text", text: '<command name="/review" args="main &amp; dev">\nReview\n</command>' }] },
    { role: "user", content: [{ type: "text", text: '<skill name="deploy" dir="/s">\nSteps\n</skill>' }] },
    { role: "user", content: [{ type: "text", text: "<reminder>undone</reminder>" }, { type: "text", text: '<hook-context event="Stop">x</hook-context>' }] },
    { role: "user", content: '<command name="/x">\ny\n</command>' },
  ]);
  expect(t.done.map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["/review main & dev", "/deploy", "/x"]);
});
