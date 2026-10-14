import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { Composer } = await import("@/components/chat/Composer");
const { connectedStore, withProviders, wait, IDLE } = await import("@/components/chat/chat-test-kit");
const { ui } = await import("@/lib/ui-store");

afterEach(() => {
  cleanup();
  ui.closePanel();
  ui.closeModelPicker();
});

function Harness() {
  const [value, setValue] = useState("");
  return createElement(Composer, { value, onValueChange: setValue });
}

function mount(handlers = {}) {
  const ctx = connectedStore(handlers);
  render(withProviders(ctx.store, createElement(Harness)));
  const box = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(box, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  const key = (k: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(box, { key: k, ...init });
  return { ...ctx, box, type, key };
}

describe("Composer", () => {
  test("Enter sends the message and clears the box; Shift+Enter does not send", () => {
    const { socket, box, type, key } = mount();
    type("line one");
    key("Enter", { shiftKey: true });
    expect(socket.rpcs("prompt")).toHaveLength(0);
    key("Enter");
    expect(socket.rpcs("prompt")[0]?.params).toEqual({ text: "line one" });
    expect(box.value).toBe("");
  });

  test("the send button is disabled while empty and sends what is typed", () => {
    const { socket, type } = mount();
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type("from the button");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(socket.rpcs("prompt")[0]?.params).toEqual({ text: "from the button" });
  });

  test("slash suggestions: ranked, coloured by kind, arrow keys move, Escape closes", () => {
    const { box, type, key } = mount();
    type("/");
    const list = screen.getByRole("listbox", { name: "Commands" });
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-controls")).toBe(list.id);
    const options = screen.getAllByRole("option");
    // Built-ins first, then custom commands and skills, each tagged.
    expect(options[0]!.textContent).toContain("/help");
    const review = options.find((o) => o.textContent?.includes("/review"))!;
    expect(review.textContent).toContain("custom");
    expect(review.querySelector(".text-accent-ink")).toBeTruthy();
    const skill = options.find((o) => o.textContent?.includes("/frontend-design"))!;
    expect(skill.textContent).toContain("skill");
    expect(skill.querySelector(".text-violet")).toBeTruthy();

    type("/he");
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("/help");
    expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    key("ArrowDown");
    const selected = screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")!;
    expect(box.getAttribute("aria-activedescendant")).toBe(selected.id);
    key("Escape");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.hasAttribute("aria-activedescendant")).toBe(false);
    expect(box.hasAttribute("aria-controls")).toBe(false);
  });

  test("Tab completes a command and leaves room for its argument", () => {
    const { box, type, key } = mount();
    type("/mod");
    key("Tab");
    expect(box.value).toBe("/model ");
    expect(box.getAttribute("aria-expanded")).toBe("false");
  });

  test("Enter on a suggested command without arguments runs it: /help opens the help panel, nothing is sent", async () => {
    const { socket, box, type, key } = mount();
    const { useChatPanel } = await import("@/lib/ui-store");
    const seen: { panel: string | null } = { panel: null };
    function Probe() {
      seen.panel = useChatPanel();
      return null;
    }
    render(createElement(Probe));
    type("/hel");
    await act(async () => key("Enter"));
    expect(seen.panel).toBe("help");
    expect(box.value).toBe("");
    expect(socket.rpcs("prompt")).toHaveLength(0);
  });

  test("@ suggests files from the server and inserts the chosen path", async () => {
    const { socket, box, type, key } = mount({ completeFile: () => ["@web/src/", "@web/vite.config.ts"] });
    type("look at @we");
    await act(() => wait(150));
    expect(socket.rpcs("completeFile")[0]?.params).toEqual({ token: "@we" });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["web/src/", "web/vite.config.ts"]);
    key("ArrowDown");
    key("Enter");
    expect(box.value).toBe("look at @web/vite.config.ts ");
    expect(socket.rpcs("prompt")).toHaveLength(0);
  });

  test("while busy, sending queues: a chip appears, × removes it, clicking edits it", async () => {
    const { store, socket, box, type, key } = mount();
    await act(async () => socket.deliver({ t: "state", state: { ...IDLE, busy: true } }));
    expect(box.getAttribute("placeholder")).toBe("Queue a follow-up…");
    type("first follow-up");
    expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();
    await act(async () => key("Enter"));
    type("second");
    await act(async () => key("Enter"));
    expect(socket.rpcs("prompt")).toHaveLength(0);
    const queue = screen.getByRole("region", { name: "Queued messages" });
    expect(queue.textContent).toContain("first follow-up");
    expect(store.getState().queue.map((q) => q.text)).toEqual(["first follow-up", "second"]);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove queued message 2" })));
    expect(store.getState().queue.map((q) => q.text)).toEqual(["first follow-up"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Edit queued message 1/ })));
    expect(store.getState().queue).toEqual([]);
    expect(box.value).toBe("first follow-up");
  });

  test("session commands wait for the turn and say so", async () => {
    const { store, socket, type, key } = mount();
    await act(async () => socket.deliver({ t: "state", state: { ...IDLE, busy: true } }));
    type("/clear");
    await act(async () => key("Enter"));
    expect(socket.rpcs("clear")).toHaveLength(0);
    expect(store.getState().toasts.at(-1)?.title).toBe("/clear has to wait for the turn to finish");
  });

  test("the send button turns into interrupt while busy; it and Esc interrupt", async () => {
    const { socket, key } = mount();
    await act(async () => socket.deliver({ t: "state", state: { ...IDLE, busy: true } }));
    const stop = screen.getByRole("button", { name: "Interrupt Tropos" });
    expect(stop.getAttribute("aria-keyshortcuts")).toBe("Escape");
    await act(async () => fireEvent.click(stop));
    expect(socket.rpcs("interrupt")).toHaveLength(1);
    await act(async () => key("Escape"));
    expect(socket.rpcs("interrupt")).toHaveLength(2);
  });

  test("interrupting with messages queued pauses them; ↑ on an empty box takes them back to edit", async () => {
    const { store, socket, box, type, key } = mount();
    await act(async () => socket.deliver({ t: "state", state: { ...IDLE, busy: true } }));
    type("later");
    await act(async () => key("Enter"));
    await act(async () => key("Escape"));
    expect(store.getState().queuePaused).toBe(true);
    expect(screen.getByRole("region", { name: "Queued messages" }).textContent).toContain("Paused after interrupt");
    await act(async () => key("ArrowUp"));
    expect(box.value).toBe("later");
    expect(store.getState().queue).toEqual([]);
  });

  test("the mode control lists the server's modes and sets one", async () => {
    const { socket } = mount({ setMode: () => null });
    const group = screen.getByRole("radiogroup", { name: "Permission mode" });
    const radios = Array.from(group.querySelectorAll('[role="radio"]')).map((r) => r.textContent);
    expect(radios).toEqual(["Default", "Accept edits", "Plan"]);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Plan" })));
    expect(socket.rpcs("setMode")[0]?.params).toBe("plan");
  });
});
