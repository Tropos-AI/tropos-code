// src/providers/model-check.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { modelProblem } from "./model-check";
import { ProviderRouter, type ProviderStatus } from "./router";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("model-check-");
});
afterEach(() => removeDir(dir));

async function statuses(env: NodeJS.ProcessEnv = {}): Promise<ProviderStatus[]> {
  return new ProviderRouter({ home: dir, env, settings: { "my-vllm": { baseURL: "http://gpu:8000/v1" } } }).status();
}

test("an Anthropic id, a connected provider's model and a custom endpoint's model are fine", async () => {
  const s = await statuses({ DEEPSEEK_API_KEY: "k" });
  expect(modelProblem("claude-sonnet-5-5", s)).toBeNull();
  expect(modelProblem("anthropic/claude-sonnet-5-5", s)).toBeNull();
  expect(modelProblem("deepseek/deepseek-chat", s)).toBeNull();
  expect(modelProblem("my-vllm/qwen3", s)).toBeNull();
  // Local providers need no key.
  expect(modelProblem("ollama/llama3", s)).toBeNull();
});

test("an unknown provider, a bare non-Claude id and a provider with no model are refused with what to do", async () => {
  const s = await statuses();
  expect(modelProblem("nope/x", s)).toContain('"nope" is not a provider Tropos knows');
  expect(modelProblem("nope/x", s)).toContain("deepseek");
  expect(modelProblem("gpt-5", s)).toContain("<provider>/<model>");
  expect(modelProblem("deepseek/", s)).toContain("deepseek/<model>");
});

test("a provider that needs a key and has none is refused, naming the ready ones", async () => {
  const why = modelProblem("deepseek/deepseek-chat", await statuses());
  expect(why).toContain("DeepSeek isn't connected");
  expect(why).toContain("anthropic");
  expect(why).not.toContain("deepseek,");
});
