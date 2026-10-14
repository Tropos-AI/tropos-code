// web/src/components/interior/value-flash.test.tsx — ValueFlash tone/arrow/announcement and useValueFlash direction, compare and hold window.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ValueFlash, useValueFlash } = await import("@/components/interior/value-flash");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  cleanup();
});

describe("ValueFlash", () => {
  function mount(value: number) {
    const props = { label: "Requests", hold: 30, announceAfter: 10, format: (n: number) => n.toLocaleString("en-US") };
    const view = render(createElement(ValueFlash, { value, ...props }));
    const root = () => view.container.firstElementChild as HTMLElement;
    const arrow = () => view.container.querySelector("[data-icon-name]")?.getAttribute("data-icon-name") ?? null;
    return { root, arrow, set: (next: number) => view.rerender(createElement(ValueFlash, { value: next, ...props })) };
  }

  test("a rise flashes green with an up arrow, then settles; the live region announces the formatted value", async () => {
    const { root, arrow, set } = mount(1000);
    expect(root().className).toContain("text-ink-2");
    expect(arrow()).toBeNull();
    expect(screen.getByText("Requests: 1,000")).toBeTruthy();

    await act(async () => set(1284));
    expect(root().className).toContain("text-ok");
    expect(arrow()).toBe("arrow-up");
    await act(() => wait(50));
    expect(root().className).toContain("text-ink-2");
    expect(screen.getByText("Requests: 1,284")).toBeTruthy();
  });

  test("a drop flashes red with a down arrow; an equal value does nothing", async () => {
    const { root, arrow, set } = mount(10);
    await act(async () => set(10));
    expect(root().className).toContain("text-ink-2");
    await act(async () => set(4));
    expect(root().className).toContain("text-error");
    expect(arrow()).toBe("arrow-down");
  });

  test("without a label the announcement is just the value", async () => {
    render(createElement(ValueFlash, { value: 7, announceAfter: 5 }));
    await act(() => wait(15));
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);
  });
});

describe("useValueFlash", () => {
  type State = ReturnType<typeof useValueFlash<string>>;

  function Harness<T>({ value, compare, onState }: { value: T; compare?: (a: T, b: T) => number; onState: (s: ReturnType<typeof useValueFlash<T>>) => void }) {
    onState(useValueFlash(value, { hold: 30, compare }));
    return null;
  }

  test("uses a custom compare for non-numeric values and restarts the hold on rapid changes", async () => {
    let state = {} as State;
    const byLength = (a: string, b: string) => a.length - b.length;
    const view = render(createElement(Harness<string>, { value: "aa", compare: byLength, onState: (s) => (state = s) }));
    expect(state).toEqual({ direction: null, from: "aa", changeId: 0, flashing: false });

    view.rerender(createElement(Harness<string>, { value: "aaa", compare: byLength, onState: (s) => (state = s) }));
    expect(state).toMatchObject({ direction: "up", from: "aa", changeId: 1, flashing: true });
    await act(() => wait(15));
    view.rerender(createElement(Harness<string>, { value: "a", compare: byLength, onState: (s) => (state = s) }));
    expect(state).toMatchObject({ direction: "down", from: "aaa", changeId: 2, flashing: true });
    await act(() => wait(20));
    expect(state.flashing).toBe(true);
    await act(() => wait(30));
    expect(state.flashing).toBe(false);

    // A change compare calls equal is not a flash.
    view.rerender(createElement(Harness<string>, { value: "b", compare: byLength, onState: (s) => (state = s) }));
    expect(state.changeId).toBe(2);
  });

  test("non-numeric values without compare never flash; unmounting mid-flash is safe", async () => {
    let state = {} as State;
    const view = render(createElement(Harness<string>, { value: "x", onState: (s) => (state = s) }));
    view.rerender(createElement(Harness<string>, { value: "y", onState: (s) => (state = s) }));
    expect(state.flashing).toBe(false);

    let n = {} as ReturnType<typeof useValueFlash<number>>;
    const numeric = render(createElement(Harness<number>, { value: 1, onState: (s) => (n = s) }));
    numeric.rerender(createElement(Harness<number>, { value: 2, onState: (s) => (n = s) }));
    expect(n.flashing).toBe(true);
    numeric.unmount();
    await act(() => wait(40));
  });
});
