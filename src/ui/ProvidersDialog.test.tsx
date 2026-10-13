// src/ui/ProvidersDialog.test.tsx
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ProviderInfo } from "../providers/registry";
import type { ProviderStatus } from "../providers/router";
import { ProvidersDialog } from "./ProvidersDialog";
import type { ProviderControl } from "./runtime";

const tick = () => Bun.sleep(30);
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";

const info = (id: string, name: string, over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id,
  name,
  api: "chat",
  baseURL: `https://${id}.test/v1`,
  keyEnv: [`${id.toUpperCase()}_API_KEY`],
  keyRequired: true,
  keyURL: `https://${id}.test/keys`,
  capabilities: { maxTokensParam: null, streamUsage: true },
  ...over,
});

function fakeControl(models: Record<string, string[] | Error> = {}) {
  const keys = new Map<string, string>([["deepseek", "saved"]]);
  const log: string[] = [];
  const providers = [
    info("anthropic", "Anthropic", { api: "anthropic", keyRequired: false, noKeyNote: "ANTHROPIC_API_KEY or ant auth login" }),
    info("deepseek", "DeepSeek"),
    info("xai", "xAI"),
    info("ollama", "Ollama", { keyRequired: false, keyEnv: [] }),
  ];
  const control: ProviderControl = {
    status: async (): Promise<ProviderStatus[]> =>
      providers.map((p) => ({ info: p, baseURL: p.baseURL, key: keys.has(p.id) ? { kind: "saved" } : p.id === "xai" && keys.has("env-xai") ? { kind: "env", name: "XAI_API_KEY" } : null })),
    connect: async (id, key) => {
      if (key === "bad key") throw new Error("The API key contains spaces or line breaks; paste just the key.");
      log.push(`connect ${id} ${key}`);
      keys.set(id, key);
    },
    disconnect: async (id) => (log.push(`disconnect ${id}`), keys.delete(id)),
    models: async (id) => {
      const m = models[id];
      if (m instanceof Error) throw m;
      return m ?? [];
    },
  };
  return { control, log, keys };
}

function open(control: ProviderControl, currentModel = "claude-opus-5-5") {
  const picked: string[] = [];
  let closed = 0;
  const r = render(<ProvidersDialog control={control} currentModel={currentModel} onPick={(m) => picked.push(m)} onClose={() => closed++} />);
  return { r, picked, closed: () => closed };
}

describe("ProvidersDialog", () => {
  test("lists providers with their connection state", async () => {
    const { r } = open(fakeControl().control);
    await tick();
    const frame = r.lastFrame()!;
    expect(frame).toContain("Providers");
    expect(frame).toMatch(/Anthropic\s+● ANTHROPIC_API_KEY or ant auth login · in use/);
    expect(frame).toMatch(/DeepSeek\s+● connected · saved key/);
    expect(frame).toMatch(/xAI\s+○ not connected/);
    expect(frame).toMatch(/Ollama\s+● no key needed/);
  });

  test("a connected provider goes straight to its models; typing filters; enter picks", async () => {
    const { r, picked } = open(fakeControl({ deepseek: ["deepseek-chat", "deepseek-reasoner"] }).control);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(r.lastFrame()).toContain("DeepSeek models");
    expect(r.lastFrame()).toContain("deepseek-reasoner");
    r.stdin.write("reas");
    await tick();
    expect(r.lastFrame()).not.toContain("deepseek-chat");
    r.stdin.write(ENTER);
    await tick();
    expect(picked).toEqual(["deepseek/deepseek-reasoner"]);
  });

  test("an unconnected provider asks for a key first, masks it, saves it, then lists models", async () => {
    const { control, log } = fakeControl({ xai: ["grok-code"] });
    const { r, picked } = open(control);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(r.lastFrame()).toContain("Connect xAI");
    expect(r.lastFrame()).toContain("https://xai.test/keys");
    r.stdin.write("xai-secret-1");
    await tick();
    r.stdin.write(BACKSPACE);
    await tick();
    expect(r.lastFrame()).not.toContain("xai-secret");
    expect(r.lastFrame()).toContain("•".repeat(11));
    r.stdin.write(ENTER);
    await tick();
    await tick();
    expect(log).toEqual(["connect xai xai-secret-"]);
    expect(r.lastFrame()).toContain("xAI models");
    r.stdin.write(ENTER);
    await tick();
    expect(picked).toEqual(["xai/grok-code"]);
  });

  test("a rejected key shows the error and stays on the key step", async () => {
    const { r } = open(fakeControl().control);
    await tick();
    r.stdin.write(DOWN + DOWN);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    r.stdin.write("bad key");
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(r.lastFrame()).toContain("Connect xAI");
    expect(r.lastFrame()).toContain("paste just the key");
  });

  test("when the model list fails, the typed text is used as the model id", async () => {
    const { r, picked } = open(fakeControl({ deepseek: new Error("timeout") }).control);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(r.lastFrame()).toContain("Could not list models: timeout");
    r.stdin.write("deepseek-chat");
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(picked).toEqual(["deepseek/deepseek-chat"]);
  });

  test("d removes a saved key, k replaces one, esc steps back and then closes", async () => {
    const { control, log } = fakeControl();
    const { r, closed } = open(control);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write("d");
    await tick();
    await tick();
    expect(log).toEqual(["disconnect deepseek"]);
    expect(r.lastFrame()).toMatch(/DeepSeek\s+○ not connected/);
    r.stdin.write("k");
    await tick();
    expect(r.lastFrame()).toContain("Connect DeepSeek");
    r.stdin.write(ESC);
    await tick();
    expect(r.lastFrame()).toContain("Providers");
    r.stdin.write(ESC);
    await tick();
    expect(closed()).toBe(1);
  });

  test("marks the provider and model in use", async () => {
    const { r } = open(fakeControl({ deepseek: ["deepseek-chat", "deepseek-reasoner"] }).control, "deepseek/deepseek-chat");
    await tick();
    expect(r.lastFrame()).toMatch(/DeepSeek\s+● connected · saved key · in use/);
    expect(r.lastFrame()).not.toMatch(/Anthropic.*in use/);
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(r.lastFrame()).toContain("deepseek-chat (current)");
  });
});
