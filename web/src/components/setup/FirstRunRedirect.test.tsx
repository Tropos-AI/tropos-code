import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, act } = await import("@testing-library/react");
const { FirstRunRedirect, FIRST_RUN_DISMISSED_KEY } = await import("@/components/setup/FirstRunRedirect");

const status = (needsOnboarding: boolean) => () => ({ needsOnboarding });

beforeEach(() => {
  stubMatchMedia();
  window.sessionStorage.clear();
  window.location.hash = "#/chat";
});
afterEach(() => cleanup());

describe("FirstRunRedirect", () => {
  test("shows a card linking to #/setup when onboarding is needed, without navigating", async () => {
    const { socket } = await mountAdminPage(FirstRunRedirect, { "status.get": status(true) });
    const card = await screen.findByLabelText("Finish setting up");
    expect(card.textContent).toContain("Finish setting up Tropos");
    expect(screen.getByRole("link", { name: /Open setup/ }).getAttribute("href")).toBe("#/setup");
    expect(window.location.hash).toBe("#/chat");
    expect(socket.adminOf("status.get")).toHaveLength(1);
  });

  test("renders nothing when setup is done", async () => {
    const { socket } = await mountAdminPage(FirstRunRedirect, { "status.get": status(false) });
    await waitFor(() => expect(socket.adminOf("status.get")).toHaveLength(1));
    expect(screen.queryByLabelText("Finish setting up")).toBeNull();
  });

  test("stays quiet when the admin API is unavailable", async () => {
    const { socket } = await mountAdminPage(FirstRunRedirect, { "status.get": () => Promise.reject(new Error("Not available in the demo.")) });
    await waitFor(() => expect(socket.adminOf("status.get")).toHaveLength(1));
    expect(screen.queryByLabelText("Finish setting up")).toBeNull();
  });

  test("dismissing hides it for the session and is remembered", async () => {
    await mountAdminPage(FirstRunRedirect, { "status.get": status(true) });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss setup reminder" }));
    await waitFor(() => expect(screen.queryByLabelText("Finish setting up")).toBeNull());
    expect(window.sessionStorage.getItem(FIRST_RUN_DISMISSED_KEY)).toBe("1");
  });

  test("a dismissed session does not even ask", async () => {
    window.sessionStorage.setItem(FIRST_RUN_DISMISSED_KEY, "1");
    const { socket } = await mountAdminPage(FirstRunRedirect, { "status.get": status(true) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(socket.adminOf("status.get")).toHaveLength(0);
    expect(screen.queryByLabelText("Finish setting up")).toBeNull();
  });

  test("hides while the setup page is open", async () => {
    window.location.hash = "#/setup";
    await mountAdminPage(FirstRunRedirect, { "status.get": status(true) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByLabelText("Finish setting up")).toBeNull();
  });
});
