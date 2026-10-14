// web/src/components/interior/new-items-pill.test.tsx — NewItemsPill (label, cap, announcement) and useNewItems (pinning, unread, jump).
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { NewItemsPill, useNewItems } = await import("@/components/interior/new-items-pill");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  cleanup();
});

describe("NewItemsPill", () => {
  test("hidden at zero; shows the count, jumps on click and announces once the count settles", async () => {
    let jumps = 0;
    const view = render(createElement(NewItemsPill, { count: 0, onJump: () => jumps++ }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");

    view.rerender(createElement(NewItemsPill, { count: 1, onJump: () => jumps++ }));
    const pill = screen.getByRole("button", { name: "1 new item" });
    fireEvent.click(pill);
    expect(jumps).toBe(1);

    view.rerender(createElement(NewItemsPill, { count: 3, onJump: () => jumps++ }));
    expect(screen.getByRole("button", { name: "3 new items" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    await act(() => wait(750));
    expect(screen.getByRole("status").textContent).toBe("3 new items");

    view.rerender(createElement(NewItemsPill, { count: 0, onJump: () => jumps++ }));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  test("caps the label at max and honours a custom label and the bottom anchor", () => {
    const view = render(createElement(NewItemsPill, { count: 150, max: 99, onJump: () => {}, anchor: "bottom" }));
    expect(screen.getByRole("button", { name: "99+ new items" })).toBeTruthy();
    view.rerender(createElement(NewItemsPill, { count: 2, onJump: () => {}, label: (n: number) => `${n} replies` }));
    expect(screen.getByRole("button", { name: "2 replies" })).toBeTruthy();
  });
});

describe("useNewItems", () => {
  type Api = ReturnType<typeof useNewItems<HTMLDivElement>>;

  function Feed({ count, anchor, onApi }: { count: number; anchor?: "top" | "bottom"; onApi: (api: Api) => void }) {
    const api = useNewItems<HTMLDivElement>({ itemCount: count, anchor, threshold: 10 });
    onApi(api);
    return createElement("div", { ...api.scrollProps, "data-testid": "feed" }, `${api.unread}|${api.pinned}`);
  }

  /** Gives the scroller fake geometry: happy-dom does no layout. */
  function geometry(el: HTMLElement, sizes: { scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => sizes.scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => sizes.clientHeight });
    let top = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => void (top = v),
    });
    const scrolls: ScrollToOptions[] = [];
    el.scrollTo = ((options: ScrollToOptions) => {
      scrolls.push(options);
      if (typeof options.top === "number") top = options.top;
    }) as typeof el.scrollTo;
    return { scrolls, scroll: (to: number) => act(async () => { top = to; fireEvent.scroll(el); }) };
  }

  test("top anchor: pinned rows follow new items; scrolled away counts unread and keeps the view still; jump catches up", async () => {
    let api = {} as Api;
    const view = render(createElement(Feed, { count: 2, onApi: (a) => (api = a) }));
    const el = screen.getByTestId("feed");
    expect(el.tabIndex).toBe(0);
    const sizes = { scrollHeight: 500, clientHeight: 100 };
    const { scrolls, scroll } = geometry(el, sizes);

    // Pinned at the top: new items keep the scroller at 0 and nothing is unread.
    sizes.scrollHeight = 600;
    view.rerender(createElement(Feed, { count: 3, onApi: (a) => (api = a) }));
    expect(api.unread).toBe(0);
    expect(el.scrollTop).toBe(0);

    await scroll(200);
    expect(api.pinned).toBe(false);

    // Two rows push in above the reader: the view is held and both count as unread.
    sizes.scrollHeight = 700;
    view.rerender(createElement(Feed, { count: 5, onApi: (a) => (api = a) }));
    expect(api.unread).toBe(2);
    expect(el.scrollTop).toBe(300);

    // Fewer items never count.
    view.rerender(createElement(Feed, { count: 4, onApi: (a) => (api = a) }));
    expect(api.unread).toBe(2);

    let caught = 0;
    await act(async () => void (caught = api.jump()));
    expect(caught).toBe(2);
    expect(api.unread).toBe(0);
    expect(api.pinned).toBe(true);
    expect(scrolls.at(-1)).toEqual({ top: 0, behavior: "smooth" });
    expect(document.activeElement).toBe(el);

    // Scrolling back to the newest also clears unread.
    await scroll(300);
    expect(api.pinned).toBe(false);
    sizes.scrollHeight = 800;
    view.rerender(createElement(Feed, { count: 6, onApi: (a) => (api = a) }));
    expect(api.unread).toBe(2);
    await scroll(0);
    expect(api.pinned).toBe(true);
    expect(api.unread).toBe(0);
  });

  test("bottom anchor: pinned follows to the end; scrolled up counts unread; jump scrolls to the bottom", async () => {
    let api = {} as Api;
    const view = render(createElement(Feed, { count: 1, anchor: "bottom", onApi: (a) => (api = a) }));
    const el = screen.getByTestId("feed");
    const sizes = { scrollHeight: 400, clientHeight: 100 };
    const { scrolls, scroll } = geometry(el, sizes);
    await scroll(300);
    expect(api.pinned).toBe(true);

    sizes.scrollHeight = 500;
    view.rerender(createElement(Feed, { count: 2, anchor: "bottom", onApi: (a) => (api = a) }));
    expect(el.scrollTop).toBe(500);

    await scroll(100);
    expect(api.pinned).toBe(false);
    view.rerender(createElement(Feed, { count: 4, anchor: "bottom", onApi: (a) => (api = a) }));
    expect(api.unread).toBe(2);
    expect(el.scrollTop).toBe(100);

    await act(async () => void api.jump());
    expect(scrolls.at(-1)).toEqual({ top: 500, behavior: "smooth" });
  });

  test("jump without a mounted scroller just reports the unread count", () => {
    let api = {} as Api;
    function Detached() {
      api = useNewItems<HTMLDivElement>({ itemCount: 1 });
      return null;
    }
    render(createElement(Detached));
    expect(api.jump()).toBe(0);
  });
});
