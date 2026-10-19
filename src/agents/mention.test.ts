// src/agents/mention.test.ts
import { expect, test } from "bun:test";
import { mentionCall, parseMention } from "./mention";

test("@id plus a message, case-insensitive; anything else is not a mention", () => {
  expect(parseMention("@reviewer check PR 12", ["reviewer"])).toEqual({ id: "reviewer", message: "check PR 12" });
  expect(parseMention("@Reviewer, check it\nplease", ["reviewer"])).toEqual({ id: "reviewer", message: "check it\nplease" });
  for (const text of ["@reviewer", "@src/a.ts fix this", "@nobody hi", "hi @reviewer", "@reviewers hi"]) expect(parseMention(text, ["reviewer"])).toBeNull();
});

test("the call carries the message verbatim; the reply carries the emoji and name", () => {
  const d = mentionCall("@reviewer look at PR 12 and the failing test please", [{ id: "reviewer", emoji: "🔍" }])!;
  expect(d.call.input).toEqual({ description: "look at PR 12 and the", prompt: "look at PR 12 and the failing test please", subagent_type: "reviewer" });
  expect(d.reply({ text: "LGTM", isError: false })).toBe("🔍 reviewer:\nLGTM");
  expect(d.reply({ text: "no diff", isError: true })).toBe("🔍 reviewer couldn't finish:\nno diff");
});
