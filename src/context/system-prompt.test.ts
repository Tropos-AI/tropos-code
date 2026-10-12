import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT, buildContextText, modeReminder } from "./system-prompt";

test("system prompt is Tropos-branded and static", () => {
  expect(SYSTEM_PROMPT).toContain("Tropos Code");
  expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/); // nothing dynamic: keeps the cache prefix stable
});

test("context text wraps memory and environment", () => {
  const text = buildContextText([{ path: "/r/TROPOS.md", content: "Use tabs." }], "Working directory: /r");
  expect(text).toStartWith("<context>");
  expect(text).toContain('<memory path="/r/TROPOS.md">\nUse tabs.\n</memory>');
  expect(text).toContain("<environment>\nWorking directory: /r\n</environment>");
  expect(text).toEndWith("</context>");
});

test("context text without memory files", () => {
  expect(buildContextText([], "x")).not.toContain("<memory");
});

describe("modeReminder", () => {
  test("entering and leaving plan mode", () => {
    expect(modeReminder(undefined, "plan")).toStartWith("<mode>Plan mode is on");
    expect(modeReminder("plan", "default")).toStartWith("<mode>Plan mode is off");
  });
  test("no reminder otherwise", () => {
    expect(modeReminder(undefined, "default")).toBeNull();
    expect(modeReminder("default", "acceptEdits")).toBeNull();
    expect(modeReminder("plan", "plan")).toBeNull();
  });
});
