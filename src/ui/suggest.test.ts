// src/ui/suggest.test.ts
import { describe, expect, test } from "bun:test";
import { builtinSuggestions, extraSuggestions, leadingCommand, needsArgs, rankCommands, suggestionState, type SuggestCommand } from "./suggest";

const cmd = (name: string, description = "", kind: SuggestCommand["kind"] = "builtin"): SuggestCommand => ({ name, description, kind });

describe("rankCommands", () => {
  const commands = [cmd("hooks-helper"), cmd("help"), cmd("hooks"), cmd("the"), cmd("cost", "Session spend; helpful"), cmd("model")];

  test("exact, then prefix, then substring, then description; shorter first among ties", () => {
    expect(rankCommands("he", commands).map((c) => c.name)).toEqual(["help", "the", "hooks-helper", "cost"]);
    expect(rankCommands("/ho", commands).map((c) => c.name)).toEqual(["hooks", "hooks-helper"]);
    expect(rankCommands("hooks", commands).map((c) => c.name)).toEqual(["hooks", "hooks-helper"]);
  });

  test("exact match beats a shorter prefix match", () => {
    const list = [cmd("ab"), cmd("abc"), cmd("a")];
    expect(rankCommands("ab", list).map((c) => c.name)).toEqual(["ab", "abc"]);
  });

  test("case-insensitive; ties of equal length sort by name", () => {
    expect(rankCommands("M", [cmd("mb"), cmd("ma")]).map((c) => c.name)).toEqual(["ma", "mb"]);
  });

  test("empty query keeps the given order; no match gives nothing", () => {
    expect(rankCommands("", commands)).toEqual(commands);
    expect(rankCommands("zzz", commands)).toEqual([]);
  });
});

describe("suggestionState", () => {
  test("slash mode only for a single /word", () => {
    expect(suggestionState("/", 1)).toEqual({ kind: "command", query: "" });
    expect(suggestionState("/he", 3)).toEqual({ kind: "command", query: "he" });
    expect(suggestionState("/help me", 8)).toEqual({ kind: "none" });
    expect(suggestionState("x /he", 5)).toEqual({ kind: "none" });
    expect(suggestionState("/usr/bin", 8)).toEqual({ kind: "none" });
  });

  test("file mode follows the token at the cursor", () => {
    expect(suggestionState("look at @src/u", 14)).toEqual({ kind: "file", token: { start: 8, end: 14, text: "@src/u" } });
    expect(suggestionState("@a b", 4)).toEqual({ kind: "none" });
    expect(suggestionState("hello", 5)).toEqual({ kind: "none" });
  });
});

describe("helpers", () => {
  test("needsArgs from takesArgs or argumentHint", () => {
    expect(needsArgs(cmd("a"))).toBe(false);
    expect(needsArgs({ ...cmd("a"), takesArgs: true })).toBe(true);
    expect(needsArgs({ ...cmd("a"), argumentHint: "<branch>" })).toBe(true);
  });

  test("leadingCommand matches /name then space or end", () => {
    const list = [cmd("review", "", "custom")];
    expect(leadingCommand("/review main", list)?.name).toBe("review");
    expect(leadingCommand("/Review", list)?.name).toBe("review");
    expect(leadingCommand("/reviewer", list)).toBeUndefined();
    expect(leadingCommand("review", list)).toBeUndefined();
  });

  test("builtinSuggestions covers built-ins with no required args", () => {
    const list = builtinSuggestions();
    expect(list.find((c) => c.name === "help")).toMatchObject({ kind: "builtin" });
    expect(list.every((c) => !needsArgs(c))).toBe(true);
  });

  test("extraSuggestions turns the (skill) prefix into a kind", () => {
    expect(
      extraSuggestions([
        { name: "review", description: "Review", argumentHint: "<ref>" },
        { name: "plain", description: "Plain" },
        { name: "tdd", description: "(skill) Test first" },
      ]),
    ).toEqual([
      { name: "review", description: "Review", kind: "custom", argumentHint: "<ref>" },
      { name: "plain", description: "Plain", kind: "custom" },
      { name: "tdd", description: "Test first", kind: "skill" },
    ]);
  });
});
