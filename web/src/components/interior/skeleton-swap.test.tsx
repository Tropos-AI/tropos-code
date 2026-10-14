// web/src/components/interior/skeleton-swap.test.tsx — SkeletonSwap and useSkeletonSwap: delayed skeleton, minimum visible time, scroll focus.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { SkeletonSwap } = await import("@/components/interior/skeleton-swap");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const realResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = realResizeObserver;
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
});

/** The placeholder layer (aria-hidden, so it is found by structure rather than role). */
const bars = (root: HTMLElement) => root.querySelectorAll(".bg-rule");

describe("SkeletonSwap", () => {
  test("waits `delay` before showing bars, keeps them up `minVisible`, then reveals the content and announces it", async () => {
    const view = render(createElement(SkeletonSwap, { ready: false, delay: 20, minVisible: 60, lines: 4, label: "Usage", children: "Loaded body" }));
    const shell = screen.getByLabelText("Usage");
    expect(shell.getAttribute("aria-busy")).toBe("true");
    expect(bars(shell)).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("");

    await act(() => wait(40));
    expect(bars(shell)).toHaveLength(4);
    expect((bars(shell)[3] as HTMLElement).style.width).toBe("62%");

    view.rerender(createElement(SkeletonSwap, { ready: true, delay: 20, minVisible: 60, lines: 4, label: "Usage", children: "Loaded body" }));
    expect(shell.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("Usage loaded");
    expect(bars(shell)).toHaveLength(4);

    await act(() => wait(90));
    expect(bars(shell)).toHaveLength(0);
    expect(shell.textContent).toContain("Loaded body");
  });

  test("a load that finishes before the delay never flashes the skeleton", async () => {
    // Far above the few ms before the load lands, even on a loaded machine; the wait after it goes past the delay.
    const delay = 300;
    const view = render(createElement(SkeletonSwap, { ready: false, delay, skeleton: createElement("p", null, "Custom placeholder"), children: "Body" }));
    await act(() => wait(5));
    view.rerender(createElement(SkeletonSwap, { ready: true, delay, skeleton: createElement("p", null, "Custom placeholder"), children: "Body" }));
    await act(() => wait(delay + 100));
    expect(screen.queryByText("Custom placeholder")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("shows a custom placeholder, single-line widths, and stays put while still loading", async () => {
    const view = render(createElement(SkeletonSwap, { ready: false, delay: 0, lines: 1, reserve: 50, skeleton: createElement("p", null, "Custom placeholder"), children: "Body" }));
    expect(await screen.findByText("Custom placeholder")).toBeTruthy();
    // Re-rendering while still loading leaves the visible skeleton alone.
    view.rerender(createElement(SkeletonSwap, { ready: false, delay: 0, lines: 1, reserve: 50, skeleton: createElement("p", null, "Custom placeholder"), children: "Body 2" }));
    expect(screen.getByText("Custom placeholder")).toBeTruthy();
    const single = render(createElement(SkeletonSwap, { ready: false, delay: 0, lines: 1, children: "x" }));
    await act(() => wait(10));
    expect((bars(single.container)[0] as HTMLElement).style.width).not.toBe("62%");
  });

  test("an overflowing box becomes keyboard-scrollable", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 500 });
    render(createElement(SkeletonSwap, { ready: true, label: "Log", children: "Many lines" }));
    expect(screen.getByLabelText("Log").tabIndex).toBe(0);
  });

  test("without ResizeObserver it still renders, just never focusable", () => {
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    render(createElement(SkeletonSwap, { ready: true, label: "Plain", children: "Body" }));
    expect(screen.getByLabelText("Plain").hasAttribute("tabindex")).toBe(false);
  });
});
