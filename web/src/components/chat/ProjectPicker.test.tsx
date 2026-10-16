// web/src/components/chat/ProjectPicker.test.tsx — the top-bar project picker: shown only in the dashboard, switches
// this tab's chat with project.select, remembers the choice for the tab, and respects a running turn.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ProjectView } from "@core/web/admin/api";
import type { HelloInfo } from "@core/web/protocol";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ProjectPicker } = await import("@/components/chat/ProjectPicker");
const { connectedStore, withProviders, wait, HELLO, IDLE } = await import("@/components/chat/chat-test-kit");

const KEY = "tcode.chatProject";
const PROJECTS: ProjectView[] = [
  { id: "app", name: "App", path: "/work/app", isDefault: true, gitRepo: true },
  { id: "site", name: "Site", path: "/work/site", isDefault: false, gitRepo: false },
];
const helloIn = (id: string, name: string): HelloInfo => ({ ...HELLO, project: { id, name } });

beforeEach(() => window.sessionStorage.clear());
afterEach(() => cleanup());

async function mount(opts: { project?: { id: string; name: string }; rpc?: Parameters<typeof connectedStore>[0]; admin?: Parameters<typeof connectedStore>[1] } = {}) {
  const ctx = connectedStore(opts.rpc ?? { "project.select": () => helloIn("site", "Site") }, opts.admin ?? { "projects.list": () => PROJECTS });
  render(withProviders(ctx.store, createElement(ProjectPicker)));
  await act(async () => {
    ctx.socket.deliver({ t: "hello", server: opts.project ? { ...HELLO, project: opts.project } : HELLO });
    await wait(0);
  });
  return ctx;
}

const button = () => screen.getByRole("button", { name: /Change project/ });
const openMenu = async () => {
  await act(async () => void fireEvent.click(button()));
  await act(() => wait(10));
};

describe("ProjectPicker", () => {
  test("hidden without a project in hello", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: /project/i })).toBeNull();
  });

  test("shows the current project and lists the registered ones", async () => {
    await mount({ project: { id: "app", name: "App" } });
    expect(button().getAttribute("aria-label")).toBe("Project: App. Change project");
    expect(button().textContent).toContain("Project: App");
    await openMenu();
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["App", "Site"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  });

  test("choosing a project sends project.select and remembers it for this tab", async () => {
    const { socket } = await mount({ project: { id: "app", name: "App" } });
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Site" }));
      await wait(10);
    });
    expect(socket.rpcs("project.select").map((r) => r.params)).toEqual(["site"]);
    expect(window.sessionStorage.getItem(KEY)).toBe("site");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("Escape closes the list and returns focus to the button; arrows and Enter choose", async () => {
    const { socket } = await mount({ project: { id: "app", name: "App" } });
    await openMenu();
    const list = screen.getByRole("listbox");
    expect(document.activeElement).toBe(list);
    await act(async () => void fireEvent.keyDown(list, { key: "Escape" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button());
    await openMenu();
    const again = screen.getByRole("listbox");
    await act(async () => void fireEvent.keyDown(again, { key: "ArrowDown" }));
    await act(async () => {
      fireEvent.keyDown(again, { key: "Enter" });
      await wait(10);
    });
    expect(socket.rpcs("project.select").map((r) => r.params)).toEqual(["site"]);
  });

  test("after reconnecting into the default project, the remembered project is selected again", async () => {
    window.sessionStorage.setItem(KEY, "site");
    const { socket } = await mount({ project: { id: "app", name: "App" } });
    expect(socket.rpcs("project.select").map((r) => r.params)).toEqual(["site"]);
    // The server's answer arrives as the tab's new hello: nothing more to do.
    await act(async () => {
      socket.deliver({ t: "hello", server: helloIn("site", "Site") });
      await wait(10);
    });
    expect(socket.rpcs("project.select")).toHaveLength(1);
    expect(button().getAttribute("aria-label")).toBe("Project: Site. Change project");
  });

  test("a remembered project that no longer exists is forgotten, with a toast", async () => {
    window.sessionStorage.setItem(KEY, "gone");
    const { store } = await mount({
      project: { id: "app", name: "App" },
      rpc: {
        "project.select": () => {
          throw new Error('There is no project "gone".');
        },
      },
    });
    await act(() => wait(10));
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(store.getState().toasts.at(-1)).toMatchObject({ tone: "error", title: "Could not switch project", description: expect.stringContaining("gone") });
  });

  test("disabled while a turn runs", async () => {
    const { socket } = await mount({ project: { id: "app", name: "App" } });
    await act(async () => void socket.deliver({ t: "state", state: { ...IDLE, busy: true } }));
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(button().getAttribute("title")).toBe("Finish or stop the current turn first");
  });

  test("a failed switch toasts the reason and keeps the current project", async () => {
    const { store } = await mount({
      project: { id: "app", name: "App" },
      rpc: {
        "project.select": () => {
          throw new Error("Could not open it");
        },
      },
    });
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Site" }));
      await wait(10);
    });
    expect(store.getState().toasts.at(-1)).toMatchObject({ tone: "error", title: "Could not switch project", description: "Could not open it" });
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test("switching away while an approval is still waiting says so", async () => {
    const { socket, store } = await mount({ project: { id: "app", name: "App" } });
    await act(async () => void socket.deliver({ t: "ask", id: 7, prompt: { tool: "Bash", summary: "rm x" } as never }));
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Site" }));
      await wait(10);
    });
    expect(store.getState().toasts.some((t) => t.title === "A turn in App is still waiting for you")).toBe(true);
  });

  test("works at phone widths: the list is bounded by the viewport, not by the button", async () => {
    await mount({ project: { id: "app", name: "App" } });
    await openMenu();
    expect(screen.getByRole("listbox").parentElement?.className).toContain("max-sm:fixed");
    expect(button().className).toContain("max-w-");
  });
});
