// eval/lib/agents.test.ts
import { expect, test } from "bun:test";
import { claude, lastResultLine, tropos } from "./agents";

test("commands read the prompt from $PROMPT and quote the model", () => {
  expect(tropos.command({ model: "claude-opus-5-5", effort: "high" })).toBe(
    `tropos -p "$PROMPT" --output-format json --dangerously-skip-permissions --model 'claude-opus-5-5' --effort 'high' </dev/null`,
  );
  expect(tropos.command({ model: "m" })).not.toContain("--effort");
  expect(claude.command({ model: "it's" })).toContain(`--model 'it'\\''s'`);
  expect(claude.command({ model: "m", effort: "high" })).toContain("--effort 'high' </dev/null");
  expect(claude.command({ model: "m" })).not.toContain("--effort");
});

test("lastResultLine skips noise and non-result JSON", () => {
  expect(lastResultLine('warning\n{"type":"result","a":1}\n{"type":"other"}\nnot json {')).toEqual({ type: "result", a: 1 });
  expect(lastResultLine("")).toBeNull();
  expect(lastResultLine("{broken")).toBeNull();
});

test("tropos result", () => {
  const line = JSON.stringify({ type: "result", is_error: true, stop: "max_tokens", num_turns: 7, num_tool_calls: 12, num_tool_errors: 2, usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: null });
  expect(tropos.parse(line)).toEqual({ isError: true, stop: "max_tokens", turns: 7, toolCalls: 12, toolErrors: 2, costUsd: null, inputTokens: 10, outputTokens: 5 });
  expect(tropos.parse("crashed").turns).toBeNull();
});

test("claude result", () => {
  const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.42, usage: { input_tokens: 1, output_tokens: 2 } });
  expect(claude.parse(line)).toEqual({ isError: false, stop: "success", turns: 3, toolCalls: null, toolErrors: null, costUsd: 0.42, inputTokens: 1, outputTokens: 2 });
});
