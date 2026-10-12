// src/cli/print.test.ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { FakeModel, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { makeToolContext } from "../../test/helpers/tool-context";
import { Agent } from "../agent/agent";
import { compileRules } from "../permissions/engine";
import { defineTool, type AnyTool } from "../tools/types";
import { EXIT_CODES, PRINT_DENY, PrintRenderer, runPrint } from "./print";

const shell = defineTool({
  name: "Shell",
  kind: "exec",
  description: "x",
  schema: z.object({ c: z.string() }),
  summarize: (i) => i.c,
  subject: (i) => ({ command: i.c, paths: [] }),
  run: async () => ({ content: "ran" }),
});

async function print(steps: Step[], format: "text" | "json" | "stream-json", maxTurns?: number) {
  const out: string[] = [];
  const err: string[] = [];
  const renderer = new PrintRenderer(format, (s) => out.push(s), (s) => err.push(s), "sess-1");
  const agent = new Agent({
    model: new FakeModel(steps),
    tools: [shell] as AnyTool[],
    system: "s",
    config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
    permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/w", home: "/h", allowedDirs: ["/w"] }),
    askPermission: async () => PRINT_DENY,
    contextText: async () => "<context></context>",
    persist: async () => {},
    toolContext: makeToolContext({ root: "/w" }),
    maxTurns,
    emit: (e) => renderer.emit(e),
  });
  const code = await runPrint(agent, renderer, "hi", new AbortController().signal);
  return { code, out: out.join(""), err: err.join(""), agent };
}

describe("print mode", () => {
  test("text prints the final answer", async () => {
    const r = await print([() => reply([textBlock("Hello "), textBlock("world")])], "text");
    expect(r.code).toBe(0);
    expect(r.out).toBe("Hello world\n");
  });

  test("text prints only the last assistant message", async () => {
    const r = await print([() => reply([textBlock("Checking…"), toolUseBlock("t", "Shell", { c: "ls" })], "tool_use"), () => reply([textBlock("Final.")])], "text");
    expect(r.out).toBe("Final.\n");
  });

  test("permission prompts become denials with an explanation", async () => {
    const r = await print([() => reply([toolUseBlock("t", "Shell", { c: "ls" })], "tool_use"), () => reply([textBlock("ok")])], "text");
    const result = (r.agent.messages[2]!.content as Array<{ content: string }>)[0]!;
    expect(result.content).toBe(PRINT_DENY.kind === "deny" ? PRINT_DENY.message! : "");
  });

  test("json result object", async () => {
    const r = await print([() => reply([textBlock("Done")])], "json");
    expect(JSON.parse(r.out)).toMatchObject({
      type: "result",
      result: "Done",
      session_id: "sess-1",
      is_error: false,
      stop: "end_turn",
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 20 },
      error: null,
    });
  });

  test("stream-json emits one JSON object per line, ending with the result", async () => {
    const r = await print([() => reply([textBlock("A")])], "stream-json");
    const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toContain("text");
    expect(lines.at(-1)).toMatchObject({ type: "result", result: "A" });
  });

  test("exit codes", async () => {
    expect((await print([() => reply([textBlock("no")], "refusal")], "text")).code).toBe(EXIT_CODES.refusal);
    const looping = () => reply([toolUseBlock("t", "Shell", { c: "ls" })], "tool_use");
    const capped = await print([looping], "text", 1);
    expect(capped.code).toBe(EXIT_CODES.max_turns);
    expect(capped.out).toBe("");
    expect(capped.err).toContain("Stopped after 1 turn(s)");
    const err = await print([], "text");
    expect(err.code).toBe(EXIT_CODES.error);
    expect(err.err).toContain("no scripted response");
  });

  test("refusal still prints the text it received", async () => {
    const r = await print([() => reply([textBlock("no")], "refusal")], "text");
    expect(r.out).toBe("no\n");
  });

  test("text mode: a mid-run error prints nothing, not an earlier turn's text", async () => {
    const r = await print([() => reply([textBlock("Checking…"), toolUseBlock("t", "Shell", { c: "ls" })], "tool_use")], "text");
    expect(r.code).toBe(EXIT_CODES.error);
    expect(r.out).toBe("");
    expect(r.err).toContain("no scripted response");
  });

  test("json mode: a failing run prints one result object and the error to stderr", async () => {
    const r = await print([], "json");
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "result", is_error: true, stop: "error", result: "" });
    expect(JSON.parse(lines[0]!).error).toContain("no scripted response");
    expect(r.err).toContain("no scripted response");
  });

  test("warnings reach stderr in json mode", async () => {
    const r = await print([() => reply([toolUseBlock("t", "Shell", { c: "ls" })], "tool_use")], "json", 1);
    expect(r.err).toContain("warn: Stopped after 1 turn(s)");
    expect(JSON.parse(r.out)).toMatchObject({ stop: "max_turns", is_error: true });
  });

  test("stream-json: errors reach stderr and the notice event stays on stdout", async () => {
    const r = await print([], "stream-json");
    const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toContainEqual(expect.objectContaining({ type: "notice", level: "error" }));
    expect(lines.at(-1)).toMatchObject({ type: "result", error: expect.stringContaining("no scripted response") });
    expect(r.err).toContain("error: ");
    expect(r.err).toContain("no scripted response");
  });
});
