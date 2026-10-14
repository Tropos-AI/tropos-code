import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ChatPage } = await import("@/app/pages/ChatPage");
const { connectedStore, withProviders, IDLE } = await import("@/components/chat/chat-test-kit");

afterEach(() => {
  cleanup();
});

function mount() {
  const ctx = connectedStore();
  render(withProviders(ctx.store, createElement(ChatPage)));
  return ctx;
}

describe("ChatPage", () => {
  test("an empty session offers starters that fill the message box", async () => {
    mount();
    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "/init" })));
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("/init");
  });

  test("streams the reply with a caret, then settles it when the turn ends", async () => {
    const { socket } = mount();
    await act(async () => {
      socket.deliver({ t: "user", text: "sent from another tab" });
      socket.deliver({ t: "state", state: { ...IDLE, busy: true, turnStartedAt: Date.now() } });
      socket.deliver({ t: "event", event: { type: "text", delta: "Working on **it**" } });
    });
    expect(screen.getByRole("article", { name: "You" }).textContent).toBe("sent from another tab");
    const reply = screen.getByRole("article", { name: "Tropos" });
    expect(reply.textContent?.trim()).toBe("Working on it");
    expect(reply.querySelector('[data-streaming="true"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Interrupt Tropos" })).toBeTruthy();

    await act(async () => {
      socket.deliver({ t: "event", event: { type: "tool_start", id: "t1", name: "Bash", summary: "ls", input: { command: "ls" } } });
      socket.deliver({ t: "event", event: { type: "turn_end", reason: "end_turn" } });
      socket.deliver({ t: "state", state: IDLE });
    });
    expect(screen.getByRole("article", { name: "Tropos" }).querySelector('[data-streaming="true"]')).toBeNull();
    expect(screen.getByRole("article", { name: /Bash ls/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });
});
