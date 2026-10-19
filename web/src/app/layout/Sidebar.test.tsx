// web/src/app/layout/Sidebar.test.tsx — the brand (agent identity, version, demo badge), New session and page nav.
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

const brandLink = () => screen.getByRole("link", { name: /Tropos Code/ });

describe("Brand", () => {
  test("with a named identity: emoji and name, then a small Tropos Code line", () => {
    render(createElement(Brand, { version: "0.5.1", identity: { name: "Nova", emoji: "🦊" } }));
    const link = brandLink();
    expect(link.textContent).toContain("🦊 Nova");
    expect(screen.getByText("Tropos Code").className).toContain("text-[11px]");
    expect(link.getAttribute("href")).toBe("#/chat");
    expect(screen.getByText("v0.5.1")).toBeTruthy();
  });

  test("a name without an emoji shows the bare name", () => {
    render(createElement(Brand, { identity: { name: "Nova" } }));
    const name = screen.getByText("Nova");
    expect(name.textContent).toBe("Nova");
    expect(screen.getByText("Tropos Code")).toBeTruthy();
  });

  test("no identity, or one without a name: just Tropos Code", () => {
    render(createElement(Brand, { identity: { emoji: "🦊" } }));
    const link = brandLink();
    expect(link.textContent).not.toContain("🦊");
    expect(screen.getByText("Tropos Code").className).toContain("text-[15px]");
    cleanup();
    render(createElement(Brand, {}));
    expect(brandLink().textContent).toBe("Tropos Code");
  });

  test("demo shows a badge instead of the version", () => {
    render(createElement(Brand, { version: "0.5.1", demo: true }));
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.queryByText("v0.5.1")).toBeNull();
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

  test("the brand shows the agent's identity from hello", async () => {
    await mount({}, {}, { name: "Nova", emoji: "🦊" });
    expect(brandLink().textContent).toContain("🦊 Nova");
    expect(screen.getByText("v0.5.1")).toBeTruthy();
  });

  test("a name saved mid-session arrives with the next state and replaces the one from hello", async () => {
    const { socket } = await mount({}, {}, { name: "Nova" });
    expect(brandLink().textContent).toContain("Nova");
    await act(async () => {
      socket.deliver({ t: "state", state: { ...TEST_STATE, identity: { name: "Bob", emoji: "🔧" } } });
    });
    expect(brandLink().textContent).toContain("🔧 Bob");
    expect(brandLink().textContent).not.toContain("Nova");
  });

  test("without an identity the brand is just Tropos Code; showBrand=false hides it", async () => {
    await mount();
    expect(screen.getByText("Tropos Code").className).toContain("text-[15px]");
    expect(brandLink().textContent).not.toContain("Nova");
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

  test("nine entries in three groups", async () => {
    await mount();
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Chat", "Projects", "Schedule", "Skills", "Agents", "Memory", "Extensions", "Status", "Settings"]);
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
