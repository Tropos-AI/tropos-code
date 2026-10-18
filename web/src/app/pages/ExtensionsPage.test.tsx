import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent } = await import("@testing-library/react");
const { ExtensionsPage } = await import("@/app/pages/ExtensionsPage");

const PANEL = { title: "x", subtitle: "", sections: [] };

beforeEach(() => {
  stubMatchMedia();
  window.history.replaceState(null, "", "#/extensions");
});
afterEach(() => cleanup());

async function mount() {
  return mountAdminPage(ExtensionsPage, { "mcp.list": () => [] }, { panel: () => PANEL });
}

describe("ExtensionsPage", () => {
  test("tabs MCP servers, Hooks and Plugins; MCP opens first", async () => {
    await mount();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Extensions");
    expect(screen.getByRole("button", { name: /Add server/ })).toBeTruthy();
  });

  test("switching tabs writes the hash without adding history entries", async () => {
    await mount();
    const before = window.history.length;
    fireEvent.click(await screen.findByRole("tab", { name: "Hooks" }));
    expect(window.location.hash).toBe("#/extensions/hooks");
    expect(window.history.length).toBe(before);
  });

  test("#/extensions/plugins opens Plugins; the old #/hooks address lands on Hooks", async () => {
    window.history.replaceState(null, "", "#/extensions/plugins");
    await mount();
    expect((await screen.findByRole("tab", { name: "Plugins" })).getAttribute("aria-selected")).toBe("true");
    cleanup();
    window.history.replaceState(null, "", "#/hooks");
    await mount();
    expect((await screen.findByRole("tab", { name: "Hooks" })).getAttribute("aria-selected")).toBe("true");
  });
});
