import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { mountPage, stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { MemoryPage, parseUsage } = await import("@/app/pages/MemoryPage");

const MEMORY: PanelData = {
  title: "Memory",
  subtitle: "/home/me/.tropos/memories",
  sections: [
    {
      title: "agent notes [67% — 1,474/2,200 chars]",
      items: [
        { key: "memory:0", label: "Use bun, never npm.", detail: ["Use bun, never npm."] },
        { key: "memory:1", label: "Release checklist:", detail: ["Release checklist:", "1. typecheck", "2. tag and push"] },
      ],
    },
    { title: "user profile [0% — 0/1,375 chars]", items: [] },
  ],
  empty: "No notes yet.",
};

const LEARNED: PanelData = {
  title: "Learned",
  sections: [
    {
      items: [
        { key: "e3", label: "memory: undo of Memory add", hint: "undo", aside: "2026-10-14 14:10", status: "warn", detail: ["undo by user", "/home/me/.tropos/memories/MEMORY.md", "t"] },
        { key: "e2", label: "skill: SkillManage patch bun-testing", hint: "learned on its own", aside: "2026-10-14 14:02", status: "ok", detail: ["patch by review", "/home/me/.tropos/skills/bun-testing/SKILL.md", "t"] },
        { key: "e1", label: "memory: Memory add memory: uses bun", hint: "learned on its own", aside: "2026-10-14 13:40", status: "off", detail: ["add by review (undone)", "/home/me/.tropos/memories/MEMORY.md", "t"] },
      ],
    },
  ],
  empty: "Nothing learned yet.",
};

/** Answers "memory" with `memory` and "learned" with `learned`. */
const panels = (memory: PanelData, learned: PanelData = { title: "Learned", sections: [], empty: "Nothing learned yet." }) => (topic: unknown) =>
  topic === "learned" ? learned : memory;

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("parseUsage", () => {
  test("reads the usage header", () => {
    expect(parseUsage("agent notes [67% — 1,474/2,200 chars]")).toEqual({ name: "agent notes", percent: 67, used: 1474, limit: 2200 });
    expect(parseUsage("odd title")).toEqual({ name: "odd title" });
  });
});

describe("MemoryPage", () => {
  test("renders both stores with a usage meter and the notes folder", async () => {
    await mountPage(MemoryPage, { panel: panels(MEMORY) });
    const notes = await screen.findByRole("region", { name: /Agent notes/ });
    const meter = within(notes).getByRole("progressbar");
    expect(meter.getAttribute("aria-valuenow")).toBe("1474");
    expect(meter.getAttribute("aria-valuemax")).toBe("2200");
    const profile = screen.getByRole("region", { name: /User profile/ });
    expect(profile.textContent).toContain("Nothing here yet");
    expect(screen.getByText("/home/me/.tropos/memories")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy the notes folder" })).toBeTruthy();
  });

  test("multi-line entries open to their full text; single-line ones have no toggle", async () => {
    await mountPage(MemoryPage, { panel: panels(MEMORY) });
    const toggle = await screen.findByRole("button", { name: "2 more lines" });
    expect(screen.queryAllByRole("button", { name: /more line/ })).toHaveLength(1);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)!.textContent).toContain("2. tag and push");
  });

  test("memory turned off shows the panel's empty text", async () => {
    await mountPage(MemoryPage, { panel: panels({ title: "Memory", sections: [], empty: 'Memory is off ("memory": false in settings).' }) });
    expect(await screen.findByText(/Memory is off/)).toBeTruthy();
    expect(await screen.findByText("Nothing learned yet.")).toBeTruthy();
  });

  test("a learned row that can't be undone shows its reason and no Undo button", async () => {
    const locked: PanelData = {
      title: "Learned",
      sections: [{ items: [{ key: "s1", label: "setup: autonomy ask", hint: "saved while we talked", aside: "2026-10-14 14:02", status: "ok", undoable: false, detail: ["autonomy.lower by agent", "/home/me/.tropos/gateway.json", "t", "Raise autonomy in Settings → Autonomy."] }] }],
    };
    await mountPage(MemoryPage, { panel: panels(MEMORY, locked) });
    const card = await screen.findByRole("region", { name: /Learned/ });
    await within(card).findByText("setup: autonomy ask");
    expect(within(card).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(card).getByText("Raise autonomy in Settings → Autonomy.")).toBeTruthy();
  });

  test("the Learned card lists ledger entries; Undo appears only on changes that can still be reverted", async () => {
    const { socket } = await mountPage(MemoryPage, { panel: panels(MEMORY, LEARNED), "learned.undo": () => ({ summary: "skill: SkillManage patch bun-testing" }) });
    const card = await screen.findByRole("region", { name: /Learned/ });
    await within(card).findByText("skill: SkillManage patch bun-testing");
    const undo = within(card).getAllByRole("button", { name: "Undo" });
    // The undo entry itself and the already-undone add have no button.
    expect(undo).toHaveLength(1);
    await act(async () => {
      fireEvent.click(undo[0]!);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(socket.callsOf("learned.undo")[0]!.params).toBe("e2");
    // Both cards reload: the undo may have changed a note.
    expect(socket.callsOf("panel").filter((c) => c.params === "memory").length).toBeGreaterThan(1);
    expect(socket.callsOf("panel").filter((c) => c.params === "learned").length).toBeGreaterThan(1);
  });

  test("a failed undo says why and keeps the list", async () => {
    const { store } = await mountPage(MemoryPage, {
      panel: panels(MEMORY, LEARNED),
      "learned.undo": () => {
        throw new Error("The file changed since; not undone.");
      },
    });
    const card = await screen.findByRole("region", { name: /Learned/ });
    const button = await within(card).findByRole("button", { name: "Undo" });
    await act(async () => {
      fireEvent.click(button);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(within(card).getByText("skill: SkillManage patch bun-testing")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(store.getState().toasts.find((t) => t.title === "Could not undo")?.description).toContain("changed since");
  });

  test("edit a note, then delete one after confirming", async () => {
    const { socket } = await mountAdminPage(MemoryPage, { "memory.edit": () => ({ ok: true }), "memory.delete": () => ({ ok: true }) }, { panel: panels(MEMORY) });
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit note" }))[0]!);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Use bun, always" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(socket.adminCalls).toContainEqual({ method: "memory.edit", params: { target: "memory", index: 0, expected: "Use bun, never npm.", content: "Use bun, always" } }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Delete note" })[1]!);
    expect(await screen.findByText("Delete this note?")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(socket.adminCalls.at(-1)).toEqual({ method: "memory.delete", params: { target: "memory", index: 1, expected: "Release checklist:\n1. typecheck\n2. tag and push" } }));
    // Both cards reload afterwards.
    await waitFor(() => expect(socket.callsOf("panel").filter((c) => c.params === "learned").length).toBeGreaterThan(1));
  });

  test("a refused edit keeps the editor open and shows why; Cancel closes it", async () => {
    await mountAdminPage(
      MemoryPage,
      {
        "memory.edit": () => {
          throw new Error("This note changed since the page loaded. Reload and try again.");
        },
      },
      { panel: panels(MEMORY) },
    );
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit note" }))[0]!);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Use pnpm" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed since the page loaded");
    expect(screen.getByRole("textbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
