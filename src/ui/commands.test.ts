import { expect, test } from "bun:test";
import { INIT_PROMPT, helpText, parseCommand } from "./commands";

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
