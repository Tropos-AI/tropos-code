import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { mountPage, stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, within } = await import("@testing-library/react");
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
    await mountPage(MemoryPage, { panel: () => MEMORY });
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
    await mountPage(MemoryPage, { panel: () => MEMORY });
    const toggle = await screen.findByRole("button", { name: "2 more lines" });
    expect(screen.queryAllByRole("button", { name: /more line/ })).toHaveLength(1);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)!.textContent).toContain("2. tag and push");
  });

  test("memory turned off shows the panel's empty text", async () => {
    await mountPage(MemoryPage, { panel: () => ({ title: "Memory", sections: [], empty: 'Memory is off ("memory": false in settings).' }) });
    expect(await screen.findByText(/Memory is off/)).toBeTruthy();
  });
});
