import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ProjectView } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { ProjectsPage } = await import("@/app/pages/ProjectsPage");

const BUILTIN: ProjectView = { id: "default", name: "workspace", path: "/home/me/.tropos/workspace", builtin: true, isDefault: true, gitRepo: true };
const APP: ProjectView = { id: "app", name: "my-app", path: "/home/me/code/my-app", isDefault: false, gitRepo: true };
const LOOSE: ProjectView = { id: "notes", name: "notes", path: "/home/me/notes", isDefault: false, gitRepo: false };

/** Role queries are slow in happy-dom on pages full of SVG icons; polling loops use plain selectors. */
const has = (selector: string): boolean => document.querySelector(selector) !== null;

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("ProjectsPage", () => {
  test("lists projects with badges and the git warning", async () => {
    await mountAdminPage(ProjectsPage, { "projects.list": () => [BUILTIN, APP, LOOSE] });
    const list = await screen.findByRole("list", { name: "Projects" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("default");
    expect(items[0]!.textContent).toContain("built-in");
    expect(within(items[0]!).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(items[1]!).getByRole("button", { name: "Remove my-app" })).toBeTruthy();
    expect(items[2]!.textContent).toContain("Not a git repository");
    expect(items[2]!.textContent).toContain("git init");
    expect(screen.getByText(/needs no setup/)).toBeTruthy();
  });

  test("shows a calm error with retry when the admin API is not available", async () => {
    let fail = true;
    await mountAdminPage(ProjectsPage, { "projects.list": () => (fail ? Promise.reject(new Error("Not available in the demo.")) : [BUILTIN]) });
    expect((await screen.findByRole("alert")).textContent).toContain("Not available in the demo.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Projects" })).toBeTruthy();
  });

  test("Make default calls projects.setDefault and reloads", async () => {
    let projects = [BUILTIN, APP];
    const { socket } = await mountAdminPage(ProjectsPage, {
      "projects.list": () => projects,
      "projects.setDefault": (p: { id: string }) => {
        projects = projects.map((x) => ({ ...x, isDefault: x.id === p.id }));
        return projects;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Make my-app the default project" }));
    await waitFor(() => expect(socket.adminOf("projects.setDefault")[0]?.params).toEqual({ id: "app" }));
    await waitFor(() => expect(has('[aria-label="Make my-app the default project"]')).toBe(false));
  });

  test("Remove asks first, then calls projects.remove", async () => {
    let projects = [BUILTIN, APP];
    const { socket } = await mountAdminPage(ProjectsPage, {
      "projects.list": () => projects,
      "projects.remove": () => {
        projects = [BUILTIN];
        return { removed: true };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Remove my-app" }));
    const dialog = await screen.findByRole("dialog");
    expect(socket.adminOf("projects.remove")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));
    await waitFor(() => expect(socket.adminOf("projects.remove")[0]?.params).toEqual({ id: "app" }));
    await waitFor(() => expect(has('[aria-label="Remove my-app"]')).toBe(false));
  });

  test("a failed removal stays in the dialog with the reason", async () => {
    await mountAdminPage(ProjectsPage, { "projects.list": () => [BUILTIN, APP], "projects.remove": () => Promise.reject(new Error("project is in use")) });
    fireEvent.click(await screen.findByRole("button", { name: "Remove my-app" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("project is in use");
  });

  test("Add project browses folders, navigates, and adds the chosen one", async () => {
    let projects = [BUILTIN];
    const tree: Record<string, { parent: string | null; entries: { name: string; path: string; isGitRepo: boolean }[] }> = {
      "/home/me": { parent: "/home", entries: [{ name: "code", path: "/home/me/code", isGitRepo: false }] },
      "/home/me/code": { parent: "/home/me", entries: [{ name: "my-app", path: "/home/me/code/my-app", isGitRepo: true }] },
      "/home/me/code/my-app": { parent: "/home/me/code", entries: [] },
    };
    const { socket } = await mountAdminPage(ProjectsPage, {
      "projects.list": () => projects,
      "projects.browse": (p: { path?: string } | undefined) => {
        const path = p?.path ?? "/home/me";
        const node = tree[path];
        if (!node) throw new Error("no such folder");
        return { path, ...node };
      },
      "projects.add": (p: { path: string; name?: string }) => {
        projects = [...projects, { ...APP, path: p.path, name: p.name ?? "my-app" }];
        return projects[1];
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /^code/ }));
    const folder = await within(dialog).findByRole("button", { name: /my-app/ });
    expect(folder.textContent).toContain("git repo");
    fireEvent.click(folder);
    await within(dialog).findByText("No sub-folders here. You can still use this folder.");
    expect((within(dialog).getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/me/code/my-app");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add this folder" }));
    await waitFor(() => expect(socket.adminOf("projects.add")[0]?.params).toEqual({ path: "/home/me/code/my-app" }));
    await waitFor(() => expect(has('[role="dialog"]')).toBe(false));
    expect(await screen.findByText("my-app")).toBeTruthy();
  });

  test("a pasted path that cannot be opened shows a calm error", async () => {
    await mountAdminPage(ProjectsPage, {
      "projects.list": () => [BUILTIN],
      "projects.browse": (p: { path?: string } | undefined) => {
        if (p?.path) throw new Error("not a folder");
        return { path: "/home/me", parent: "/home", entries: [] };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
    const dialog = await screen.findByRole("dialog");
    const field = await within(dialog).findByLabelText("Folder path");
    await waitFor(() => expect((field as HTMLInputElement).value).toBe("/home/me"));
    fireEvent.change(field, { target: { value: "/nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Go" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("not a folder");
  });
});
