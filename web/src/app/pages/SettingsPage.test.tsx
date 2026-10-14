import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ProviderInfoView } from "@core/web/protocol";

import { mountPage, stubMatchMedia, type MountedPage } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { createElement, Fragment } = await import("react");
const { SettingsPage, tabFromHash } = await import("@/app/pages/SettingsPage");
const { redactKey } = await import("@/components/pages/settings/connect-form");
const { ui, useModelPickerOpen } = await import("@/lib/ui-store");

const SECRET = "sk-test-VERY-SECRET-123456";

function providers(): { list: ProviderInfoView[]; saved: Set<string> } {
  const saved = new Set(["openrouter"]);
  const base: ProviderInfoView[] = [
    { id: "anthropic", name: "Anthropic", keyRequired: false, keyURL: "https://platform.claude.com/settings/keys", keyEnv: ["ANTHROPIC_API_KEY"], noKeyNote: "ANTHROPIC_API_KEY or `ant auth login`", key: { kind: "env", name: "ANTHROPIC_API_KEY" } },
    { id: "openai", name: "OpenAI", keyRequired: true, keyURL: "https://platform.openai.com/api-keys", keyEnv: ["OPENAI_API_KEY"], key: null },
    { id: "openrouter", name: "OpenRouter", keyRequired: true, keyURL: "https://openrouter.ai/settings/keys", keyEnv: ["OPENROUTER_API_KEY"], key: null },
    { id: "ollama", name: "Ollama", keyRequired: false, keyURL: null, keyEnv: [], key: null },
  ];
  return {
    saved,
    get list() {
      return base.map((p) => (p.key?.kind === "env" ? p : { ...p, key: saved.has(p.id) ? { kind: "saved" as const } : null }));
    },
  };
}

function PickerProbe() {
  return createElement("output", { "aria-label": "picker" }, useModelPickerOpen() ? "open" : "closed");
}

function WithProbe() {
  return createElement(Fragment, null, createElement(SettingsPage), createElement(PickerProbe));
}

async function mountSettings(overrides: Parameters<typeof mountPage>[1] = {}): Promise<MountedPage & { state: ReturnType<typeof providers> }> {
  const state = providers();
  const mounted = await mountPage(WithProbe, {
    "providers.status": () => state.list,
    "providers.connect": (params) => {
      state.saved.add((params as { id: string }).id);
      return null;
    },
    "providers.disconnect": (id) => state.saved.delete(String(id)),
    "modelPrefs.get": () => ({ favorites: ["claude-opus-5-5"], recent: ["claude-opus-5-5", "openrouter/qwen/qwen3-coder"] }),
    "modelPrefs.toggleFavorite": () => true,
    ...overrides,
  });
  return { ...mounted, state };
}

/** Lets exit animations finish: two animation frames inside act(). */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

/** True when the key shows up anywhere in the DOM: markup, attributes or a live input value. */
function keyInDom(key: string): boolean {
  if (document.body.innerHTML.includes(key)) return true;
  return Array.from(document.querySelectorAll("input")).some((input) => input.value.includes(key));
}

function row(name: string): HTMLElement {
  return screen.getByText(name, { selector: "strong" }).closest("li")!;
}

beforeEach(() => {
  stubMatchMedia();
  window.history.replaceState(null, "", "#/settings");
  ui.closeModelPicker();
});
afterEach(() => cleanup());

describe("helpers", () => {
  test("tabFromHash reads the sub-route", () => {
    expect(tabFromHash("#/settings/model")).toBe("model");
    expect(tabFromHash("#/settings/about")).toBe("about");
    expect(tabFromHash("#/settings")).toBe("providers");
    expect(tabFromHash("#/settings/nope")).toBe("providers");
  });

  test("redactKey hides a key inside an error message", () => {
    expect(redactKey(`bad key ${SECRET}`, SECRET)).toBe("bad key ••••");
  });
});

describe("Settings › Providers", () => {
  test("lists providers with how each is connected, never a key", async () => {
    await mountSettings();
    await screen.findByText("Anthropic", { selector: "strong" });
    expect(row("Anthropic").textContent).toContain("connected · ANTHROPIC_API_KEY");
    expect(row("Anthropic").textContent).toContain("in use");
    expect(row("OpenRouter").textContent).toContain("connected · saved key");
    expect(row("OpenAI").textContent).toContain("not connected");
    expect(row("Ollama").textContent).toContain("no key needed");
    expect(within(row("OpenRouter")).getByRole("button", { name: "Disconnect OpenRouter" })).toBeTruthy();
    expect(within(row("Anthropic")).queryByRole("button", { name: /Disconnect|Connect/ })).toBeNull();
    expect(within(row("Ollama")).queryByRole("button")).toBeNull();
  });

  test("connect: validates, sends the key once, clears it from the DOM and refreshes", async () => {
    const { socket, store } = await mountSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    const form = screen.getByRole("form", { name: "Connect OpenAI" });
    const field = within(form).getByLabelText("OpenAI API key") as HTMLInputElement;
    expect(field.type).toBe("password");

    // Empty submit: inline validation, no RPC.
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(form.textContent).toContain("Paste a key first.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(socket.callsOf("providers.connect")).toHaveLength(0);

    fireEvent.change(field, { target: { value: `  ${SECRET}  ` } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(keyInDom(SECRET)).toBe(false);
    await waitFor(() => expect(socket.callsOf("providers.connect")).toEqual([{ method: "providers.connect", params: { id: "openai", key: SECRET } }]));
    await waitFor(() => expect(row("OpenAI").textContent).toContain("connected · saved key"));
    await settle();
    expect(screen.queryByRole("form", { name: "Connect OpenAI" })).toBeNull();
    expect(socket.callsOf("providers.status").length).toBeGreaterThanOrEqual(2);
    expect(store.getState().toasts.map((t) => t.title)).toContain("Connected OpenAI");
    expect(keyInDom(SECRET)).toBe(false);
    // Only the connect frame carried the key.
    expect(socket.frames.filter((f) => f.includes(SECRET))).toHaveLength(1);
  });

  test("connect failure: the error is shown with the key redacted, and the field is empty", async () => {
    await mountSettings({
      "providers.connect": (params) => {
        throw new Error(`rejected key ${(params as { key: string }).key}`);
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    const form = screen.getByRole("form", { name: "Connect OpenAI" });
    fireEvent.change(within(form).getByLabelText("OpenAI API key"), { target: { value: SECRET } });
    await act(async () => {
      fireEvent.submit(form);
    });
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("rejected key ••••");
    expect(keyInDom(SECRET)).toBe(false);
    expect((within(form).getByLabelText("OpenAI API key") as HTMLInputElement).value).toBe("");
  });

  test("Cancel closes the form; Create a key opens the provider's page safely", async () => {
    await mountSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    const link = screen.getByRole("link", { name: /Create a key/ });
    expect(link.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(screen.queryByRole("form", { name: "Connect OpenAI" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect OpenAI" })).toBeTruthy();
  });

  test("disconnect removes a saved key and refreshes", async () => {
    const { socket, store } = await mountSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect OpenRouter" }));
    await waitFor(() => expect(row("OpenRouter").textContent).toContain("not connected"));
    expect(socket.callsOf("providers.disconnect")).toEqual([{ method: "providers.disconnect", params: "openrouter" }]);
    expect(store.getState().toasts.map((t) => t.title)).toContain("Disconnected OpenRouter");
    expect(within(row("OpenRouter")).getByRole("button", { name: "Connect OpenRouter" })).toBeTruthy();
  });

  test("a failed status load shows Retry", async () => {
    let calls = 0;
    await mountSettings({
      "providers.status": () => {
        calls += 1;
        if (calls === 1) throw new Error("credentials unreadable");
        return providers().list;
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("credentials unreadable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Anthropic", { selector: "strong" })).toBeTruthy();
  });
});

describe("Settings › Model and About", () => {
  test("Model shows the session's model, opens the picker, and lists favourites and recent", async () => {
    const { socket } = await mountSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Model" }));
    expect(window.location.hash).toBe("#/settings/model");
    const panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("This session")).toBeTruthy();
    expect(screen.getByRole("status", { name: "picker" }).textContent).toBe("closed");
    fireEvent.click(within(panel).getByRole("button", { name: /Change model/ }));
    expect(screen.getByRole("status", { name: "picker" }).textContent).toBe("open");

    const favourites = await within(panel).findByRole("region", { name: "Favourites" });
    expect(favourites.textContent).toContain("claude-opus-5-5");
    expect(within(favourites).getByText("current")).toBeTruthy();
    const recent = within(panel).getByRole("region", { name: "Recent" });
    expect(recent.textContent).toContain("qwen/qwen3-coder");
    expect(recent.textContent).toContain("OpenRouter");
    fireEvent.click(within(recent).getByRole("button", { name: "Add openrouter/qwen/qwen3-coder to favourites" }));
    await waitFor(() => expect(socket.callsOf("modelPrefs.toggleFavorite")).toEqual([{ method: "modelPrefs.toggleFavorite", params: "openrouter/qwen/qwen3-coder" }]));
  });

  test("About shows version, cwd and session id with copy buttons", async () => {
    await mountSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "About" }));
    const panel = await screen.findByRole("tabpanel");
    expect(panel.textContent).toContain("0.3.0");
    expect(panel.textContent).toContain("/repo");
    expect(panel.textContent).toContain("6f1c2d9a-4b7e-4e21-9c3a-1d2e3f4a5b6c");
    for (const label of ["Copy the version", "Copy the working directory", "Copy the session id"]) {
      expect(within(panel).getByRole("button", { name: label })).toBeTruthy();
    }
    const docs = within(panel).getByRole("link", { name: /README/ });
    expect(docs.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
