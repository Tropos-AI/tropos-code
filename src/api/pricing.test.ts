import Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "bun:test";
import { contextTokens, contextWindow, costUsd, messageCostUsd } from "./pricing";

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

// A real BetaMessage must be assignable to the parameter type (compile-time check).
const _check: Parameters<typeof messageCostUsd>[0] = {} as Anthropic.Beta.BetaMessage;
void _check;

test("messageCostUsd without iterations equals costUsd on the served model", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  expect(messageCostUsd({ model: "claude-opus-5-5", usage }, "claude-opus-5-5")).toBeCloseTo(24, 6);
  expect(messageCostUsd({ model: "claude-opus-5-5", usage: { ...usage, iterations: null } }, "claude-opus-5-5")).toBeCloseTo(24, 6);
  expect(messageCostUsd({ model: "claude-opus-5-5", usage: { ...usage, iterations: [] } }, "claude-opus-5-5")).toBeCloseTo(24, 6);
});

test("compaction and message iterations on opus are summed", () => {
  const message = {
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { type: "compaction", input_tokens: 1_000_000, output_tokens: 0 },
        { type: "message", input_tokens: 0, output_tokens: 1_000_000 },
      ],
    },
  };
  expect(messageCostUsd(message, "claude-opus-5-5")).toBeCloseTo(4 + 20, 6);
});

test("fallback iteration bills at the model that served it", () => {
  const message = {
    model: "claude-sonnet-5-5",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { type: "message", input_tokens: 1_000_000, output_tokens: 0 },
        { type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 1_000_000, output_tokens: 0 },
      ],
    },
  };
  expect(messageCostUsd(message, "claude-opus-5-5")).toBeCloseTo(4 + 2, 6);
});

test("an iteration on an unknown model has no price", () => {
  const unknownFallback = {
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { type: "message", input_tokens: 1, output_tokens: 1 },
        { type: "fallback_message", model: "mystery", input_tokens: 1, output_tokens: 1 },
      ],
    },
  };
  expect(messageCostUsd(unknownFallback, "claude-opus-5-5")).toBeUndefined();
  expect(messageCostUsd({ model: "mystery", usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "message", input_tokens: 1, output_tokens: 1 }] } }, "mystery")).toBeUndefined();
});

test("a message iteration with its own model is priced at that model", () => {
  const message = {
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [{ type: "message", model: "claude-sonnet-5-5", input_tokens: 1_000_000, output_tokens: 0 }],
    },
  };
  expect(messageCostUsd(message, "claude-opus-5-5")).toBeCloseTo(2, 6);
});

test("an advisor_message iteration with its own model is priced at that model", () => {
  const message = {
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [{ type: "advisor_message", model: "claude-haiku-5-5", input_tokens: 1_000_000, output_tokens: 1_000_000 }],
    },
  };
  expect(messageCostUsd(message, "claude-opus-5-5")).toBeCloseTo(0.1 + 0.5, 6);
});

test("a fallback_message with a null model is priced at the requested model", () => {
  const message = {
    model: "claude-sonnet-5-5",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [{ type: "fallback_message", model: null, input_tokens: 1_000_000, output_tokens: 0 }],
    },
  };
  expect(messageCostUsd(message, "claude-opus-5-5")).toBeCloseTo(4, 6);
});
