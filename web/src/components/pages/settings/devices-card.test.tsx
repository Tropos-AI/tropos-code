import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DeviceView } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { DevicesCard, lastUsedLabel } = await import("@/components/pages/settings/devices-card");

const NOW = Date.now();
const DAY = 86_400_000;
const DEVICES: DeviceView[] = [
  { id: "d1", name: "Chrome on macOS", createdAt: NOW - 30 * DAY, lastSeen: NOW, via: "local", current: true },
  { id: "d2", name: "Safari on iPhone", createdAt: NOW - 10 * DAY, lastSeen: NOW - 3 * DAY, via: "tailscale", current: false },
];

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

/** Lets the dialog's exit animation finish inside act(). */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

const row = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

describe("lastUsedLabel", () => {
  test("active now, minutes, hours, days", () => {
    expect(lastUsedLabel(NOW - 30_000, NOW)).toBe("active now");
    expect(lastUsedLabel(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(lastUsedLabel(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
    expect(lastUsedLabel(NOW - 3 * DAY, NOW)).toBe("3 days ago");
  });
});

describe("DevicesCard", () => {
  test("lists devices with name, 'This device', how it connects and last use; Log out asks first", async () => {
    const revoked: unknown[] = [];
    const { socket } = await mountAdminPage(DevicesCard, {
      "devices.list": () => DEVICES,
      "devices.revoke": (p) => (revoked.push(p), { removed: true }),
    });
    await screen.findByText("Chrome on macOS");
    expect(row("Chrome on macOS").textContent).toBe("Chrome on macOSThis deviceon this Mac · active nowLog out");
    expect(row("Safari on iPhone").textContent).toBe("Safari on iPhonethrough Tailscale · 3 days agoLog out");

    fireEvent.click(within(row("Safari on iPhone")).getByRole("button", { name: "Log out Safari on iPhone" }));
    expect(revoked).toEqual([]);
    expect(await screen.findByText("Log out Safari on iPhone?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(revoked).toEqual([{ id: "d2" }]));
    await waitFor(() => expect(socket.adminOf("devices.list").length).toBe(2));
    await settle();
  });

  test("Cancel keeps the device logged in", async () => {
    const { socket } = await mountAdminPage(DevicesCard, { "devices.list": () => DEVICES, "devices.revoke": () => ({ removed: true }) });
    await screen.findByText("Safari on iPhone");
    fireEvent.click(screen.getByRole("button", { name: "Log out Safari on iPhone" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await settle();
    expect(socket.adminOf("devices.revoke")).toHaveLength(0);
  });

  test("logging out this device says it ends this browser's session", async () => {
    await mountAdminPage(DevicesCard, { "devices.list": () => DEVICES });
    await screen.findByText("Chrome on macOS");
    fireEvent.click(screen.getByRole("button", { name: "Log out Chrome on macOS" }));
    expect((await screen.findByText(/This is the browser you are using/)).textContent).toContain("login screen");
    expect(screen.getByRole("button", { name: "Log out, including this browser" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
  });

  test("Log out everywhere warns that this browser logs out too", async () => {
    let all = 0;
    await mountAdminPage(DevicesCard, { "devices.list": () => DEVICES, "devices.revokeAll": () => ((all += 1), { removed: 2 }) });
    await screen.findByText("Chrome on macOS");
    fireEvent.click(screen.getByRole("button", { name: "Log out everywhere" }));
    expect((await screen.findByText(/and this browser too/)).textContent).toContain("tcode dashboard");
    expect(all).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Log out, including this browser" }));
    await waitFor(() => expect(all).toBe(1));
    await settle();
  });

  test("a failing log out shows the error in the dialog and keeps it open", async () => {
    await mountAdminPage(DevicesCard, { "devices.list": () => DEVICES, "devices.revoke": () => { throw new Error("device store locked"); } });
    await screen.findByText("Safari on iPhone");
    fireEvent.click(screen.getByRole("button", { name: "Log out Safari on iPhone" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect((await screen.findByText("device store locked")).closest("[role=alert]")).toBeTruthy();
    expect(screen.getByText("Log out Safari on iPhone?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
  });

  test("rows stack on narrow screens: the Log out button is full width and 44px tall below 640px", async () => {
    await mountAdminPage(DevicesCard, { "devices.list": () => DEVICES });
    await screen.findByText("Safari on iPhone");
    const button = screen.getByRole("button", { name: "Log out Safari on iPhone" });
    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-full");
    expect(row("Safari on iPhone").className).toContain("flex-col");
  });

  test("an empty list says so and offers no log out everywhere", async () => {
    await mountAdminPage(DevicesCard, { "devices.list": () => [] });
    await screen.findByText("No browser is logged in.");
    expect(screen.queryByRole("button", { name: "Log out everywhere" })).toBeNull();
  });
});
