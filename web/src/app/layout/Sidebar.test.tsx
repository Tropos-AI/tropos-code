// web/src/app/layout/Sidebar.test.tsx — the brand (logo, version, demo badge), New session and page nav.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PageId } from "@/app/routes";
import { mountPage, stubMatchMedia, TEST_STATE, type RpcHandlers } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { Brand, SidebarContent } = await import("@/app/layout/Sidebar");
const { within, waitFor } = await import("@testing-library/react");

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

const brandLink = () => screen.getByRole("link", { name: "Tropos Code" });

describe("Brand", () => {
  test("the logo without a background and the version chip; no name beside it", () => {
    render(createElement(Brand, { version: "0.5.4" }));
    const link = brandLink();
    expect(link.querySelector("img")!.getAttribute("src")).toBe("/brand/favicon-192.png");
    expect(link.textContent).toBe("v0.5.4");
    expect(link.getAttribute("aria-label")).toBe("Tropos Code");
    expect(link.getAttribute("href")).toBe("#/chat");
  });

  test("without a version: the logo alone", () => {
    render(createElement(Brand, {}));
    expect(brandLink().textContent).toBe("");
    expect(brandLink().querySelector("img")).toBeTruthy();
  });

  test("demo shows a badge instead of the version", () => {
    render(createElement(Brand, { version: "0.5.4", demo: true }));
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.queryByText("v0.5.4")).toBeNull();
  });
});

describe("SidebarContent", () => {
  async function mount(props: { page?: PageId; showBrand?: boolean } = {}, handlers: RpcHandlers = {}, identity?: { name?: string; emoji?: string }) {
    const navigated: PageId[] = [];
    let closed = 0;
    function Sidebar() {
      return createElement(SidebarContent, {
        page: props.page ?? "chat",
        navigate: (page: PageId) => navigated.push(page),
        onNavigated: () => closed++,
        showBrand: props.showBrand,
        idPrefix: "test",
      });
    }
    const mounted = await mountPage(Sidebar, { sessions: () => [], ...handlers }, { hello: identity ? { identity } : {} });
    return { ...mounted, navigated, closed: () => closed };
  }

  test("the brand is the logo and the version, never the agent's name from hello or a later state", async () => {
    const { socket } = await mount({}, {}, { name: "Nova", emoji: "🦊" });
    expect(brandLink().textContent).toBe("v0.5.4");
    await act(async () => {
      socket.deliver({ t: "state", state: { ...TEST_STATE, identity: { name: "Bob", emoji: "🔧" } } });
    });
    expect(brandLink().textContent).toBe("v0.5.4");
    expect(brandLink().getAttribute("aria-label")).toBe("Tropos Code");
  });

  test("without an identity the brand is the same; showBrand=false hides it", async () => {
    await mount();
    expect(brandLink().textContent).toBe("v0.5.4");
    cleanup();
    await mount({ showBrand: false });
    expect(screen.queryByRole("link", { name: /Tropos Code/ })).toBeNull();
  });

  test("the current page is marked in the nav; links close the drawer", async () => {
    const { closed } = await mount({ page: "memory" });
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const current = nav.querySelector("[aria-current=page]");
    expect(current?.textContent).toBe("Memory");
    fireEvent.click(screen.getByRole("link", { name: "Skills" }));
    expect(closed()).toBe(1);
  });

  test("New session clears, then goes to chat and closes the drawer", async () => {
    const { socket, navigated, closed } = await mount({ page: "skills" }, { clear: () => null });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(socket.callsOf("clear")).toHaveLength(1);
    expect(navigated).toEqual(["chat"]);
    expect(closed()).toBe(1);
  });

  test("a failed New session toasts and stays put", async () => {
    const { store, navigated } = await mount(
      {},
      {
        clear: () => {
          throw new Error("disk full");
        },
      },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(navigated).toEqual([]);
    expect(store.getState().toasts.at(-1)).toMatchObject({ tone: "error", title: "Could not start a new session" });
    expect(store.getState().toasts.at(-1)?.description).toContain("disk full");
  });

  test("ten entries in three groups", async () => {
    await mount();
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Chat", "Projects", "Schedule", "Skills", "Agents", "Memory", "Harness", "Extensions", "Status", "Settings"]);
    expect(within(nav).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Work", "Agent", "Control"]);
  });

  test("Setup shows only while setup is unfinished", async () => {
    function Sidebar() {
      return createElement(SidebarContent, { page: "chat", navigate: () => {}, idPrefix: "t" });
    }
    await mountAdminPage(Sidebar, { "status.get": () => ({ needsOnboarding: true }) }, { sessions: () => [] });
    const nav = screen.getByRole("navigation", { name: "Pages" });
    await waitFor(() => expect(within(nav).getByRole("link", { name: "Setup" })).toBeTruthy());
    const control = within(nav).getByRole("region", { name: "Control" });
    expect(within(control).getAllByRole("link").map((a) => a.textContent)).toEqual(["Setup", "Status", "Settings"]);
    cleanup();
    await mountAdminPage(Sidebar, { "status.get": () => ({ needsOnboarding: false }) }, { sessions: () => [] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(screen.getByRole("navigation", { name: "Pages" })).queryByRole("link", { name: "Setup" })).toBeNull();
  });
});
