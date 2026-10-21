import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import type { MessagesView } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, act } = await import("@testing-library/react");
const { MessagesPanel, MESSAGES_POLL_MS, MESSAGES_POLL_LIMIT } = await import("@/components/pages/settings/messages-panel");
const { MessagesStep } = await import("@/components/setup/remote-steps");

const ready = { helper: { installed: true, version: 1, current: 1 }, fullDiskAccess: "yes", automation: "yes", signedIn: "yes" } as const;
const OFF: MessagesView = { available: true, enabled: false };
const ON_NO_FDA: MessagesView = { available: true, enabled: true, status: { ...ready, fullDiskAccess: "no", automation: "unknown" } };
const ON_DONE: MessagesView = { available: true, enabled: true, status: ready };

beforeEach(() => stubMatchMedia());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const tick = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

describe("MessagesPanel", () => {
  test("is hidden where texts are unavailable", async () => {
    const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => ({ available: false, enabled: false }) });
    await waitFor(() => expect(socket.adminOf("messages.get").length).toBe(1));
    await act(async () => void (await Promise.resolve()));
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Texts")).toBeNull();
  });

  test("the switch turns texts on through messages.set", async () => {
    const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => OFF, "messages.set": () => ON_NO_FDA });
    expect(await screen.findByText(/Let Tropos read your texts and send the ones you approve\. Nothing is sent without showing you the text first\./)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Texts setup" })).toBeNull();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(socket.adminOf("messages.set").at(-1)?.params).toEqual({ enabled: true }));
    expect(await screen.findByRole("list", { name: "Texts setup" })).toBeTruthy();
  });

  test("Full Disk Access to do shows its button, which opens the pane", async () => {
    const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => ON_NO_FDA, "messages.openSettings": () => ({ ok: true }) });
    fireEvent.click(await screen.findByRole("button", { name: "Open Full Disk Access" }));
    await waitFor(() => expect(socket.adminOf("messages.openSettings").at(-1)?.params).toEqual({ pane: "fda" }));
  });

  test("Show helper in Finder sits next to Open Full Disk Access and reveals the helper", async () => {
    const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => ON_NO_FDA, "messages.revealHelper": () => ({ ok: true }) });
    fireEvent.click(await screen.findByRole("button", { name: "Show helper in Finder" }));
    await waitFor(() => expect(socket.adminOf("messages.revealHelper").length).toBe(1));
    cleanup();
    // Nothing to show before the helper exists, nor once Full Disk Access is on.
    await mountAdminPage(MessagesPanel, { "messages.get": () => ({ ...ON_NO_FDA, status: { ...ON_NO_FDA.status!, helper: { installed: false, current: 1 } } }) });
    await screen.findByRole("button", { name: "Open Full Disk Access" });
    expect(screen.queryByRole("button", { name: "Show helper in Finder" })).toBeNull();
    cleanup();
    await mountAdminPage(MessagesPanel, { "messages.get": () => ON_DONE });
    await screen.findByRole("switch");
    expect(screen.queryByRole("button", { name: "Show helper in Finder" })).toBeNull();
  });

  test("Test Messages access runs the probe and shows its result", async () => {
    let probed = false;
    const { socket } = await mountAdminPage(MessagesPanel, {
      "messages.get": () => ({ available: true, enabled: true, status: { ...ready, automation: probed ? "yes" : "unknown" } }),
      "messages.probe": () => {
        probed = true;
        return ON_DONE;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Test Messages access" }));
    await waitFor(() => expect(socket.adminOf("messages.probe").length).toBe(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Test Messages access" })).toBeNull());
  });

  test("says how many chats it can see once Full Disk Access is on", async () => {
    await mountAdminPage(MessagesPanel, { "messages.get": () => ({ ...ON_DONE, status: { ...ready, chats: 37 } }) });
    expect(await screen.findByText(/I can see 37 chats\./)).toBeTruthy();
  });

  test("no Messages history, or not signed in, is said plainly, and the test can be run again", async () => {
    await mountAdminPage(MessagesPanel, { "messages.get": () => ({ available: true, enabled: true, status: { ...ready, fullDiskAccess: "unknown", signedIn: "no", noHistory: true } }) });
    expect(await screen.findByText(/Messages has no history on this Mac yet\./)).toBeTruthy();
    cleanup();
    await mountAdminPage(MessagesPanel, { "messages.get": () => ({ available: true, enabled: true, status: { ...ready, signedIn: "no", services: [] } }) });
    expect(await screen.findByText(/Messages isn't signed in on this Mac/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test Messages access" })).toBeTruthy();
  });

  test("polls every 2 s while a step is to do and stops once all are done", async () => {
    jest.useFakeTimers();
    let answer: MessagesView = ON_NO_FDA;
    const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => answer });
    await screen.findByRole("button", { name: "Open Full Disk Access" });
    expect(socket.adminOf("messages.get").length).toBe(1);
    await tick(MESSAGES_POLL_MS);
    await waitFor(() => expect(socket.adminOf("messages.get").length).toBe(2));
    answer = ON_DONE;
    await tick(MESSAGES_POLL_MS);
    await waitFor(() => expect(socket.adminOf("messages.get").length).toBe(3));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open Full Disk Access" })).toBeNull());
    await tick(MESSAGES_POLL_MS * 5);
    expect(socket.adminOf("messages.get").length).toBe(3);
  });

  test("a newer helper than this release counts as ready", async () => {
    await mountAdminPage(MessagesPanel, { "messages.get": () => ({ ...ON_DONE, status: { ...ready, helper: { installed: true, version: 2, current: 1 } } }) });
    await screen.findByText("The Tropos Messages Helper is ready");
    expect(screen.getAllByText("done")).toHaveLength(3);
  });

  test("stops polling after 5 minutes, and Check again starts it once more", async () => {
    jest.useFakeTimers();
    const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => ON_NO_FDA });
    await screen.findByRole("button", { name: "Open Full Disk Access" });
    for (let i = 0; i < MESSAGES_POLL_LIMIT + 1; i++) await tick(MESSAGES_POLL_MS);
    const asked = socket.adminOf("messages.get").length;
    expect(asked).toBe(1 + MESSAGES_POLL_LIMIT);
    await tick(MESSAGES_POLL_MS * 5);
    expect(socket.adminOf("messages.get").length).toBe(asked);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await tick(MESSAGES_POLL_MS);
    await waitFor(() => expect(socket.adminOf("messages.get").length).toBe(asked + 1));
  });

  test("does not poll while the page is hidden", async () => {
    jest.useFakeTimers();
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => ON_NO_FDA });
      await screen.findByRole("button", { name: "Open Full Disk Access" });
      await tick(MESSAGES_POLL_MS * 5);
      expect(socket.adminOf("messages.get").length).toBe(1);
    } finally {
      delete (document as { hidden?: boolean }).hidden;
      if (hidden) Object.defineProperty(Document.prototype, "hidden", hidden);
    }
  });

  test("does not poll while only the Messages-control step is to do", async () => {
    jest.useFakeTimers();
    const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => ({ available: true, enabled: true, status: { ...ready, automation: "unknown" } }) });
    await screen.findByRole("button", { name: "Test Messages access" });
    await tick(MESSAGES_POLL_MS * 5);
    expect(socket.adminOf("messages.get").length).toBe(1);
  });

  test("leaves no timer behind on unmount", async () => {
    jest.useFakeTimers();
    const { socket } = await mountAdminPage(MessagesPanel, { "messages.get": () => ON_NO_FDA });
    await screen.findByRole("button", { name: "Open Full Disk Access" });
    cleanup();
    await tick(MESSAGES_POLL_MS * 5);
    expect(socket.adminOf("messages.get").length).toBe(1);
  });
});

describe("MessagesStep", () => {
  test("off macOS it says so and Next still works", async () => {
    const seen: string[] = [];
    const Step = () => createElement(MessagesStep, { onChanged: () => void seen.push("changed"), onNext: () => void seen.push("next"), onSkip: () => void seen.push("skip") });
    await mountAdminPage(Step, { "messages.get": () => ({ available: false, enabled: false }) });
    expect(await screen.findByText("Texts are only available on macOS.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(seen).toEqual(["next"]);
  });

  test("wraps the card with Next and Skip", async () => {
    const seen: string[] = [];
    const Step = () => createElement(MessagesStep, { onChanged: () => void seen.push("changed"), onNext: () => void seen.push("next"), onSkip: () => void seen.push("skip") });
    await mountAdminPage(Step, { "messages.get": () => OFF });
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "Skip texts" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(seen).toEqual(["skip", "changed", "next"]);
  });
});
