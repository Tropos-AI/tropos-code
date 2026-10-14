import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { mountPage, stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent } = await import("@testing-library/react");
const { PluginsPage } = await import("@/app/pages/PluginsPage");

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

describe("PluginsPage", () => {
  test("shows enabled and disabled badges with versions", async () => {
    await mountPage(PluginsPage, { panel: () => PLUGINS });
    const on = (await screen.findByRole("button", { name: /tropos-essentials/ })).closest("li")!;
    const off = screen.getByRole("button", { name: /old-theme/ }).closest("li")!;
    expect(on.textContent).toContain("enabled");
    expect(on.textContent).toContain("v1.4.0");
    expect(off.textContent).toContain("disabled");
  });

  test("expanding a plugin shows its root folder", async () => {
    await mountPage(PluginsPage, { panel: () => PLUGINS });
    const row = await screen.findByRole("button", { name: /old-theme/, expanded: false });
    fireEvent.click(row);
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect(detail.textContent).toContain("/home/me/.tropos/plugins/old-theme");
    expect(detail.textContent).toContain('"disabledPlugins"');
  });

  test("empty: says where plugins go", async () => {
    await mountPage(PluginsPage, { panel: () => ({ ...PLUGINS, sections: [] }) });
    expect(await screen.findByText("No plugins")).toBeTruthy();
    expect(screen.getByText("~/.tropos/plugins/").tagName).toBe("CODE");
  });
});
