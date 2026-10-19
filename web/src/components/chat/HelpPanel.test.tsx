// web/src/components/chat/HelpPanel.test.tsx — /help: General, Commands, Custom and Shortcuts tabs in a modal.
import { afterEach, describe, expect, test } from "bun:test";

import { COMMANDS, type ExtraCommand } from "@core/ui/commands";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { HelpPanel, WEB_SHORTCUTS } = await import("@/components/chat/HelpPanel");
const { connectedStore, withProviders, wait } = await import("@/components/chat/chat-test-kit");

afterEach(() => {
  cleanup();
});

const CUSTOM: ExtraCommand[] = [
  { name: "review", description: "Review the diff", argumentHint: "[path]" },
  { name: "frontend-design", description: "(skill) Distinctive UI" },
];

async function open({ commands = CUSTOM, version }: { commands?: ExtraCommand[]; version?: string } = { version: "0.5.0" }) {
  let closed = 0;
  render(withProviders(connectedStore().store, createElement(HelpPanel, { open: true, onClose: () => closed++, version, commands })));
  await screen.findByRole("dialog", { name: "Help" });
  const tab = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("tab", { name }));
      await wait(10);
    });
  return { tab, closed: () => closed };
}

/** The panel of the selected tab (the previous one may still be fading out). */
const panel = () => {
  const selected = screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")!;
  return document.getElementById(selected.getAttribute("aria-controls")!)!;
};

describe("HelpPanel", () => {
  test("opens on General with the version", async () => {
    await open();
    for (const name of ["General", "Commands", "Custom", "Shortcuts"]) expect(screen.getByRole("tab", { name })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    expect(panel().textContent).toContain("Tropos Code reads, edits and runs code");
    expect(panel().textContent).toContain("tcode v0.5.0");
  });

  test("leaves the version out when it is unknown", async () => {
    await open({ version: undefined });
    expect(panel().textContent).not.toContain("tcode v");
  });

  test("Commands lists every built-in slash command", async () => {
    const { tab } = await open();
    await tab("Commands");
    const text = panel().textContent ?? "";
    for (const c of COMMANDS) expect(text).toContain(`/${c.name}`);
  });

  test("Custom lists project commands with their hint, and marks skills", async () => {
    const { tab } = await open();
    await tab("Custom");
    const names = [...panel().querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(names).toEqual(["/review [path]", "/frontend-design"]);
    const rows = [...panel().querySelectorAll("dd")];
    expect(rows[0]!.textContent).toBe("Review the diff");
    expect(rows[1]!.textContent).toBe("Distinctive UIskill");
    expect(panel().querySelector("dt.text-violet")!.textContent).toBe("/frontend-design");
  });

  test("Custom explains how to add commands when there are none", async () => {
    const { tab } = await open({ commands: [], version: "0.5.0" });
    await tab("Custom");
    expect(panel().textContent).toContain("No custom commands or skills yet.");
    expect(panel().textContent).toContain(".tropos/skills/name/SKILL.md");
  });

  test("Shortcuts shows the browser's keys", async () => {
    const { tab } = await open();
    await tab("Shortcuts");
    expect(panel().querySelectorAll("dt")).toHaveLength(WEB_SHORTCUTS.length);
    expect(panel().textContent).toContain("answer a permission prompt");
    expect(panel().querySelectorAll("kbd").length).toBeGreaterThanOrEqual(WEB_SHORTCUTS.length);
  });

  test("Esc closes it", async () => {
    const { closed } = await open();
    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    expect(closed()).toBe(1);
  });
});
