// src/providers/router.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeModel, reply, textBlock } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { TurnRequest } from "../api/model";
import { readCredentials } from "./credentials";
import { PROVIDERS, clampEffort, parseModelId, ModelIdError } from "./registry";
import { ProviderRouter, allProviders } from "./router";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("router-");
});
afterEach(() => removeDir(dir));

const req = (model: string): TurnRequest => ({ model, effort: "high", system: "S", tools: [], messages: [{ role: "user", content: "hi" }], refusalFallback: true });
const handlers = { onText() {}, onThinking() {} };
const signal = () => new AbortController().signal;

function sse(text: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}

describe("parseModelId", () => {
  test("a provider prefix picks the provider; anything else is Anthropic", () => {
    expect(parseModelId("deepseek/deepseek-chat")).toMatchObject({ provider: { id: "deepseek" }, model: "deepseek-chat" });
    expect(parseModelId("openrouter/qwen/qwen3-coder")).toMatchObject({ provider: { id: "openrouter" }, model: "qwen/qwen3-coder" });
    expect(parseModelId("claude-opus-5-5")).toMatchObject({ provider: { id: "anthropic" }, model: "claude-opus-5-5" });
    expect(parseModelId("anthropic/claude-opus-5-5")).toMatchObject({ provider: { id: "anthropic" }, model: "claude-opus-5-5" });
    expect(parseModelId("not-a-provider/x")).toMatchObject({ provider: { id: "anthropic" }, model: "not-a-provider/x" });
    expect(() => parseModelId("deepseek/")).toThrow(ModelIdError);
  });

  test("provider ids are unique, lowercase, and every key-needing provider names an env var", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDERS) {
      expect(p.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      if (p.keyRequired) expect(p.keyEnv.length).toBeGreaterThan(0);
      expect(p.baseURL).toMatch(/^https?:\/\//);
    }
  });
});

test("clampEffort picks the closest level at or below, else the lowest", () => {
  expect(clampEffort("xhigh", ["low", "high", "max"])).toBe("high");
  expect(clampEffort("medium", ["low", "high", "max"])).toBe("low");
  expect(clampEffort("max", ["low", "medium", "high"])).toBe("high");
  expect(clampEffort("low", ["high", "max"])).toBe("high");
  expect(clampEffort("high", ["low", "high"])).toBe("high");
});

test("the registry's effort mappings only send values each provider accepts", () => {
  const deepseek = PROVIDERS.find((p) => p.id === "deepseek")!.capabilities.effort!;
  expect(["low", "medium", "high", "xhigh", "max"].map((e) => deepseek(e as never, "m"))).toEqual([
    { reasoning_effort: "low" },
    { reasoning_effort: "low" },
    { reasoning_effort: "high" },
    { reasoning_effort: "high" },
    { reasoning_effort: "max" },
  ]);
  expect(PROVIDERS.find((p) => p.id === "openrouter")!.capabilities.effort!("xhigh", "m")).toEqual({ reasoning: { effort: "xhigh" } });
});

describe("ProviderRouter", () => {
  test("sends Anthropic models to the Anthropic client without the prefix", async () => {
    const seen: string[] = [];
    const fake = new FakeModel([(r) => (seen.push(r.model), reply([textBlock("a")])), (r) => (seen.push(r.model), reply([textBlock("b")]))]);
    const router = new ProviderRouter({ home: dir, env: {}, settings: {}, anthropic: () => fake });
    await router.send(req("claude-opus-5-5"), handlers, signal());
    await router.send(req("anthropic/claude-opus-5-5"), handlers, signal());
    expect(seen).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
  });

  test("a saved Anthropic key is used only when ANTHROPIC_API_KEY is unset", async () => {
    const keys: Array<string | undefined> = [];
    const make = (key: string | undefined) => (keys.push(key), new FakeModel([() => reply([textBlock("x")])]));
    await new ProviderRouter({ home: dir, env: {}, settings: {}, anthropic: make }).connect("anthropic", "sk-saved");
    await new ProviderRouter({ home: dir, env: {}, settings: {}, anthropic: make }).send(req("claude-opus-5-5"), handlers, signal());
    await new ProviderRouter({ home: dir, env: { ANTHROPIC_API_KEY: "sk-env" }, settings: {}, anthropic: make }).send(req("claude-opus-5-5"), handlers, signal());
    expect(keys).toEqual(["sk-saved", undefined]);
  });

  test("chat providers get the key from env or the saved file, read at request time", async () => {
    const calls: Array<{ url: string; auth?: string; model: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization, model: JSON.parse(String(init.body)).model });
      return sse("ok");
    }) as unknown as typeof fetch;
    const router = new ProviderRouter({ home: dir, env: {}, settings: {}, fetch: fetchImpl });
    await expect(router.send(req("deepseek/deepseek-chat"), handlers, signal())).rejects.toThrow("No API key for DeepSeek");
    await router.connect("deepseek", "sk-saved");
    await router.send(req("deepseek/deepseek-chat"), handlers, signal());
    const withEnv = new ProviderRouter({ home: dir, env: { DEEPSEEK_API_KEY: "sk-env" }, settings: {}, fetch: fetchImpl });
    await withEnv.send(req("deepseek/deepseek-chat"), handlers, signal());
    expect(calls.map((c) => [c.auth, c.model])).toEqual([
      ["Bearer sk-saved", "deepseek-chat"],
      ["Bearer sk-env", "deepseek-chat"],
    ]);
  });

  test("user settings override a base URL and add custom endpoints", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => (urls.push(url), sse("ok"))) as unknown as typeof fetch;
    const router = new ProviderRouter({
      home: dir,
      env: { MY_VLLM_API_KEY: "k" },
      settings: { deepseek: { baseURL: "https://proxy.example/v1" }, "my-vllm": { baseURL: "http://gpu:8000/v1", name: "My vLLM" } },
      fetch: fetchImpl,
    });
    await router.connect("deepseek", "k");
    await router.send(req("deepseek/deepseek-chat"), handlers, signal());
    await router.send(req("my-vllm/qwen3-coder"), handlers, signal());
    expect(urls).toEqual(["https://proxy.example/v1/chat/completions", "http://gpu:8000/v1/chat/completions"]);
    const status = await router.status();
    expect(status.find((s) => s.info.id === "my-vllm")).toMatchObject({ info: { name: "My vLLM" }, key: { kind: "env", name: "MY_VLLM_API_KEY" } });
    expect(status.find((s) => s.info.id === "deepseek")!.baseURL).toBe("https://proxy.example/v1");
  });

  test("a settings entry for a built-in provider never duplicates it", () => {
    expect(allProviders({ deepseek: { baseURL: "https://x/v1" } }).filter((p) => p.id === "deepseek")).toHaveLength(1);
    expect(allProviders({ odd: {} }).some((p) => p.id === "odd")).toBe(false);
  });

  test("status, connect and disconnect", async () => {
    const router = new ProviderRouter({ home: dir, env: { XAI_API_KEY: "x" }, settings: {} });
    await router.connect("deepseek", "sk-1");
    const status = await router.status();
    expect(status.find((s) => s.info.id === "xai")!.key).toEqual({ kind: "env", name: "XAI_API_KEY" });
    expect(status.find((s) => s.info.id === "deepseek")!.key).toEqual({ kind: "saved" });
    expect(status.find((s) => s.info.id === "openai")!.key).toBeNull();
    expect(await router.disconnect("deepseek")).toBe(true);
    expect(await readCredentials(dir)).toEqual({});
  });

  test("models() lists a chat provider's models", async () => {
    const fetchImpl = (async () => Response.json({ data: [{ id: "deepseek-reasoner" }, { id: "deepseek-chat" }] })) as unknown as typeof fetch;
    const router = new ProviderRouter({ home: dir, env: { DEEPSEEK_API_KEY: "k" }, settings: {}, fetch: fetchImpl });
    expect(await router.models("deepseek", signal())).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    await expect(router.models("nope", signal())).rejects.toThrow("Unknown provider");
  });
});

describe("registry key pages", () => {
  test("every provider that needs a key, and Anthropic, has an https key page; Anthropic is first", () => {
    expect(PROVIDERS[0]!.id).toBe("anthropic");
    for (const p of PROVIDERS.filter((x) => x.keyRequired || x.id === "anthropic")) expect(p.keyURL).toStartWith("https://");
  });
});
