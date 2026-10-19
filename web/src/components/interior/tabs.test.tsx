// web/src/components/interior/tabs.test.tsx — the tab strip scrolls sideways with a mouse too: its wheel, or a drag.
import { afterEach, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { Tabs } = await import("@/components/interior/tabs");

afterEach(cleanup);

const ITEMS = ["One", "Two", "Three"].map((label) => ({ value: label.toLowerCase(), label }));

function mount() {
  const changes: string[] = [];
  render(createElement(Tabs, { items: ITEMS, defaultValue: "one", label: "Sections", onValueChange: (v: string) => changes.push(v), renderPanel: (v: string) => v }));
  const row = screen.getByRole("tablist", { name: "Sections" });
  // A strip wider than its box: 600 px of tabs in 200 px.
  Object.defineProperty(row, "scrollWidth", { value: 600, configurable: true });
  Object.defineProperty(row, "clientWidth", { value: 200, configurable: true });
  row.scrollLeft = 0;
  return { row, changes };
}

test("a mouse wheel scrolls the strip sideways, and stops at its ends", () => {
  const { row } = mount();
  row.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
  expect(row.scrollLeft).toBe(120);
  row.scrollLeft = 0;
  const up = new WheelEvent("wheel", { deltaY: -50, cancelable: true });
  row.dispatchEvent(up);
  expect(up.defaultPrevented).toBe(false); // at the start already: the page scrolls as usual
});

test("dragging with the mouse scrolls the strip, and the drag doesn't open the tab it ended on", () => {
  const { row, changes } = mount();
  fireEvent.pointerDown(row, { pointerType: "mouse", button: 0, clientX: 300 });
  fireEvent.pointerMove(row, { pointerType: "mouse", clientX: 220 });
  expect(row.scrollLeft).toBe(80);
  fireEvent.pointerUp(row, { pointerType: "mouse" });
  fireEvent.click(screen.getByRole("tab", { name: "Three" }));
  expect(changes).toEqual([]);
  // A plain click still works.
  fireEvent.click(screen.getByRole("tab", { name: "Two" }));
  expect(changes).toEqual(["two"]);
});
