import { afterEach, describe, expect, test } from "bun:test";

import type { ProviderInfoView } from "@core/web/protocol";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent, within, waitFor } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ModelPicker } = await import("@/components/chat/ModelPicker");
const { connectedStore, withProviders, wait } = await import("@/components/chat/chat-test-kit");

afterEach(() => {
  cleanup();
});

const PROVIDERS: ProviderInfoView[] = [
  { id: "anthropic", name: "Anthropic", keyRequired: true, keyURL: null, keyEnv: ["ANTHROPIC_API_KEY"], key: { kind: "env", name: "ANTHROPIC_API_KEY" } },
  { id: "openrouter", name: "OpenRouter", keyRequired: true, keyURL: null, keyEnv: [], key: { kind: "saved" } },
  { id: "openai", name: "OpenAI", keyRequired: true, keyURL: null, keyEnv: [], key: null },
];

const MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5"],
  openrouter: ["qwen/qwen3-coder"],
  openai: ["gpt-5.2"],
};

async function open() {
  let favorites = ["claude-sonnet-5"];
  const ctx = connectedStore({
    "providers.status": () => PROVIDERS,
    "providers.models": (id) => MODELS[String(id)] ?? [],
    "modelPrefs.get": () => ({ recent: ["openrouter/qwen/qwen3-coder"], favorites }),
    "modelPrefs.toggleFavorite": (id) => {
      const on = !favorites.includes(String(id));
      favorites = on ? [...favorites, String(id)] : favorites.filter((f) => f !== id);
      return on;
    },
    setModel: () => null,
    setEffort: () => null,
    "modelPrefs.recordUse": () => null,
  });
  let closed = 0;
  render(withProviders(ctx.store, createElement(ModelPicker, { open: true, onClose: () => closed++ })));
  await act(() => wait(40));
  await screen.findByRole("dialog", { name: "Select model" });
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(3));
  const search = screen.getByRole("combobox", { name: "Search models" }) as HTMLInputElement;
  const key = (k: string, init: Record<string, unknown> = {}) => act(async () => void fireEvent.keyDown(search, { key: k, ...init }));
  return { ...ctx, search, key, closed: () => closed };
}

const optionNames = () => screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"));

describe("ModelPicker", () => {
  test("lists Favorites, Recent and one section per ready provider; starts on the current model", async () => {
    await open();
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Favorites", "Recent", "Anthropic", "OpenRouter"]);
    expect(within(screen.getByRole("group", { name: "Favorites" })).getAllByRole("option")[0]!.getAttribute("aria-label")).toBe("claude-sonnet-5, favourite");
    // OpenAI has no key: not listed.
    expect(optionNames().some((n) => n?.includes("gpt"))).toBe(false);
    const selected = screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")!;
    expect(selected.getAttribute("aria-label")).toBe("claude-opus-5-5, current");
  });

  test("search narrows to matching models across providers", async () => {
    const { search } = await open();
    await act(async () => void fireEvent.change(search, { target: { value: "qwen" } }));
    expect(optionNames()).toEqual(["openrouter/qwen/qwen3-coder"]);
    await act(async () => void fireEvent.change(search, { target: { value: "zzz" } }));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("listbox").textContent).toContain("No model matches");
  });

  test("Esc clears the search first, then closes", async () => {
    const { search, key, closed } = await open();
    await act(async () => void fireEvent.change(search, { target: { value: "son" } }));
    await key("Escape");
    expect(search.value).toBe("");
    expect(closed()).toBe(0);
  });

  test("Ctrl+F stars the highlighted model", async () => {
    const { socket, key } = await open();
    await key("ArrowDown");
    const selected = screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")!;
    expect(selected.getAttribute("aria-label")).toBe("claude-sonnet-5, favourite");
    await key("f", { ctrlKey: true });
    await act(() => wait(10));
    expect(socket.rpcs("modelPrefs.toggleFavorite").at(-1)?.params).toBe("claude-sonnet-5");
    expect(within(screen.getByRole("group", { name: "Anthropic" })).getAllByRole("option")[1]!.getAttribute("aria-label")).toBe("claude-sonnet-5");
  });

  test("Enter picks the highlighted model with the chosen effort, records it and closes", async () => {
    const { store, socket, search, key, closed } = await open();
    await act(async () => void fireEvent.change(search, { target: { value: "qwen" } }));
    const slider = screen.getByRole("slider");
    await act(async () => void fireEvent.keyDown(slider, { key: "ArrowRight" }));
    expect(slider.getAttribute("aria-valuetext")).toContain("xhigh");
    await key("Enter");
    await act(() => wait(20));
    expect(socket.rpcs("setModel")[0]?.params).toBe("openrouter/qwen/qwen3-coder");
    expect(socket.rpcs("setEffort")[0]?.params).toBe("xhigh");
    expect(socket.rpcs("modelPrefs.recordUse")[0]?.params).toBe("openrouter/qwen/qwen3-coder");
    expect(store.getState().toasts.at(-1)).toMatchObject({ tone: "ok", title: "Model set to openrouter/qwen/qwen3-coder", description: "xhigh effort" });
    expect(closed()).toBe(1);
  });
});
