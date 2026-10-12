import { expect, test } from "bun:test";
import { contextTokens, contextWindow, costUsd } from "./pricing";

test("opus 5.5 pricing per million tokens", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };
  expect(costUsd("claude-opus-5-5", usage)).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
});

test("unknown model has no price", () => {
  expect(costUsd("mystery", { input_tokens: 1, output_tokens: 1 })).toBeUndefined();
});

test("context tokens count cached input too", () => {
  expect(contextTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: null })).toBe(110);
  expect(contextWindow("claude-opus-5-5")).toBe(1_000_000);
});
