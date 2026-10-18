import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { mountPage, stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const { HooksPanel, hookView } = await import("@/app/pages/HooksPage");

const HOOKS: PanelData = {
  title: "Hooks",
  sections: [
    {
      title: "Settings (~/.tropos/settings.json)",
      items: [
        { key: "s:PreToolUse:0:0", label: "PreToolUse [Bash]", hint: "~/.tropos/hooks/guard.sh", detail: ["~/.tropos/hooks/guard.sh", "Timeout: 60s"] },
        { key: "s:Stop:0:0", label: "Stop", hint: "bun test --bail", detail: ["bun test --bail\n  --reporter dots", "Timeout: 300s"] },
      ],
    },
    { title: "Plugin security-guidance", items: [{ key: "p:PreToolUse:0:0", label: "PreToolUse [Write|Edit]", hint: "node check.js", detail: ["node check.js", "Timeout: 15s"] }] },
  ],
  empty: 'No hooks. Add them under "hooks" in ~/.tropos/settings.json.',
};

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("hookView", () => {
  test("splits the event, the matcher, the command and the timeout", () => {
    expect(hookView(HOOKS.sections[0]!.items[0]!)).toEqual({ event: "PreToolUse", matcher: "Bash", command: "~/.tropos/hooks/guard.sh", timeout: "60s" });
    expect(hookView(HOOKS.sections[0]!.items[1]!).matcher).toBeUndefined();
  });
});

describe("HooksPanel", () => {
  test("shows events with their matcher chip, grouped by source", async () => {
    await mountPage(HooksPanel, { panel: () => HOOKS });
    const settings = await screen.findByRole("region", { name: /Settings/ });
    const pre = within(settings).getByRole("button", { name: /PreToolUse/ }).closest("li")!;
    expect(pre.textContent).toContain("Bash");
    expect(pre.textContent).toContain("~/.tropos/hooks/guard.sh");
    expect(screen.getByRole("region", { name: /Plugin/ }).textContent).toContain("security-guidance");
    expect(screen.getByText("3 hooks")).toBeTruthy();
  });

  test("expanding a hook shows the full command in a mono block and its timeout", async () => {
    await mountPage(HooksPanel, { panel: () => HOOKS });
    const row = await screen.findByRole("button", { name: /^Stop/, expanded: false });
    fireEvent.click(row);
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect(detail.querySelector("pre code")?.textContent).toBe("bun test --bail\n  --reporter dots");
    expect(detail.textContent).toContain("300s");
    expect(within(detail).getByRole("button", { name: "Copy command" })).toBeTruthy();
  });

  test("empty: explains where hooks go", async () => {
    await mountPage(HooksPanel, { panel: () => ({ ...HOOKS, sections: [] }) });
    expect(await screen.findByText("No hooks")).toBeTruthy();
    expect(screen.getByText('"hooks"').tagName).toBe("CODE");
  });
});
