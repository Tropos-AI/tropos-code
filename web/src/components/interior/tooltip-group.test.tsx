// web/src/components/interior/tooltip-group.test.tsx — Tooltip and TooltipGroup: open/close delays, warm hand-off, dismissal, keyboard focus.
import { afterEach, describe, expect, test } from "bun:test";
import type { HTMLAttributes, ReactElement } from "react";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent, waitFor } = await import("@testing-library/react");
const { createElement, Fragment } = await import("react");
const { Tooltip, TooltipGroup } = await import("@/components/interior/tooltip-group");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  cleanup();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

const fire = (fn: () => void) => act(async () => void fn());
const tip = () => screen.queryByRole("tooltip");
/**
 * Delays far above timer jitter on a loaded CI machine: a check made right after an event ("not open yet", "still
 * warm") stays true for hundreds of ms, and waits for a timer to fire poll (`until`) instead of sleeping a fixed time.
 */
const timing = { openDelay: 200, closeDelay: 150, skipDelay: 600 };
/** Past the open delay, so a pending open would have fired (timers never run early): for "it never opens" checks. */
const PAST_OPEN = timing.openDelay + 100;
/** Retries until a timer has fired and rendered (up to 3 s), instead of a fixed sleep that flakes under load. */
const until = (assertion: () => void) => waitFor(assertion, { timeout: 3000 });
// Boolean checks: a failing expect() on an element pretty-prints the element, which is slow in a polling loop.
const opened = () => until(() => expect(tip() !== null).toBe(true));
const closed = () => until(() => expect(tip() === null).toBe(true));

function button(name: string, extra: HTMLAttributes<HTMLElement> & { "aria-describedby"?: string } = {}): ReactElement<HTMLAttributes<HTMLElement>> {
  return createElement("button", { type: "button", ...extra }, name);
}

describe("Tooltip (solo)", () => {
  test("opens after the delay on hover, describes its trigger, and closes after the close delay", async () => {
    render(createElement(Tooltip, { label: "Save file", ...timing, children: button("Save", { "aria-describedby": "hint" }) }));
    const trigger = screen.getByRole("button", { name: "Save" });
    expect(trigger.getAttribute("aria-describedby")).toBe("hint");

    await fire(() => fireEvent.pointerEnter(trigger, { clientX: 10 }));
    expect(tip()).toBeNull();
    // A second enter while the first is pending just restarts the wait.
    await fire(() => fireEvent.pointerEnter(trigger, { clientX: 10 }));
    await opened();
    const tooltip = tip()!;
    expect(tooltip.textContent).toBe("Save file");
    expect(trigger.getAttribute("aria-describedby")).toBe(`hint ${tooltip.id}`);

    // Entering again while open keeps it open.
    await fire(() => fireEvent.pointerEnter(trigger, { clientX: 12 }));
    await fire(() => fireEvent.pointerLeave(trigger));
    expect(tip()).not.toBeNull();
    await closed();
    expect(trigger.getAttribute("aria-describedby")).toBe("hint");
  });

  test("leaving before the delay cancels the pending open", async () => {
    render(createElement(Tooltip, { label: "Later", ...timing, children: button("Pending") }));
    const trigger = screen.getByRole("button");
    await fire(() => fireEvent.pointerEnter(trigger, { clientX: 0 }));
    await fire(() => fireEvent.pointerLeave(trigger));
    await act(() => wait(PAST_OPEN));
    expect(tip()).toBeNull();
  });

  test("keyboard focus opens at once; pointer focus does not; blur closes", async () => {
    render(createElement(Tooltip, { label: "Focused", side: "bottom", ...timing, children: button("Focus me") }));
    const trigger = screen.getByRole("button");
    trigger.matches = ((selector: string) => selector !== ":focus-visible") as typeof trigger.matches;
    await fire(() => fireEvent.focus(trigger));
    expect(tip()).toBeNull();

    trigger.matches = ((selector: string) => selector === ":focus-visible") as typeof trigger.matches;
    await fire(() => fireEvent.focus(trigger));
    expect(tip()!.textContent).toBe("Focused");
    await fire(() => fireEvent.blur(trigger));
    expect(tip()).toBeNull();

    // A browser without :focus-visible support counts any focus as keyboard focus.
    trigger.matches = (() => {
      throw new SyntaxError("unsupported selector");
    }) as typeof trigger.matches;
    await fire(() => fireEvent.focus(trigger));
    expect(tip()).not.toBeNull();
  });

  test("Escape and pointer-down dismiss; hovering again stays dismissed until the pointer leaves", async () => {
    const seen: string[] = [];
    const child = button("Act", {
      onPointerDown: () => seen.push("down"),
      onKeyDown: (event: { key: string }) => seen.push(event.key),
    });
    render(createElement(Tooltip, { label: "Hint", ...timing, closeDelay: 0, children: child }));
    const trigger = screen.getByRole("button");
    trigger.matches = (() => true) as typeof trigger.matches;

    await fire(() => fireEvent.focus(trigger));
    expect(tip()).not.toBeNull();
    await fire(() => fireEvent.keyDown(trigger, { key: "a" }));
    expect(tip()).not.toBeNull();
    await fire(() => fireEvent.keyDown(trigger, { key: "Escape" }));
    expect(tip()).toBeNull();

    await fire(() => fireEvent.pointerEnter(trigger, { clientX: 0 }));
    await act(() => wait(PAST_OPEN));
    expect(tip()).toBeNull();
    await fire(() => fireEvent.pointerLeave(trigger));
    await fire(() => fireEvent.pointerEnter(trigger, { clientX: 0 }));
    await opened();

    await fire(() => fireEvent.pointerDown(trigger));
    expect(tip()).toBeNull();
    await fire(() => fireEvent.pointerCancel(trigger));
    expect(seen).toEqual(["a", "Escape", "down"]);
  });

  test("a disabled tooltip never opens, and disabling an open one closes it", async () => {
    const view = render(createElement(Tooltip, { label: "Off", ...timing, children: button("Btn") }));
    const trigger = screen.getByRole("button");
    trigger.matches = (() => true) as typeof trigger.matches;
    await fire(() => fireEvent.focus(trigger));
    expect(tip()).not.toBeNull();

    view.rerender(createElement(Tooltip, { label: "Off", disabled: true, ...timing, children: button("Btn") }));
    expect(tip()).toBeNull();
    await fire(() => fireEvent.focus(trigger));
    await fire(() => fireEvent.pointerEnter(trigger, { clientX: 0 }));
    await act(() => wait(PAST_OPEN));
    expect(tip()).toBeNull();
  });

  test("a solo tooltip closes when the window blurs or the tab hides", async () => {
    render(createElement(Tooltip, { label: "Solo", ...timing, children: button("Solo") }));
    const trigger = screen.getByRole("button");
    trigger.matches = (() => true) as typeof trigger.matches;
    await fire(() => fireEvent.focus(trigger));
    await fire(() => window.dispatchEvent(new Event("blur")));
    expect(tip()).toBeNull();

    await fire(() => fireEvent.focus(trigger));
    await fire(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(tip()).not.toBeNull();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await fire(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(tip()).toBeNull();
  });
});

describe("TooltipGroup", () => {
  function Toolbar({ onWarmChange, skipDelay = timing.skipDelay, closeDelay = timing.closeDelay, className }: { onWarmChange?: (warm: boolean) => void; skipDelay?: number; closeDelay?: number; className?: string }) {
    const tools = createElement(
      Fragment,
      null,
      createElement(Tooltip, { label: "Bold", children: button("B") }),
      createElement(Tooltip, { label: "Italic", children: button("I") }),
    );
    return createElement(TooltipGroup, { openDelay: timing.openDelay, closeDelay, skipDelay, onWarmChange, className, children: tools });
  }

  test("the first tooltip waits; a neighbour opens instantly while warm; the group cools after skipDelay", async () => {
    const warmth: boolean[] = [];
    const { container } = render(createElement(Toolbar, { onWarmChange: (w: boolean) => warmth.push(w), className: "toolbar" }));
    expect(container.querySelector(".toolbar")).not.toBeNull();
    const bold = screen.getByRole("button", { name: "B" });
    const italic = screen.getByRole("button", { name: "I" });

    await fire(() => fireEvent.pointerEnter(bold, { clientX: 10 }));
    expect(tip()).toBeNull();
    await opened();
    expect(tip()!.textContent).toBe("Bold");
    expect(warmth.at(-1)).toBe(true);

    await fire(() => fireEvent.pointerLeave(bold));
    await fire(() => fireEvent.pointerEnter(italic, { clientX: 50 }));
    expect(tip()!.textContent).toBe("Italic");

    await fire(() => fireEvent.pointerLeave(italic));
    // Closed after closeDelay, but still warm: skipDelay (600 ms) only starts counting once it has closed.
    await closed();
    expect(warmth.at(-1)).toBe(true);
    await until(() => expect(warmth.at(-1)).toBe(false));
  });

  test("with no skip delay the group cools as soon as the last tooltip closes", async () => {
    const warmth: boolean[] = [];
    render(createElement(Toolbar, { onWarmChange: (w: boolean) => warmth.push(w), skipDelay: 0, closeDelay: 0 }));
    const bold = screen.getByRole("button", { name: "B" });
    await fire(() => fireEvent.pointerEnter(bold, { clientX: 0 }));
    await opened();
    await fire(() => fireEvent.pointerLeave(bold));
    expect(tip()).toBeNull();
    expect(warmth.at(-1)).toBe(false);
  });

  test("window blur and a hidden tab reset the whole group; dismissing another trigger cools it", async () => {
    const warmth: boolean[] = [];
    render(createElement(Toolbar, { onWarmChange: (w: boolean) => warmth.push(w) }));
    const bold = screen.getByRole("button", { name: "B" });
    const italic = screen.getByRole("button", { name: "I" });
    const openBold = async () => {
      await fire(() => fireEvent.pointerEnter(bold, { clientX: 0 }));
      await opened();
    };

    await openBold();
    await fire(() => window.dispatchEvent(new Event("blur")));
    expect(tip()).toBeNull();
    expect(warmth.at(-1)).toBe(false);

    await openBold();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await fire(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(tip()).toBeNull();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });

    // Warm but closed: a reset still cools the group.
    await openBold();
    await fire(() => fireEvent.pointerLeave(bold));
    await closed();
    expect(warmth.at(-1)).toBe(true);
    await fire(() => window.dispatchEvent(new Event("blur")));
    expect(warmth.at(-1)).toBe(false);

    // Warm but closed: pressing another trigger dismisses and cools.
    await openBold();
    await fire(() => fireEvent.pointerLeave(bold));
    await closed();
    expect(warmth.at(-1)).toBe(true);
    await fire(() => fireEvent.pointerDown(italic));
    expect(warmth.at(-1)).toBe(false);
  });

  test("unmounting an open tooltip closes it", async () => {
    const view = render(createElement(Toolbar));
    await fire(() => fireEvent.pointerEnter(screen.getByRole("button", { name: "B" }), { clientX: 0 }));
    await opened();
    view.unmount();
    expect(tip()).toBeNull();
  });
});
