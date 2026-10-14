// web/src/components/chat/use-chat-scroll.test.tsx — the transcript's scroll pinning: follows new output at the bottom,
// counts unread while scrolled up, and jumps/pins back. happy-dom has no layout, so the harness fakes the geometry.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { useChatScroll } = await import("@/components/chat/use-chat-scroll");

/** A scroll box with a settable height: scrollTop is clamped to [0, scrollHeight - clientHeight] like a browser's. */
class Geometry {
  scrollHeight = 2000;
  clientHeight = 500;
  contentHeight = 2000;
  top = 0;
  smooth: Array<{ top?: number; behavior?: string }> = [];
  get bottom(): number {
    return this.scrollHeight - this.clientHeight;
  }
  install(el: HTMLElement): void {
    const geo = this;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => geo.scrollHeight },
      clientHeight: { configurable: true, get: () => geo.clientHeight },
      scrollTop: {
        configurable: true,
        get: () => geo.top,
        set: (v: number) => {
          geo.top = Math.max(0, Math.min(geo.bottom, v));
        },
      },
      scrollTo: { configurable: true, value: (opts: { top?: number; behavior?: string }) => void geo.smooth.push(opts) },
    });
  }
  installContent(el: HTMLElement): void {
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => this.contentHeight });
  }
}

/** Collects observers so a test can say "something resized". */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: () => void) {
    FakeResizeObserver.all.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  static fire(): void {
    for (const o of FakeResizeObserver.all) if (!o.disconnected) o.callback();
  }
}

const g = globalThis as unknown as { ResizeObserver: unknown; matchMedia: unknown };
const realResizeObserver = g.ResizeObserver;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  FakeResizeObserver.all = [];
  g.ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  cleanup();
  g.ResizeObserver = realResizeObserver;
  window.matchMedia = realMatchMedia;
});

function reduceMotion(): void {
  window.matchMedia = ((query: string) =>
    ({ matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

type Props = { count: number; resetKey: number; busy: boolean; geo: Geometry; attach: boolean };

function Harness({ count, resetKey, busy, geo, attach }: Props) {
  const { scrollRef, contentRef, unread, jump, pin } = useChatScroll(count, resetKey, busy);
  const scrollProps = attach
    ? {
        ref: (node: HTMLDivElement | null) => {
          if (node) geo.install(node);
          scrollRef.current = node;
        },
      }
    : {};
  const contentProps = attach
    ? {
        ref: (node: HTMLDivElement | null) => {
          if (node) geo.installContent(node);
          contentRef.current = node;
        },
      }
    : {};
  return createElement(
    "div",
    null,
    createElement("div", { "data-testid": "scroller", ...scrollProps }, createElement("div", contentProps)),
    createElement("output", { "aria-label": "Unread" }, String(unread)),
    createElement("button", { type: "button", onClick: jump }, "Jump"),
    createElement("button", { type: "button", onClick: pin }, "Pin"),
  );
}

function mount({ count = 3, busy = true, attach = true } = {}) {
  const geo = new Geometry();
  let props: Props = { count, resetKey: 0, busy, geo, attach };
  const view = render(createElement(Harness, props));
  const update = (patch: Partial<Props>) =>
    act(async () => {
      props = { ...props, ...patch };
      view.rerender(createElement(Harness, props));
    });
  const scroller = () => screen.getByTestId("scroller");
  /** The reader (or a smooth scroll) moves to `top`; the browser then fires a scroll event. */
  const scrollTo = (top: number) =>
    act(async () => {
      geo.top = Math.max(0, Math.min(geo.bottom, top));
      fireEvent.scroll(scroller());
    });
  /** Content grows by `px` (a streaming reply), and the ResizeObserver reports it. */
  const grow = (px: number) =>
    act(async () => {
      geo.scrollHeight += px;
      geo.contentHeight += px;
      FakeResizeObserver.fire();
    });
  const unread = () => Number(screen.getByRole("status", { name: "Unread" }).textContent);
  const click = (name: string) => act(async () => void fireEvent.click(screen.getByRole("button", { name })));
  return { geo, update, scrollTo, grow, unread, click };
}

describe("useChatScroll", () => {
  test("starts at the bottom and follows new rows while pinned", async () => {
    const { geo, update, unread } = mount();
    expect(geo.top).toBe(geo.bottom);
    geo.scrollHeight += 300;
    await update({ count: 4 });
    expect(geo.top).toBe(geo.bottom);
    expect(unread()).toBe(0);
  });

  test("observes both the scroller and its content, and stops on unmount", async () => {
    const view = mount();
    expect(FakeResizeObserver.all).toHaveLength(1);
    expect(FakeResizeObserver.all[0]!.observed).toHaveLength(2);
    cleanup();
    expect(FakeResizeObserver.all[0]!.disconnected).toBe(true);
    expect(view.geo.top).toBe(view.geo.bottom);
  });

  test("scrolling up unpins: new rows are counted instead of scrolled to", async () => {
    const { geo, update, scrollTo, unread } = mount();
    await scrollTo(100);
    geo.scrollHeight += 400;
    await update({ count: 5 });
    expect(geo.top).toBe(100);
    expect(unread()).toBe(2);
    // Fewer rows (a reset of the list without a new session) is not news.
    await update({ count: 4 });
    expect(unread()).toBe(2);
  });

  test("scrolling back near the bottom pins again and clears the count", async () => {
    const { geo, update, scrollTo, unread } = mount();
    await scrollTo(100);
    await update({ count: 4 });
    expect(unread()).toBe(1);
    await scrollTo(geo.bottom - 40);
    expect(unread()).toBe(0);
    geo.scrollHeight += 200;
    await update({ count: 5 });
    expect(geo.top).toBe(geo.bottom);
  });

  test("a late scroll event after growth (not the reader going up) keeps it pinned", async () => {
    const { geo, update, scrollTo, unread } = mount();
    geo.scrollHeight += 600;
    await scrollTo(geo.top); // same position, now far from the new bottom
    await update({ count: 4 });
    expect(geo.top).toBe(geo.bottom);
    expect(unread()).toBe(0);
  });

  test("growth while pinned stays at the bottom", async () => {
    const { geo, grow } = mount();
    await grow(250);
    expect(geo.top).toBe(geo.bottom);
  });

  test("growth while scrolled up and busy shows one unread; idle growth or shrinking does not", async () => {
    const { geo, update, scrollTo, grow, unread } = mount({ busy: false });
    await scrollTo(100);
    await grow(250);
    expect(unread()).toBe(0);
    expect(geo.top).toBe(100);
    await update({ busy: true });
    await grow(-100);
    expect(unread()).toBe(0);
    await grow(100);
    expect(unread()).toBe(1);
    await grow(100);
    expect(unread()).toBe(1);
  });

  test("Jump smooth-scrolls to the newest and is not unpinned by its own scroll events", async () => {
    const { geo, update, scrollTo, grow, unread, click } = mount();
    await scrollTo(100);
    await update({ count: 6 });
    expect(unread()).toBe(3);
    await click("Jump");
    expect(unread()).toBe(0);
    expect(geo.smooth).toEqual([{ top: geo.scrollHeight, behavior: "smooth" }]);
    // Mid-animation: far from the bottom, and an earlier event may look like going up.
    await scrollTo(600);
    await scrollTo(500);
    // Content growing during the jump keeps chasing the bottom.
    await grow(100);
    expect(geo.top).toBe(geo.bottom);
    await scrollTo(geo.bottom);
    await update({ count: 7 });
    expect(unread()).toBe(0);
    // The jump is over: scrolling up unpins again.
    await scrollTo(100);
    await update({ count: 8 });
    expect(unread()).toBe(1);
  });

  test("with reduced motion, Jump goes straight to the bottom", async () => {
    reduceMotion();
    const { geo, scrollTo, update, unread, click } = mount();
    await scrollTo(100);
    await update({ count: 4 });
    await click("Jump");
    expect(geo.smooth).toEqual([]);
    expect(geo.top).toBe(geo.bottom);
    expect(unread()).toBe(0);
  });

  test("Pin re-pins at once and forgets unread", async () => {
    const { geo, scrollTo, update, unread, click } = mount();
    await scrollTo(0);
    await update({ count: 5 });
    expect(unread()).toBe(2);
    await click("Pin");
    expect(unread()).toBe(0);
    expect(geo.top).toBe(geo.bottom);
  });

  test("a new session scrolls to the end and forgets unread", async () => {
    const { geo, scrollTo, update, unread } = mount();
    await scrollTo(0);
    await update({ count: 5 });
    expect(unread()).toBe(2);
    await update({ resetKey: 1 });
    expect(unread()).toBe(0);
    expect(geo.top).toBe(geo.bottom);
  });

  test("without ResizeObserver it still pins on new rows", async () => {
    g.ResizeObserver = undefined;
    const { geo, update } = mount();
    geo.scrollHeight += 300;
    await update({ count: 4 });
    expect(geo.top).toBe(geo.bottom);
  });

  test("before the scroller is attached, nothing throws and Jump/Pin only reset the count", async () => {
    const { update, unread, click } = mount({ attach: false });
    await update({ count: 5 });
    expect(unread()).toBe(0);
    await click("Jump");
    await click("Pin");
    expect(unread()).toBe(0);
    expect(FakeResizeObserver.all).toHaveLength(0);
  });
});
