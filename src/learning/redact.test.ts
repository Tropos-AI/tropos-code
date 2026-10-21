// src/learning/redact.test.ts
import { expect, test } from "bun:test";
import type { MessageParam } from "../session/store";
import { redactPrivateResults, WITHHELD } from "./redact";

const history = (): MessageParam[] => [
  { role: "user", content: "what did Maria say?" },
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "m1", name: "Messages", input: { action: "read", chat: "iMessage;-;+306912345678" } },
      { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/w/a.ts" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "m1", content: [{ type: "text", text: "Maria: the door code is 4711" }] },
      { type: "tool_result", tool_use_id: "r1", content: "export const a = 1;" },
    ],
  },
  { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "SendIMessage", input: { to: "+306912345678", text: "ok" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "Sent to Maria; delivered.", is_error: false }] },
];

test("a Messages or SendIMessage result is withheld, a Read result next to it is untouched", () => {
  const out = redactPrivateResults(history());
  const results = out.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []));
  expect(results).toEqual([
    { type: "tool_result", tool_use_id: "m1", content: WITHHELD },
    { type: "tool_result", tool_use_id: "r1", content: "export const a = 1;" },
    { type: "tool_result", tool_use_id: "s1", content: WITHHELD, is_error: false },
  ]);
  expect(WITHHELD).toBe("[Messages result withheld from the learning review]");
  expect(JSON.stringify(out)).not.toContain("4711");
});

test("the input history is not changed", () => {
  const input = history();
  const before = JSON.stringify(input);
  redactPrivateResults(input);
  expect(JSON.stringify(input)).toBe(before);
});

test("another tool set can be withheld instead", () => {
  const out = redactPrivateResults(history(), new Set(["Read"]));
  expect(JSON.stringify(out)).toContain("4711");
  expect(JSON.stringify(out)).not.toContain("export const a");
});
