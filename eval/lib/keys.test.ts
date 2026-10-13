// eval/lib/keys.test.ts
import { expect, test } from "bun:test";
import { runKey } from "./keys";

test("the model's provider decides which key is passed in", () => {
  expect(runKey("deepseek/deepseek-flash", ["tropos"], { DEEPSEEK_API_KEY: "env" }, {})).toMatchObject({ envName: "DEEPSEEK_API_KEY", apiKey: "env", provider: { id: "deepseek" } });
  expect(runKey("deepseek/deepseek-flash", ["tropos"], {}, { deepseek: { apiKey: "saved" } })).toMatchObject({ envName: "DEEPSEEK_API_KEY", apiKey: "saved" });
  expect(runKey("claude-opus-5-5", ["tropos", "claude"], { ANTHROPIC_API_KEY: "a" }, {})).toMatchObject({ envName: "ANTHROPIC_API_KEY", apiKey: "a" });
  expect(runKey("gemini/gemini-3.8-flash", ["tropos"], { GOOGLE_API_KEY: "g" }, {})).toMatchObject({ envName: "GEMINI_API_KEY", apiKey: "g" });
});

test("clear errors: Claude Code on another provider, a missing key, a provider with no key variable", () => {
  expect(() => runKey("deepseek/deepseek-flash", ["tropos", "claude"], { DEEPSEEK_API_KEY: "k" }, {})).toThrow("claude can only run Anthropic models");
  expect(() => runKey("xai/grok-4.7", ["tropos"], {}, {})).toThrow("No API key for xAI: set XAI_API_KEY or connect it with /providers");
  expect(() => runKey("claude-opus-5-5", ["tropos"], {}, {})).toThrow("ANTHROPIC_API_KEY");
  expect(() => runKey("ollama/qwen3", ["tropos"], {}, {})).toThrow("can't be used from eval containers");
});
