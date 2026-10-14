// web/src/components/interior/show-more.test.tsx — ShowMore and useShowMore: measuring, expanding, capping into a scroll region, control.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ShowMore, useShowMore } = await import("@/components/interior/show-more");

/** happy-dom does no layout: the content's height and line height come from here. */
const layout = { full: 200, lineHeight: "20px", fontSize: "16px" };

const observers = new Set<() => void>();
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    observers.add(this.callback);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.callback);
  }
}

const realResizeObserver = globalThis.ResizeObserver;
const realGetComputedStyle = window.getComputedStyle;

beforeEach(() => {
  Object.assign(layout, { full: 200, lineHeight: "20px", fontSize: "16px" });
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  window.getComputedStyle = ((el: Element) =>
    new Proxy(realGetComputedStyle(el), {
      get(target, prop) {
        if (prop === "lineHeight") return layout.lineHeight;
        if (prop === "fontSize") return layout.fontSize;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    })) as typeof window.getComputedStyle;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => layout.full });
});

afterEach(() => {
  cleanup();
  observers.clear();
  globalThis.ResizeObserver = realResizeObserver;
  window.getComputedStyle = realGetComputedStyle;
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
});

const toggle = () => screen.getByRole("button");

describe("ShowMore", () => {
  test("long content collapses to its lines; the button expands and collapses it", async () => {
    render(createElement(ShowMore, { lines: 3, children: "A long paragraph" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(toggle().className).not.toContain("invisible");
    const region = document.getElementById(toggle().getAttribute("aria-controls")!)!;
    expect(region.textContent).toBe("A long paragraph");
    expect(region.getAttribute("role")).toBeNull();

    await act(async () => void fireEvent.click(toggle()));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();

    let scrolledTo: unknown = null;
    region.scrollTo = ((options: unknown) => void (scrolledTo = options)) as typeof region.scrollTo;
    await act(async () => void fireEvent.click(toggle()));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(scrolledTo).toEqual({ top: 0 });
  });

  test("content that fits needs no button", () => {
    layout.full = 40;
    render(createElement(ShowMore, { lines: 3, moreLabel: "More", lessLabel: "Less", children: "Short" }));
    expect(toggle().className).toContain("invisible");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  test("content taller than maxHeight opens into a labelled, focusable scroll region", async () => {
    layout.full = 500;
    render(createElement(ShowMore, { lines: 2, maxHeight: 320, label: "Tool output", defaultExpanded: true, children: "Lots" }));
    const region = screen.getByRole("region", { name: "Tool output" });
    expect(region.tabIndex).toBe(0);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  test("controlled: follows `expanded` and reports clicks through onExpandedChange", async () => {
    const calls: boolean[] = [];
    const view = render(createElement(ShowMore, { expanded: false, onExpandedChange: (next: boolean) => calls.push(next), children: "Text" }));
    await act(async () => void fireEvent.click(toggle()));
    expect(calls).toEqual([true]);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    view.rerender(createElement(ShowMore, { expanded: true, onExpandedChange: (next: boolean) => calls.push(next), children: "Text" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("useShowMore", () => {
  type Api = ReturnType<typeof useShowMore>;

  function Harness({ lines, onApi }: { lines: number; onApi: (api: Api) => void }) {
    const api = useShowMore({ lines, maxHeight: 300 });
    onApi(api);
    return createElement("div", { ref: api.contentRef }, "body");
  }

  test("falls back to 1.5x the font size for `normal` line height and re-measures on resize", async () => {
    layout.lineHeight = "normal";
    layout.fontSize = "10px";
    let api = {} as Api;
    render(createElement(Harness, { lines: 2, onApi: (a) => (api = a) }));
    expect(api.collapsedHeight).toBe(30);
    expect(api.fullHeight).toBe(200);
    expect(api.height).toBe(30);
    expect(api.expandable).toBe(true);
    expect(api.capped).toBe(false);

    // An unchanged measurement keeps the same metrics; a taller body is capped at maxHeight.
    await act(async () => observers.forEach((fn) => fn()));
    expect(api.fullHeight).toBe(200);
    layout.full = 400;
    await act(async () => observers.forEach((fn) => fn()));
    expect(api.fullHeight).toBe(300);
    expect(api.capped).toBe(true);

    await act(async () => api.setExpanded(true));
    expect(api.open).toBe(true);
    expect(api.scrollable).toBe(true);
    expect(api.height).toBe(300);
    await act(async () => api.toggle());
    expect(api.expanded).toBe(false);
  });

  test("before anything is measured, it assumes the content can expand", () => {
    let api = {} as Api;
    function Unmounted() {
      api = useShowMore();
      return null;
    }
    render(createElement(Unmounted));
    expect(api.expandable).toBe(true);
    expect(api.height).toBeNull();
    expect(api.capped).toBe(false);
  });
});
