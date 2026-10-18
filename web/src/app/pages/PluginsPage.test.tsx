import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { mountPage, stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { PluginsPanel } = await import("@/app/pages/PluginsPage");

const PLUGINS: PanelData = {
  title: "Plugins",
  subtitle: "2 plugins",
  sections: [
    {
      items: [
        { key: "essentials", label: "tropos-essentials", hint: "Release helpers", aside: "1.4.0", status: "ok", detail: ["/home/me/.tropos/plugins/tropos-essentials", "Enabled"] },
        { key: "old", label: "old-theme", hint: "Old colours", aside: "0.1.0", status: "off", detail: ["/home/me/.tropos/plugins/old-theme", 'Disabled ("disabledPlugins" in settings)'] },
      ],
    },
  ],
  empty: "No plugins. Put plugin folders in ~/.tropos/plugins/.",
};

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("PluginsPanel", () => {
  test("shows enabled and disabled badges with versions", async () => {
    await mountPage(PluginsPanel, { panel: () => PLUGINS });
    const on = (await screen.findByRole("button", { name: /tropos-essentials/ })).closest("li")!;
    const off = screen.getByRole("button", { name: /old-theme/ }).closest("li")!;
    expect(on.textContent).toContain("enabled");
    expect(on.textContent).toContain("v1.4.0");
    expect(off.textContent).toContain("disabled");
  });

  test("expanding a plugin shows its root folder", async () => {
    await mountPage(PluginsPanel, { panel: () => PLUGINS });
    const row = await screen.findByRole("button", { name: /old-theme/, expanded: false });
    fireEvent.click(row);
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect(detail.textContent).toContain("/home/me/.tropos/plugins/old-theme");
    expect(detail.textContent).toContain('"disabledPlugins"');
  });

  test("empty: says where plugins go", async () => {
    await mountPage(PluginsPanel, { panel: () => ({ ...PLUGINS, sections: [] }) });
    expect(await screen.findByText("No plugins")).toBeTruthy();
    expect(screen.getByText("~/.tropos/plugins/").tagName).toBe("CODE");
  });

  test("each plugin has a switch that calls plugins.setEnabled", async () => {
    const { socket } = await mountAdminPage(PluginsPanel, { "plugins.setEnabled": (p: { name: string; enabled: boolean }) => p }, { panel: () => PLUGINS });
    const off = await screen.findByRole("switch", { name: "Enable old-theme" });
    expect(off.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Disable tropos-essentials" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(off);
    await waitFor(() => expect(socket.adminOf("plugins.setEnabled")[0]?.params).toEqual({ name: "old-theme", enabled: true }));
    await waitFor(() => expect(document.querySelector('[role="switch"][aria-label="Disable old-theme"]')).not.toBeNull());
    expect(screen.getByRole("button", { name: /old-theme/ }).closest("li")!.textContent).toContain("enabled");
    expect(document.body.textContent).toContain("2 enabled");
  });

  test("when the admin call fails the panel keeps working and the reason shows in the details", async () => {
    await mountAdminPage(PluginsPanel, { "plugins.setEnabled": () => Promise.reject(new Error("Not available in the demo.")) }, { panel: () => PLUGINS });
    fireEvent.click(await screen.findByRole("switch", { name: "Enable old-theme" }));
    await waitFor(() => expect(document.querySelector('[role="switch"][aria-label="Enable old-theme"]')).not.toBeNull());
    const row = screen.getByRole("button", { name: /old-theme/ });
    fireEvent.click(row);
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect((await screen.findByText(/Not available in the demo\./)).closest('[role="alert"]')).toBeTruthy();
    expect(detail.textContent).toContain("/home/me/.tropos/plugins/old-theme");
  });
});
