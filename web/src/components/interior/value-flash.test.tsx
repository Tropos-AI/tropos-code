// web/src/components/interior/value-flash.test.tsx — ValueFlash tone/arrow/announcement and useValueFlash direction, compare and hold window.
import { afterEach, describe, expect, jest, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, waitFor } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ValueFlash, useValueFlash } = await import("@/components/interior/value-flash");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  jest.useRealTimers();
  cleanup();
});

/** Retries until a timer has fired and rendered (up to 3 s), instead of a fixed sleep that flakes under load. */
const until = (assertion: () => void) => waitFor(assertion, { timeout: 3000 });

describe("ValueFlash", () => {
  function mount(value: number) {
    // A hold far above timer jitter: the flash is checked right after the change, on a possibly loaded machine.
    const props = { label: "Requests", hold: 300, announceAfter: 10, format: (n: number) => n.toLocaleString("en-US") };
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
    await until(() => expect(root().className.includes("text-ink-2")).toBe(true));
    await until(() => expect(screen.queryByText("Requests: 1,284") !== null).toBe(true));
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

  /** The hold; the restart test runs on fake timers, so its windows are exact rather than at the mercy of a busy CI machine. */
  const HOLD = 300;

  function Harness<T>({ value, compare, onState }: { value: T; compare?: (a: T, b: T) => number; onState: (s: ReturnType<typeof useValueFlash<T>>) => void }) {
    onState(useValueFlash(value, { hold: HOLD, compare }));
    return null;
  }

  /** Moves the fake clock on by `ms` and renders what its timers changed. */
  const advance = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

  test("uses a custom compare for non-numeric values and restarts the hold on rapid changes", async () => {
    jest.useFakeTimers();
    let state = {} as State;
    const byLength = (a: string, b: string) => a.length - b.length;
    const view = render(createElement(Harness<string>, { value: "aa", compare: byLength, onState: (s) => (state = s) }));
    expect(state).toEqual({ direction: null, from: "aa", changeId: 0, flashing: false });

    view.rerender(createElement(Harness<string>, { value: "aaa", compare: byLength, onState: (s) => (state = s) }));
    expect(state).toMatchObject({ direction: "up", from: "aa", changeId: 1, flashing: true });
    await advance(HOLD / 2);
    view.rerender(createElement(Harness<string>, { value: "a", compare: byLength, onState: (s) => (state = s) }));
    expect(state).toMatchObject({ direction: "down", from: "aaa", changeId: 2, flashing: true });
    // Past the first change's hold: still flashing means the second change restarted it.
    await advance(HOLD / 2 + 50);
    expect(state.flashing).toBe(true);
    await advance(HOLD / 2);
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
    // Past the hold: the cleared timer must not touch the unmounted hook.
    await act(() => wait(HOLD + 50));
  });
});
