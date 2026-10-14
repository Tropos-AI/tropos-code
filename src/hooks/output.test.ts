// src/hooks/output.test.ts
import { describe, expect, test } from "bun:test";
import { emptyOutcome, hookLabel, interpretHookResult, mergeHookResults, type HookOutcome } from "./output";

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

describe("interpretHookResult", () => {
  test("exit 0 plain stdout is context only for UserPromptSubmit and SessionStart", () => {
    expect(interpretHookResult("UserPromptSubmit", "c", ok(" hi \n")).additionalContext).toEqual(["hi"]);
    expect(interpretHookResult("SessionStart", "c", ok("ctx")).additionalContext).toEqual(["ctx"]);
    expect(interpretHookResult("PreToolUse", "c", ok("ctx"))).toEqual(emptyOutcome());
    expect(interpretHookResult("UserPromptSubmit", "c", ok("  "))).toEqual(emptyOutcome());
  });

  test("exit 2 blocks blocking events with stderr or a default reason", () => {
    expect(interpretHookResult("PreToolUse", "c", { exitCode: 2, stdout: "", stderr: " no \n" }).blocked).toBe("no");
    expect(interpretHookResult("Stop", "c", { exitCode: 2, stdout: "", stderr: "" }).blocked).toBe("Blocked by a hook (c)");
  });

  test("exit 2 on a non-blocking event is an error", () => {
    const out = interpretHookResult("SessionStart", "c", { exitCode: 2, stdout: "", stderr: "first\nsecond" });
    expect(out.blocked).toBeUndefined();
    expect(out.errors).toEqual(["c: exit 2: first"]);
    expect(interpretHookResult("SessionEnd", "c", { exitCode: 2, stdout: "", stderr: "" }).errors).toEqual(["c: exit 2"]);
  });

  test("other exits are errors with stderr's first line", () => {
    expect(interpretHookResult("PreToolUse", "c", { exitCode: 1, stdout: "", stderr: "bad\nmore" }).errors).toEqual(["c: exit 1: bad"]);
    expect(interpretHookResult("PreToolUse", "c", { exitCode: 3, stdout: "", stderr: "" }).errors).toEqual(["c: exit 3"]);
  });

  test("JSON common fields", () => {
    const out = interpretHookResult("PostToolUse", "c", ok(JSON.stringify({ continue: false, systemMessage: "note", decision: "block", reason: "r" })));
    expect(out).toMatchObject({ stop: "Stopped by a hook", messages: ["note"], blocked: "r" });
    expect(interpretHookResult("Stop", "c", ok('{"continue":false,"stopReason":"done"}')).stop).toBe("done");
    expect(interpretHookResult("Stop", "c", ok('{"decision":"block"}')).blocked).toBe("Blocked by a hook (c)");
  });

  test("decision approve is ignored and block is ignored on non-blocking events", () => {
    expect(interpretHookResult("PreToolUse", "c", ok('{"decision":"approve"}'))).toEqual(emptyOutcome());
    expect(interpretHookResult("SessionStart", "c", ok('{"decision":"block","reason":"x"}')).blocked).toBeUndefined();
  });

  test("PreToolUse hookSpecificOutput", () => {
    const json = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "nope", updatedInput: { a: 1 }, additionalContext: "ctx" } };
    expect(interpretHookResult("PreToolUse", "c", ok(JSON.stringify(json)))).toEqual({
      permission: "deny",
      permissionReason: "nope",
      updatedInput: { a: 1 },
      additionalContext: ["ctx"],
      messages: [],
      errors: [],
    });
  });

  test("bad permissionDecision and non-object updatedInput are errors", () => {
    const out = interpretHookResult("PreToolUse", "c", ok('{"hookSpecificOutput":{"permissionDecision":"maybe","updatedInput":[1]}}'));
    expect(out.permission).toBeUndefined();
    expect(out.updatedInput).toBeUndefined();
    expect(out.errors).toEqual(['c: unknown permissionDecision "maybe"', "c: updatedInput is not an object"]);
  });

  test("permission fields are PreToolUse only; additionalContext applies anywhere", () => {
    const out = interpretHookResult("PostToolUse", "c", ok('{"hookSpecificOutput":{"permissionDecision":"allow","additionalContext":"x"}}'));
    expect(out.permission).toBeUndefined();
    expect(out.additionalContext).toEqual(["x"]);
  });

  test("a hookEventName for another event is an error and its output is ignored", () => {
    const out = interpretHookResult("PreToolUse", "c", ok('{"systemMessage":"m","hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"deny"}}'));
    expect(out.permission).toBeUndefined();
    expect(out.messages).toEqual(["m"]);
    expect(out.errors).toEqual(["c: hookSpecificOutput is for PostToolUse, not PreToolUse"]);
  });

  test("malformed JSON shapes are errors", () => {
    expect(interpretHookResult("Stop", "c", ok("{nope")).errors[0]).toStartWith("c: invalid JSON output: ");
    expect(interpretHookResult("Stop", "c", ok('{"hookSpecificOutput":3}')).errors).toEqual(["c: hookSpecificOutput is not an object"]);
  });
});

describe("hookLabel", () => {
  test("first line, capped", () => {
    expect(hookLabel("  a\nb")).toBe("a");
    expect(hookLabel("x".repeat(200))).toHaveLength(120);
  });
});

describe("mergeHookResults", () => {
  const r = (o: Partial<HookOutcome>): HookOutcome => ({ ...emptyOutcome(), ...o });

  test("deny > ask > allow, with the winner's reason", () => {
    expect(mergeHookResults([r({ permission: "allow", permissionReason: "a" }), r({ permission: "deny", permissionReason: "d" }), r({ permission: "ask", permissionReason: "q" })])).toMatchObject({ permission: "deny", permissionReason: "d" });
    expect(mergeHookResults([r({ permission: "ask" }), r({ permission: "ask", permissionReason: "second" }), r({ permission: "allow", permissionReason: "x" })])).toMatchObject({ permission: "ask", permissionReason: "second" });
    expect("permissionReason" in mergeHookResults([r({ permission: "allow" })])).toBe(false);
  });

  test("updatedInput last wins; reasons and lists joined in order", () => {
    const merged = mergeHookResults([
      r({ updatedInput: { n: 1 }, blocked: "one", stop: "s1", additionalContext: ["c1"], messages: ["m1"], errors: ["e1"] }),
      r({ blocked: "two", stop: "s2", additionalContext: ["c2"], messages: ["m2"], errors: ["e2"] }),
      r({ updatedInput: { n: 3 } }),
    ]);
    expect(merged).toEqual({
      blocked: "one\ntwo",
      stop: "s1\ns2",
      updatedInput: { n: 3 },
      additionalContext: ["c1", "c2"],
      messages: ["m1", "m2"],
      errors: ["e1", "e2"],
    });
  });

  test("nothing merges to an empty outcome", () => {
    expect(mergeHookResults([])).toEqual(emptyOutcome());
  });
});
