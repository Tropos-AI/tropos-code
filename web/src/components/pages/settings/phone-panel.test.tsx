import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RemoteView } from "@core/web/admin/api";

import { stubClipboard, stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage, type AdminHandlers } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { PhonePanel } = await import("@/components/pages/settings/phone-panel");

const URL_ = "https://mac.tail1234.ts.net/";
const NOT_INSTALLED: RemoteView = { enabled: false, tailscale: { installed: false, running: false }, note: "Phone access needs Tailscale." };
const READY: RemoteView = { enabled: false, tailscale: { installed: true, running: true, dnsName: "mac.tail1234.ts.net" } };
const ON: RemoteView = { ...READY, enabled: true, url: URL_ };

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

const mount = (status: RemoteView, handlers: AdminHandlers = {}) => mountAdminPage(PhonePanel, { "remote.status": () => status, ...handlers });

describe("PhonePanel", () => {
  test("not installed: three steps (Mac app, log in, phone app) and no Turn on button", async () => {
    await mount(NOT_INSTALLED);
    const steps = await screen.findByRole("list", { name: "Set up phone access" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Install the Tailscale app on this Mac.",
      "Open it and log in.",
      "Install Tailscale on your phone and log in with the same account.",
    ]);
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    const link = screen.getByRole("link", { name: /tailscale\.com\/download/ });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("installed but not running: says to open Tailscale, offers Check again, no Turn on", async () => {
    await mount({ enabled: false, tailscale: { installed: true, running: false }, note: "Tailscale is installed but isn't running or isn't signed in." });
    expect(await screen.findByText(/isn't running or isn't signed in/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  test("installed and running: Turn on → remote.enable; then the URL, its QR and the note", async () => {
    let enabled = 0;
    await mount(READY, { "remote.enable": () => ((enabled += 1), { ...ON, note: "443 was already in use, so phone access uses port 8443." }) });
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(enabled).toBe(1));
    expect(await screen.findByText(URL_)).toBeTruthy();
    expect(screen.getByRole("img", { name: `QR code for ${URL_}` })).toBeTruthy();
    expect(screen.getByText(/443 was already in use/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy the phone address" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });

  test("a failed Turn on shows the message and stays off", async () => {
    await mount(READY, { "remote.enable": () => { throw new Error("tailscale serve failed"); } });
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect((await screen.findByText(/tailscale serve failed/)).closest("[role=alert]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
  });

  test("the address can be copied", async () => {
    const written = stubClipboard();
    await mount(ON);
    fireEvent.click(await screen.findByRole("button", { name: "Copy the phone address" }));
    await waitFor(() => expect(written).toEqual([URL_]));
  });

  test("Get a login code shows the 6 digits large with the minutes left", async () => {
    await mount(ON, { "login.issueCode": () => ({ code: "123456", expiresAt: Date.now() + 10 * 60_000 }) });
    fireEvent.click(await screen.findByRole("button", { name: "Get a login code" }));
    const code = await screen.findByText("123 456");
    expect(code.className).toContain("font-mono");
    expect(code.className).toContain("text-[28px]");
    expect(code.className).toContain("tracking-[0.2em]");
    expect(screen.getByText(/10 minutes left/)).toBeTruthy();
  });

  test("the login code also works with phone access off", async () => {
    await mount(NOT_INSTALLED, { "login.issueCode": () => ({ code: "654321", expiresAt: Date.now() + 60_000 }) });
    fireEvent.click(await screen.findByRole("button", { name: "Get a login code" }));
    expect(await screen.findByText("654 321")).toBeTruthy();
    expect(screen.getByText(/1 minute left/)).toBeTruthy();
  });

  test("Turn off asks first and explains phone-only devices are logged out", async () => {
    let off = 0;
    await mount(ON, { "remote.disable": () => ((off += 1), READY) });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(await screen.findByText(/only ever connected through Tailscale are logged out/)).toBeTruthy();
    expect(off).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Turn off phone access" }));
    await waitFor(() => expect(off).toBe(1));
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await settle();
  });

  test("Funnel is never offered", async () => {
    await mount(ON);
    await screen.findByText(URL_);
    const mentions = Array.from(document.body.querySelectorAll("*"))
      .filter((el) => el.children.length === 0 && /funnel/i.test(el.textContent ?? ""))
      .map((el) => el.textContent);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/never uses.*Funnel/i);
    expect(screen.queryByRole("button", { name: /funnel/i })).toBeNull();
  });
});
