import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PairingView, TelegramInfo } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { ChannelsPanel } = await import("@/app/pages/ChannelsPage");

const has = (selector: string): boolean => document.querySelector(selector) !== null;
const TOKEN = "123456:SECRET-TOKEN-abcdef";

const BOT = { username: "tropos_bot", name: "Tropos" };
const PAIRING: PairingView = {
  approved: [{ channel: "telegram", senderId: "4242", approvedAt: Date.parse("2026-10-14T09:00:00Z") }],
  pending: [{ channel: "telegram", requestedAt: Date.now() - 4 * 60_000, expiresAt: Date.now() + 56 * 60_000 }],
};

function handlers(overrides: Record<string, (params: never) => unknown> = {}) {
  let telegram: TelegramInfo = { configured: true, source: "file", bot: BOT };
  let pairing = PAIRING;
  return {
    state: {
      get telegram() {
        return telegram;
      },
    },
    handlers: {
      "channels.get": () => ({ telegram }),
      "channels.telegram.set": () => {
        telegram = { configured: true, source: "file", bot: BOT };
        return telegram;
      },
      "channels.telegram.clear": () => {
        telegram = { configured: false, source: null };
        return telegram;
      },
      "channels.telegram.test": () => ({ ok: true, bot: BOT }),
      "pairing.list": () => pairing,
      "pairing.approve": () => {
        pairing = { ...pairing, approved: [...pairing.approved, { channel: "telegram", senderId: "777", approvedAt: Date.now() }] };
        return { senderId: "777" };
      },
      "pairing.revoke": () => {
        pairing = { ...pairing, approved: [] };
        return { removed: true };
      },
      ...overrides,
    } as never,
  };
}

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("ChannelsPanel", () => {
  test("shows the bot, the token source and never a token", async () => {
    const { handlers: h } = handlers();
    await mountAdminPage(ChannelsPanel, h);
    expect(await screen.findByText("@tropos_bot")).toBeTruthy();
    expect(document.body.textContent).toContain("token from gateway.json");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
    expect(has('input[type="password"]')).toBe(false);
    expect(screen.getByText("How it works")).toBeTruthy();
    expect(document.body.textContent).toContain("Commands run in Docker.");
  });

  test("Test connection reports the result", async () => {
    const { handlers: h } = handlers({ "channels.telegram.test": () => ({ ok: false, error: "Unauthorized" }) });
    await mountAdminPage(ChannelsPanel, h);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect((await screen.findByText("Unauthorized")).closest('[role="alert"]')).toBeTruthy();
  });

  test("replacing the token sends it once and clears the field", async () => {
    const { handlers: h } = handlers();
    const { socket } = await mountAdminPage(ChannelsPanel, h);
    fireEvent.click(await screen.findByRole("button", { name: "Replace token" }));
    const field = (await screen.findByLabelText("Bot token")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and replace" }));
    await waitFor(() => expect(socket.adminOf("channels.telegram.set")[0]?.params).toEqual({ token: TOKEN }));
    await waitFor(() => expect(has('input[type="password"]')).toBe(false));
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  test("a rejected token shows the reason without echoing the token", async () => {
    const { handlers: h } = handlers({
      "channels.get": () => ({ telegram: { configured: false, source: null } }),
      "channels.telegram.set": () => Promise.reject(new Error(`Telegram refused ${TOKEN}`)),
    });
    await mountAdminPage(ChannelsPanel, h);
    expect(await screen.findByText("not configured")).toBeTruthy();
    expect(document.body.textContent).toContain("@BotFather");
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    const alert = await screen.findByText(/Couldn't save the token/);
    expect(alert.textContent).toContain("Telegram refused");
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  test("an environment token cannot be removed from here", async () => {
    const { handlers: h } = handlers({ "channels.get": () => ({ telegram: { configured: true, source: "env", bot: BOT } }) });
    await mountAdminPage(ChannelsPanel, h);
    await screen.findByText("@tropos_bot");
    expect(document.body.textContent).toContain("TROPOS_TELEGRAM_BOT_TOKEN");
    expect(has('button[aria-label="Remove token"]') || [...document.querySelectorAll("button")].some((b) => b.textContent === "Remove token")).toBe(false);
  });

  test("Remove token asks first", async () => {
    const { handlers: h } = handlers();
    const { socket } = await mountAdminPage(ChannelsPanel, h);
    fireEvent.click(await screen.findByRole("button", { name: "Remove token" }));
    const dialog = await screen.findByRole("dialog");
    expect(socket.adminOf("channels.telegram.clear")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove token" }));
    await waitFor(() => expect(socket.adminOf("channels.telegram.clear")).toHaveLength(1));
    expect(await screen.findByText("not configured")).toBeTruthy();
  });

  test("lists approved and pending senders; revoke confirms", async () => {
    const { handlers: h } = handlers();
    const { socket } = await mountAdminPage(ChannelsPanel, h);
    const approved = await screen.findByRole("list", { name: "Approved senders" });
    expect(approved.textContent).toContain("4242");
    expect(screen.getByRole("list", { name: "Pending requests" }).textContent).toContain("expires in");
    fireEvent.click(screen.getByRole("button", { name: "Revoke 4242" }));
    const dialog = await screen.findByRole("dialog");
    expect(socket.adminOf("pairing.revoke")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(socket.adminOf("pairing.revoke")[0]?.params).toEqual({ channel: "telegram", senderId: "4242" }));
    expect(await screen.findByText(/Nobody is approved yet/)).toBeTruthy();
  });

  test("Approve a code posts it and announces the sender", async () => {
    const { handlers: h } = handlers();
    const { socket } = await mountAdminPage(ChannelsPanel, h);
    fireEvent.change(await screen.findByLabelText("Pairing code"), { target: { value: " K7Q2-9XMA " } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(socket.adminOf("pairing.approve")[0]?.params).toEqual({ channel: "telegram", code: "K7Q2-9XMA" }));
    expect(await screen.findByText(/Approved sender 777/)).toBeTruthy();
  });

  test("a wrong code shows the server's reason", async () => {
    const { handlers: h } = handlers({ "pairing.approve": () => Promise.reject(new Error("That code is wrong or has expired.")) });
    await mountAdminPage(ChannelsPanel, h);
    fireEvent.change(await screen.findByLabelText("Pairing code"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/wrong or has expired/)).toBeTruthy();
  });

  test("calm error states with retry when the admin API is unavailable", async () => {
    await mountAdminPage(ChannelsPanel, {
      "channels.get": () => Promise.reject(new Error("Not available in the demo.")),
      "pairing.list": () => Promise.reject(new Error("not connected")),
    });
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("Not available in the demo.");
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBe(3);
  });

  test("the Access card marks the owner and the panel lists logged-in devices", async () => {
    const h = handlers({
      "pairing.list": () => ({ ...PAIRING, owner: { channel: "telegram", senderId: "4242" } }),
      "devices.list": () => [{ id: "d1", name: "Chrome on macOS", createdAt: 1, lastSeen: Date.now(), via: "local", current: true }],
    });
    await mountAdminPage(ChannelsPanel, h.handlers);
    const approved = await screen.findByRole("list", { name: "Approved senders" });
    expect(within(approved).getByText("Owner")).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Devices" })).toBeTruthy();
    expect(screen.getByText("Chrome on macOS")).toBeTruthy();
  });
});
