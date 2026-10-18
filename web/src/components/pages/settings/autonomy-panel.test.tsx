import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AutonomyView } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage, type AdminHandlers } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { AutonomyPanel } = await import("@/components/pages/settings/autonomy-panel");

const VIEW: AutonomyView = {
  level: "balanced",
  backend: "host",
  confinement: "sandbox-exec",
  unconfinedAccepted: false,
  unconfined: false,
  projects: [
    { id: "default", name: "Default workspace", builtin: true, effective: "balanced", testCommands: [], detectedTests: [] },
    { id: "app", name: "app", effective: "balanced", testCommands: [], detectedTests: ["bun test"] },
  ],
};

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

const mount = (view: AutonomyView, handlers: AdminHandlers = {}) => mountAdminPage(AutonomyPanel, { "autonomy.get": () => view, ...handlers });

describe("AutonomyPanel", () => {
  test("three levels with one risk sentence each; Balanced is marked as the default", async () => {
    await mount(VIEW);
    const list = await screen.findByRole("list", { name: "What each level does" });
    const items = within(list).getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toBe("Ask: every edit and command asks first.");
    expect(items[1]).toBe("Balanced: edits in the project, read-only commands and its tests run; everything else asks.Default");
    expect(items[2]).toBe("Autonomous: everything in the project runs; MCP tools still ask.");
  });

  test("shows the configured and the effective level", async () => {
    const view: AutonomyView = { ...VIEW, level: "autonomous", backend: "host", confinement: null, unconfinedAccepted: false, projects: [{ ...VIEW.projects[0]!, effective: "ask" }, VIEW.projects[1]!] };
    await mount(view);
    await screen.findByText("Configured");
    expect(screen.getByText("Configured").nextElementSibling?.textContent).toBe("Autonomous");
    expect(screen.getByText("Effective now").nextElementSibling?.textContent).toBe("Ask");
    expect((await screen.findByText(/chats stay at Ask/)).closest("[role=status]")).toBeTruthy();
  });

  test("choosing a level calls autonomy.set without projectId", async () => {
    const calls: unknown[] = [];
    await mount(VIEW, { "autonomy.set": (p) => (calls.push(p), { ...VIEW, level: "ask" }) });
    fireEvent.click(await screen.findByRole("radio", { name: "Ask" }));
    await waitFor(() => expect(calls).toEqual([{ level: "ask" }]));
    await waitFor(() => expect(screen.getByText("Configured").nextElementSibling?.textContent).toBe("Ask"));
  });

  test("without confinement, Balanced or Autonomous needs the 'run unconfined' confirmation", async () => {
    const calls: unknown[] = [];
    const bare: AutonomyView = { ...VIEW, level: "ask", confinement: null };
    await mount(bare, { "autonomy.set": (p) => (calls.push(p), { ...bare, level: "balanced", unconfinedAccepted: true }) });
    fireEvent.click(await screen.findByRole("radio", { name: "Balanced" }));
    expect(await screen.findByText("Commands would run without the OS sandbox")).toBeTruthy();
    expect(calls).toEqual([]);
    // Cancel: no call.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: "Balanced" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run unconfined" }));
    await waitFor(() => expect(calls).toEqual([{ level: "balanced", acceptUnconfined: true }]));
    await settle();
  });

  test("with unconfinedAccepted: true no dialog is shown; Ask never asks", async () => {
    const calls: unknown[] = [];
    const accepted: AutonomyView = { ...VIEW, level: "ask", confinement: null, unconfinedAccepted: true };
    await mount(accepted, { "autonomy.set": (p) => (calls.push(p), accepted) });
    fireEvent.click(await screen.findByRole("radio", { name: "Autonomous" }));
    await waitFor(() => expect(calls).toEqual([{ level: "autonomous" }]));
    expect(screen.queryByText("Commands would run without the OS sandbox")).toBeNull();
  });

  test("per project: inherit or override; detected test commands are listed and pinned on confirm", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const own: AutonomyView = { ...VIEW, projects: [VIEW.projects[0]!, { ...VIEW.projects[1]!, level: "autonomous", effective: "autonomous" }] };
    await mount(own, {
      "autonomy.set": (p) => (calls.push({ method: "set", params: p }), VIEW),
      "autonomy.confirmTests": (p) => (calls.push({ method: "tests", params: p }), { ...VIEW, projects: [VIEW.projects[0]!, { ...VIEW.projects[1]!, testCommands: ["bun test"] }] }),
    });
    const select = (await screen.findByLabelText("Level for app")) as HTMLSelectElement;
    expect(select.value).toBe("autonomous");
    fireEvent.change(select, { target: { value: "inherit" } });
    await waitFor(() => expect(calls).toEqual([{ method: "set", params: { level: null, projectId: "app" } }]));

    expect(screen.getByRole("list", { name: "Detected tests for app" }).textContent).toBe("bun test");
    fireEvent.click(screen.getByRole("button", { name: "Pin these tests for app" }));
    await waitFor(() => expect(calls[1]).toEqual({ method: "tests", params: { projectId: "app", commands: ["bun test"] } }));
    expect((await screen.findByRole("list", { name: "Pinned tests for app" })).textContent).toBe("bun test");
    expect(screen.queryByRole("list", { name: "Detected tests for app" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unpin the tests for app" }));
    await waitFor(() => expect(calls[2]).toEqual({ method: "tests", params: { projectId: "app", commands: [] } }));
  });

  test("a built-in project follows the global level and shows no tests or select", async () => {
    await mount(VIEW);
    const builtin = (await screen.findByText("Default workspace")).closest("li") as HTMLElement;
    expect(within(builtin).queryByRole("combobox")).toBeNull();
    expect(within(builtin).queryByText("Tests that may run unasked")).toBeNull();
    expect(builtin.textContent).toContain("follows the global level");
    expect(builtin.textContent).toContain("Configured: Global (Balanced)");
  });

  test("a chat can only lower the level: the panel says so", async () => {
    await mount(VIEW);
    const note = await screen.findByText(/only lower/);
    expect(note.textContent).toContain("/autonomy");
  });

  test("an error from the server is shown in a notice, with the old level kept", async () => {
    await mount(VIEW, { "autonomy.set": () => { throw new Error("Commands can't be confined on this machine."); } });
    fireEvent.click(await screen.findByRole("radio", { name: "Autonomous" }));
    expect((await screen.findByText(/can't be confined on this machine/)).closest("[role=alert]")).toBeTruthy();
    expect(screen.getByText("Configured").nextElementSibling?.textContent).toBe("Balanced");
  });

  test("below 400px the global level is a radio list", async () => {
    stubMatchMedia({ width: 360 });
    await mount(VIEW);
    const group = await screen.findByRole("group", { name: "Global autonomy level" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect((within(group).getByRole("radio", { name: /Balanced/ }) as HTMLInputElement).checked).toBe(true);
  });
});
