// web/src/components/interior/press-depth.test.tsx — PressDepth (link/button roots) and usePressDepth pointer, keyboard and cancel paths.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { PressDepth, usePressDepth } = await import("@/components/interior/press-depth");

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => {
  cleanup();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

const box = { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

function onWindow(type: string, init: PointerEventInit) {
  return act(async () => void window.dispatchEvent(new PointerEvent(type, init)));
}

const pressed = (el: Element) => el.hasAttribute("data-pressed");

describe("PressDepth", () => {
  test("renders a link when given an href", () => {
    render(createElement(PressDepth, { href: "/docs", target: "_blank", rel: "noopener", "aria-label": "Read the docs", children: "Docs" }));
    const link = screen.getByRole("link", { name: "Read the docs" });
    expect(link.getAttribute("href")).toBe("/docs");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  test("a pointer press sinks the face, follows the pointer in and out, and lifts on release", async () => {
    let clicks = 0;
    render(createElement(PressDepth, { onClick: () => clicks++, variant: "primary", size: "sm", title: "Go", children: "Go" }));
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.getAttribute("type")).toBe("button");
    button.getBoundingClientRect = () => box;

    // A right-click is not a press.
    await act(async () => void fireEvent.pointerDown(button, { pointerId: 1, pointerType: "mouse", button: 2, clientX: 10, clientY: 10 }));
    expect(pressed(button)).toBe(false);

    await act(async () => void fireEvent.pointerDown(button, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 75, clientY: 10 }));
    expect(pressed(button)).toBe(true);

    // Another pointer is ignored; leaving the box releases; coming back presses again.
    await onWindow("pointermove", { pointerId: 9, clientX: 500, clientY: 500 });
    expect(pressed(button)).toBe(true);
    await onWindow("pointermove", { pointerId: 1, clientX: 500, clientY: 500 });
    expect(pressed(button)).toBe(false);
    await onWindow("pointermove", { pointerId: 1, clientX: 50, clientY: 20 });
    expect(pressed(button)).toBe(true);

    await onWindow("pointerup", { pointerId: 9 });
    expect(pressed(button)).toBe(true);
    await onWindow("pointerup", { pointerId: 1 });
    expect(pressed(button)).toBe(false);

    fireEvent.click(button);
    expect(clicks).toBe(1);
  });

  test("window blur, a hidden tab and the control's own blur all cancel a press", async () => {
    render(createElement(PressDepth, { variant: "solid", children: "Hold" }));
    const button = screen.getByRole("button", { name: "Hold" });
    button.getBoundingClientRect = () => box;
    const down = () => act(async () => void fireEvent.pointerDown(button, { pointerId: 2, pointerType: "touch", clientX: 5, clientY: 5 }));

    await down();
    await act(async () => void window.dispatchEvent(new Event("blur")));
    expect(pressed(button)).toBe(false);

    await down();
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(pressed(button)).toBe(true);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(pressed(button)).toBe(false);

    await down();
    await act(async () => void fireEvent.blur(button));
    expect(pressed(button)).toBe(false);

    await down();
    await onWindow("pointercancel", { pointerId: 2 });
    expect(pressed(button)).toBe(false);
  });

  test("Enter and Space press from the keyboard; repeats are ignored; Escape releases", async () => {
    render(createElement(PressDepth, null, "Key"));
    const button = screen.getByRole("button", { name: "Key" });
    await act(async () => void fireEvent.keyDown(button, { key: "a" }));
    expect(pressed(button)).toBe(false);
    await act(async () => void fireEvent.keyDown(button, { key: "Enter", repeat: true }));
    expect(pressed(button)).toBe(false);
    await act(async () => void fireEvent.keyDown(button, { key: "Enter" }));
    expect(pressed(button)).toBe(true);
    await act(async () => void fireEvent.keyUp(button, { key: "b" }));
    expect(pressed(button)).toBe(true);
    await act(async () => void fireEvent.keyUp(button, { key: "Enter" }));
    expect(pressed(button)).toBe(false);
    await act(async () => void fireEvent.keyDown(button, { key: " " }));
    expect(pressed(button)).toBe(true);
    await act(async () => void fireEvent.keyUp(button, { key: "Escape" }));
    expect(pressed(button)).toBe(false);
  });

  test("a disabled button ignores presses", async () => {
    render(createElement(PressDepth, { disabled: true, children: "Off" }));
    const button = screen.getByRole("button", { name: "Off" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => void fireEvent.pointerDown(button, { pointerId: 1, pointerType: "mouse", button: 0 }));
    await act(async () => void fireEvent.keyDown(button, { key: "Enter" }));
    expect(pressed(button)).toBe(false);
  });
});

describe("usePressDepth", () => {
  test("reports press start/end, a clamped origin, and releases when it becomes disabled", async () => {
    const events: string[] = [];
    let last: ReturnType<typeof usePressDepth> | null = null;
    function Harness({ disabled }: { disabled: boolean }) {
      const state = usePressDepth({ disabled, onPressStart: () => events.push("start"), onPressEnd: () => events.push("end") });
      last = state;
      return createElement("div", { ref: state.ref, role: "button", tabIndex: 0, ...state.bind }, state.pressed ? "down" : "up");
    }
    const view = render(createElement(Harness, { disabled: false }));
    const el = screen.getByRole("button");
    el.getBoundingClientRect = () => box;
    await act(async () => void fireEvent.pointerDown(el, { pointerId: 3, pointerType: "pen", clientX: 400, clientY: -100 }));
    expect(events).toEqual(["start"]);
    expect(last!.origin).toEqual({ x: 1, y: -1 });

    view.rerender(createElement(Harness, { disabled: true }));
    await act(async () => {
      await nextFrame();
      await nextFrame();
    });
    expect(events).toEqual(["start", "end"]);
    expect(last!.pressed).toBe(false);
    expect(last!.origin).toBeNull();
  });
});
