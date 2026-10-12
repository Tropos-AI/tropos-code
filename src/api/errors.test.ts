import Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "bun:test";
import { describeError } from "./errors";

const apiError = (status: number) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: "boom" } }, "boom", new Headers());

test("401 explains how to authenticate", () => {
  const d = describeError(apiError(401));
  expect(d.message).toContain("ANTHROPIC_API_KEY");
  expect(d.message).toContain("ant auth login");
  expect(d.retryable).toBe(false);
});

test("429 and 5xx are retryable", () => {
  expect(describeError(apiError(429)).retryable).toBe(true);
  expect(describeError(apiError(529)).retryable).toBe(true);
  expect(describeError(apiError(500)).retryable).toBe(true);
});

test("400 shows the API message", () => {
  const d = describeError(apiError(400));
  expect(d.message).toContain("boom");
  expect(d.retryable).toBe(false);
});

test("connection errors", () => {
  expect(describeError(new Anthropic.APIConnectionError({ message: "offline" })).message).toContain("reach the API");
});

test("missing credentials", () => {
  const d = describeError(new Error("Could not resolve authentication method. Expected one of apiKey…"));
  expect(d.message).toContain("ANTHROPIC_API_KEY");
});

test("missing credentials wrapped in an AnthropicError by the stream", () => {
  const d = describeError(new Anthropic.AnthropicError("stream failed: Could not resolve authentication method. Expected one of apiKey…"));
  expect(d.message).toContain("No API credentials found");
});

test("plain errors and values", () => {
  expect(describeError(new Error("x")).message).toBe("x");
  expect(describeError("weird").message).toBe("weird");
});
