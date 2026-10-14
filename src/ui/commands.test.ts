import { describe, expect, test } from "bun:test";
import { INIT_PROMPT, LEARN_PROMPT, RESERVED_COMMANDS, helpText, parseCommand } from "./commands";

test("plain text and paths are not commands", () => {
  expect(parseCommand("hello")).toEqual({ kind: "none" });
  expect(parseCommand("/usr/bin/env is missing")).toEqual({ kind: "none" });
});

test("simple commands", () => {
  expect(parseCommand("/clear")).toEqual({ kind: "clear" });
  expect(parseCommand("/exit")).toEqual({ kind: "exit" });
  expect(parseCommand("/quit")).toEqual({ kind: "exit" });
  expect(parseCommand("/resume")).toEqual({ kind: "resume" });
  expect(parseCommand("/cost")).toEqual({ kind: "cost" });
});

test("model and effort", () => {
  expect(parseCommand("/model")).toEqual({ kind: "model" });
  expect(parseCommand("/model claude-sonnet-5-5")).toEqual({ kind: "model", model: "claude-sonnet-5-5" });
  expect(parseCommand("/effort max")).toEqual({ kind: "effort", effort: "max" });
  expect(parseCommand("/effort huge")).toMatchObject({ kind: "effort", error: expect.stringContaining("low, medium") });
});

test("init sends a prompt; unknown commands are reported", () => {
  expect(parseCommand("/init")).toEqual({ kind: "prompt", text: INIT_PROMPT });
  expect(parseCommand("/frobnicate")).toEqual({ kind: "unknown", name: "frobnicate" });
});

test("help lists every command and the shortcuts", () => {
  const text = helpText();
  for (const name of ["/help", "/clear", "/resume", "/model", "/effort", "/cost", "/init", "/exit", "shift+tab"]) {
    expect(text).toContain(name);
  }
});

describe("phase 2 commands", () => {
  const extra = [{ name: "review", description: "Review", argumentHint: "[focus]" }, { name: "kit:ship", description: "Ship" }];
  test("custom commands and skills dispatch by name; built-ins win", () => {
    expect(parseCommand("/review the diff", extra)).toEqual({ kind: "custom", name: "review", args: "the diff" });
    expect(parseCommand("/kit:ship", extra)).toEqual({ kind: "custom", name: "kit:ship", args: "" });
    expect(parseCommand("/help", [{ name: "help", description: "x" }]).kind).toBe("help");
    expect(parseCommand("/nope", extra)).toEqual({ kind: "unknown", name: "nope" });
  });
  test("help lists custom commands with their hints", () => {
    const text = helpText(extra);
    expect(text).toContain("Custom commands and skills");
    expect(text).toContain("/review [focus]");
    expect(helpText()).not.toContain("Custom commands");
  });
  test("listing, undo/redo and learn", () => {
    for (const what of ["skills", "agents", "hooks", "mcp", "plugins", "memory"] as const) {
      expect(parseCommand(`/${what}`)).toEqual({ kind: "list", what });
    }
    expect(parseCommand("/undo")).toEqual({ kind: "undo" });
    expect(parseCommand("/redo")).toEqual({ kind: "redo" });
    expect(parseCommand("/learn")).toEqual({ kind: "prompt", text: LEARN_PROMPT });
    const focused = parseCommand("/learn the release flow");
    expect(focused.kind === "prompt" && focused.text.endsWith("Focus on: the release flow")).toBe(true);
    expect(RESERVED_COMMANDS.has("undo")).toBe(true);
  });
  test("/learned lists what was learned; /learned undo reverts the latest", () => {
    expect(parseCommand("/learned")).toEqual({ kind: "list", what: "learned" });
    expect(parseCommand("/learned undo")).toEqual({ kind: "learned_undo" });
    expect(parseCommand("/learned UNDO")).toEqual({ kind: "learned_undo" });
    expect(parseCommand("/learned foo")).toEqual({ kind: "list", what: "learned" });
    expect(RESERVED_COMMANDS.has("learned")).toBe(true);
  });
});
