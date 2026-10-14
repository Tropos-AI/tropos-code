// web/src/app/layout/Toasts.test.tsx — the toast stack: tone → role, dismiss button, self-dismiss unless hovered/focused.
import { afterEach, describe, expect, jest, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { Toasts } = await import("@/app/layout/Toasts");
const { connectedStore, withProviders, wait } = await import("@/components/chat/chat-test-kit");

afterEach(() => {
  jest.useRealTimers();
  cleanup();
});

function mount() {
  const ctx = connectedStore();
  render(withProviders(ctx.store, createElement(Toasts)));
  const titles = () => ctx.store.getState().toasts.map((t) => t.title);
  /** Moves the fake clock on by `ms` (call jest.useFakeTimers() before the toast is raised). */
  const advance = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));
  return { ...ctx, titles, advance };
}

describe("Toasts", () => {
  test("lists toasts in a Notifications region; errors are alerts, the rest are status", async () => {
    const { store } = mount();
    await act(async () => {
      store.toast({ tone: "ok", title: "Saved", description: "All good" });
      store.toast({ tone: "error", title: "Broke", description: "Line one\nLine two" });
    });
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region.textContent).toContain("Saved");
    expect(screen.getByRole("status").textContent).toContain("All good");
    expect(screen.getByRole("alert").textContent).toContain("Broke");
    expect(screen.getByRole("alert").textContent).toContain("Line one\nLine two");
  });

  test("a toast without a description shows only its title", async () => {
    const { store } = mount();
    await act(async () => store.toast({ tone: "warn", title: "Careful" }));
    const card = screen.getByRole("status");
    expect(card.querySelectorAll("p")).toHaveLength(1);
    expect(card.textContent).toContain("Careful");
  });

  test("the close button dismisses it", async () => {
    const { store, titles } = mount();
    await act(async () => store.toast({ tone: "info", title: "Hello" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      await wait(10);
    });
    expect(titles()).toEqual([]);
  });

  test("dismisses itself after its lifetime; errors linger longer", async () => {
    jest.useFakeTimers();
    const { store, titles, advance } = mount();
    await act(async () => {
      store.toast({ tone: "info", title: "Info" });
      store.toast({ tone: "error", title: "Error" });
    });
    await advance(4400);
    expect(titles()).toEqual(["Info", "Error"]);
    await advance(200);
    expect(titles()).toEqual(["Error"]);
    await advance(4500);
    expect(titles()).toEqual([]);
  });

  test("hovering holds it; leaving starts the clock again", async () => {
    jest.useFakeTimers();
    const { store, titles, advance } = mount();
    await act(async () => store.toast({ tone: "ok", title: "Held" }));
    await act(async () => void fireEvent.pointerEnter(screen.getByRole("status")));
    await advance(20_000);
    expect(titles()).toEqual(["Held"]);
    await act(async () => void fireEvent.pointerLeave(screen.getByRole("status")));
    await advance(4600);
    expect(titles()).toEqual([]);
  });

  test("focus inside holds it too", async () => {
    jest.useFakeTimers();
    const { store, titles, advance } = mount();
    await act(async () => store.toast({ tone: "warn", title: "Focused" }));
    const close = screen.getByRole("button", { name: "Dismiss notification" });
    await act(async () => void fireEvent.focus(close));
    await advance(20_000);
    expect(titles()).toEqual(["Focused"]);
    await act(async () => void fireEvent.blur(close));
    await advance(7100);
    expect(titles()).toEqual([]);
  });
});
