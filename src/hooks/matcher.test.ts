// src/hooks/matcher.test.ts
import { describe, expect, test } from "bun:test";
import { matchesHook } from "./matcher";

describe("matchesHook", () => {
  test("empty, undefined and * match everything", () => {
    expect(matchesHook(undefined, "Bash")).toBe(true);
    expect(matchesHook("", "Bash")).toBe(true);
    expect(matchesHook("*", "Bash")).toBe(true);
  });

  test("an undefined value (event without a matcher field) matches every group", () => {
    expect(matchesHook("Bash", undefined)).toBe(true);
  });

  test("plain names and | lists are exact", () => {
    expect(matchesHook("Edit", "Edit")).toBe(true);
    expect(matchesHook("Edit", "NotebookEdit")).toBe(false);
    expect(matchesHook("Write|Edit", "Edit")).toBe(true);
    expect(matchesHook("Write|Edit", "Read")).toBe(false);
  });

  test("anything else is an anchored regex", () => {
    expect(matchesHook("mcp__.*", "mcp__github__search")).toBe(true);
    expect(matchesHook("mcp__.*", "xmcp__a")).toBe(false);
    expect(matchesHook("Notebook.*|Edit", "Edit")).toBe(true);
    expect(matchesHook("Ed.t", "Edit2")).toBe(false);
  });

  test("an invalid regex never matches, repeatedly", () => {
    expect(matchesHook("(unclosed", "(unclosed")).toBe(false);
    expect(matchesHook("(unclosed", "anything")).toBe(false);
  });
});
