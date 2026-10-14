// web/src/components/interior/popover.test.tsx — Popover open/close behaviour and usePopover placement (flip, align, clamp, arrow).
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement, useRef } = await import("react");
const { Popover, usePopover } = await import("@/components/interior/popover");

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => {
  cleanup();
});

describe("Popover", () => {
  function mount(props: Partial<Parameters<typeof Popover>[0]> = {}) {
    const outside = document.createElement("button");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    const view = render(createElement(Popover, { trigger: "Filters", label: "Filter options", ...props, children: createElement("button", null, "Inside") }));
    return { ...view, outside, trigger: () => screen.getByRole("button", { name: "Filters" }) };
  }

  test("the trigger toggles a labelled dialog that takes focus; Escape closes and returns focus", async () => {
    const { trigger, outside } = mount();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => void fireEvent.click(trigger()));
    const dialog = screen.getByRole("dialog", { name: "Filter options" });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(dialog.id);
    expect(document.activeElement).toBe(dialog);

    // Other keys do nothing.
    await act(async () => void fireEvent.keyDown(document, { key: "a" }));
    expect(screen.queryByRole("dialog")).not.toBeNull();

    await act(async () => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    outside.remove();
  });

  test("a press inside stays open; a press outside closes", async () => {
    const { trigger, outside } = mount({ defaultOpen: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => void fireEvent.pointerDown(screen.getByRole("button", { name: "Inside" })));
    await act(async () => void fireEvent.pointerDown(trigger()));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => void fireEvent.pointerDown(outside));
    expect(screen.queryByRole("dialog")).toBeNull();
    outside.remove();
  });

  test("focus leaving to somewhere else closes; focus moving inside or to nowhere keeps it open", async () => {
    const { trigger, outside } = mount({ defaultOpen: true });
    const inside = screen.getByRole("button", { name: "Inside" });
    await act(async () => void fireEvent.blur(inside, { relatedTarget: null }));
    await act(async () => void fireEvent.blur(inside, { relatedTarget: trigger() }));
    await act(async () => void fireEvent.blur(inside, { relatedTarget: screen.getByRole("dialog") }));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => void fireEvent.blur(inside, { relatedTarget: outside }));
    expect(screen.queryByRole("dialog")).toBeNull();
    outside.remove();
  });

  test("controlled: renders from `open` and reports requests through onOpenChange", async () => {
    const calls: boolean[] = [];
    const { trigger, rerender, outside } = mount({ open: false, onOpenChange: (next: boolean) => calls.push(next) });
    await act(async () => void fireEvent.click(trigger()));
    expect(calls).toEqual([true]);
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(createElement(Popover, { trigger: "Filters", label: "Filter options", open: true, side: "left", onOpenChange: (next: boolean) => calls.push(next), children: "Body" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => void fireEvent.click(trigger()));
    expect(calls).toEqual([true, false]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    outside.remove();
  });

  test("scroll and resize reposition on the next frame", async () => {
    const { outside } = mount({ defaultOpen: true });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("scroll"));
      await nextFrame();
      await nextFrame();
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    outside.remove();
  });
});

describe("usePopover", () => {
  type Rect = { left: number; top: number; width: number; height: number };
  type Api = ReturnType<typeof usePopover<HTMLButtonElement>>;

  const rect = ({ left, top, width, height }: Rect) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  function Harness({
    side,
    align,
    withContent = true,
    withArrow = true,
    bounded,
    onApi,
  }: {
    side: Side;
    align: Align;
    withContent?: boolean;
    withArrow?: boolean;
    bounded?: boolean;
    onApi: (api: Api) => void;
  }) {
    const boundary = useRef<HTMLDivElement>(null);
    const api = usePopover<HTMLButtonElement>({ open: false, side, align, boundary: bounded ? boundary : undefined });
    onApi(api);
    return createElement(
      "div",
      { ref: boundary, "data-testid": "boundary" },
      createElement("button", { ref: api.anchorRef }, "anchor"),
      createElement(
        "div",
        { ref: api.floatingRef, "data-testid": "wrap" },
        createElement(
          "div",
          { ref: api.panelRef, "data-testid": "panel" },
          withArrow ? createElement("span", { ref: api.arrowRef, "data-testid": "arrow" }) : null,
          withContent ? createElement("div", { ref: api.contentRef, "data-testid": "content" }) : null,
        ),
      ),
    );
  }

  function place(opts: { side: Side; align?: Align; anchor: Rect; withContent?: boolean; withArrow?: boolean; boundary?: Rect }) {
    let api = {} as Api;
    render(
      createElement(Harness, {
        side: opts.side,
        align: opts.align ?? "center",
        withContent: opts.withContent,
        withArrow: opts.withArrow,
        bounded: !!opts.boundary,
        onApi: (a) => (api = a),
      }),
    );
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    screen.getByRole("button", { name: "anchor" }).getBoundingClientRect = () => rect(opts.anchor);
    if (opts.boundary) screen.getByTestId("boundary").getBoundingClientRect = () => rect(opts.boundary!);
    const wrap = screen.getByTestId("wrap");
    wrap.getBoundingClientRect = () => rect({ left: parseFloat(wrap.style.left) || 0, top: parseFloat(wrap.style.top) || 0, width: 200, height: 100 });
    const panel = screen.getByTestId("panel");
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 100 });
    if (opts.withContent !== false) Object.defineProperty(screen.getByTestId("content"), "offsetHeight", { configurable: true, value: 80 });
    act(() => api.update());
    return { api: () => api, wrap, panel, arrow: () => screen.queryByTestId("arrow"), content: () => screen.queryByTestId("content") };
  }

  test("bottom, centred under the anchor, with the arrow aimed at its middle", () => {
    const { api, wrap, panel, arrow, content } = place({ side: "bottom", anchor: { left: 100, top: 100, width: 80, height: 20 } });
    expect(api().side).toBe("bottom");
    expect(wrap.style.left).toBe("40px");
    expect(wrap.style.top).toBe("130px");
    expect(panel.style.maxWidth).toBe("984px");
    expect(content()!.style.maxHeight).toBe("642px");
    expect(panel.style.transformOrigin).toBe("100px 0px");
    expect(arrow()!.style.left).toBe("96px");
    expect(arrow()!.style.top).toBe("-4px");
    // A second pass reads its own previous offset back out.
    act(() => api().update());
    expect(wrap.style.left).toBe("40px");
  });

  test("flips to the top when there is no room below", () => {
    const { api, wrap, panel, arrow } = place({ side: "bottom", align: "end", anchor: { left: 300, top: 700, width: 80, height: 20 } });
    expect(api().side).toBe("top");
    expect(wrap.style.top).toBe("590px");
    expect(wrap.style.left).toBe("180px");
    expect(panel.style.transformOrigin).toBe("160px 100px");
    expect(arrow()!.style.top).toBe("96px");
  });

  test("right, aligned to the start; the arrow is clamped clear of the corner radius", () => {
    const { api, wrap, panel, arrow, content } = place({ side: "right", align: "start", anchor: { left: 100, top: 100, width: 80, height: 20 } });
    expect(api().side).toBe("right");
    expect(wrap.style.left).toBe("190px");
    expect(wrap.style.top).toBe("100px");
    expect(panel.style.maxWidth).toBe("802px");
    expect(content()!.style.maxHeight).toBe("764px");
    expect(panel.style.transformOrigin).toBe("0px 16px");
    expect(arrow()!.style.top).toBe("11px");
    expect(arrow()!.style.left).toBe("-4px");
  });

  test("left, aligned to the end, without content or arrow", () => {
    const { api, wrap, panel, arrow } = place({ side: "left", align: "end", anchor: { left: 500, top: 100, width: 80, height: 20 }, withContent: false, withArrow: false });
    expect(api().side).toBe("left");
    expect(arrow()).toBeNull();
    expect(wrap.style.left).toBe("290px");
    expect(wrap.style.top).toBe("20px");
    expect(panel.style.transformOrigin.startsWith("200px")).toBe(true);
  });

  test("top with room, and left with room, keep their side; a boundary clamps the panel inside it", () => {
    expect(place({ side: "top", anchor: { left: 300, top: 400, width: 80, height: 20 } }).api().side).toBe("top");
    cleanup();
    const { wrap } = place({ side: "bottom", align: "start", anchor: { left: 40, top: 100, width: 80, height: 20 }, boundary: { left: 50, top: 50, width: 550, height: 550 } });
    expect(wrap.style.left).toBe("58px");
  });

  test("update is a no-op until the anchor, wrapper and panel are mounted", () => {
    let api = {} as Api;
    function Empty() {
      api = usePopover<HTMLButtonElement>({ open: false });
      return null;
    }
    render(createElement(Empty));
    expect(() => api.update()).not.toThrow();
    expect(api.side).toBe("bottom");
  });
});
