// web/src/components/interior/drawer.test.tsx — a closed drawer must be inert from the moment it mounts: its links sit
// off-screen, and a keyboard or screen reader must not be able to reach them (found by the phone screenshots).
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { Drawer } = await import("@/components/interior/drawer");

afterEach(cleanup);

const frame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(null)))));
const mount = (open: boolean) =>
  render(createElement(Drawer, { open, onOpenChange: () => {}, title: "Menu", children: createElement("a", { href: "#x" }, "Chat") }));
const panelOf = () => screen.getByText("Chat", { selector: "a" }).closest("[aria-labelledby]") as HTMLElement & { inert?: boolean };

describe("Drawer", () => {
  test("closed on first render: the panel is inert; opening it makes it live again", async () => {
    const view = mount(false);
    await frame();
    expect(panelOf().inert).toBe(true);
    view.rerender(createElement(Drawer, { open: true, onOpenChange: () => {}, title: "Menu", children: createElement("a", { href: "#x" }, "Chat") }));
    await frame();
    expect(panelOf().inert).toBe(false);
  });
});
