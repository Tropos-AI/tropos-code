import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ProactivePatch, ProactiveView } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { SuggestionsPanel } = await import("@/components/pages/settings/suggestions-panel");

const VIEW: ProactiveView = { enabled: true, explicit: false, telegram: true, activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1, newProjectsDir: "/home/me/Projects" };
const apply = (p: ProactivePatch): ProactiveView => ({ ...VIEW, ...p, enabled: p.enabled ?? VIEW.enabled, explicit: p.enabled !== null && p.enabled !== undefined, activeHours: p.activeHours ?? VIEW.activeHours, newProjectsDir: p.newProjectsDir ?? VIEW.newProjectsDir });

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("SuggestionsPanel", () => {
  test("shows the settings and saves only what changed", async () => {
    const { socket } = await mountAdminPage(SuggestionsPanel, { "proactive.get": () => VIEW, "proactive.set": (p) => apply(p) });
    const toggle = await screen.findByRole("switch", { name: "Message me on Telegram when something needs me" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/On by default once Telegram is connected/)).toBeTruthy();
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("09:00");
    expect((screen.getByLabelText("Check every") as HTMLSelectElement).value).toBe("4");
    expect((screen.getByLabelText("At most per day") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("New projects folder") as HTMLInputElement).value).toBe("/home/me/Projects");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(socket.adminCalls.at(-1)).toEqual({ method: "proactive.set", params: { enabled: false } }));
  });

  test("other fields are sent when they change", async () => {
    const { socket } = await mountAdminPage(SuggestionsPanel, { "proactive.get": () => VIEW, "proactive.set": (p) => apply(p) });
    await screen.findByRole("switch");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "08:30" } });
    fireEvent.change(screen.getByLabelText("At most per day"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("New projects folder"), { target: { value: "/work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(socket.adminCalls.at(-1)).toEqual({ method: "proactive.set", params: { activeHours: { start: "08:30", end: "21:00" }, maxPerDay: 2, newProjectsDir: "/work" } }),
    );
  });

  test("an invalid value shows the server's message", async () => {
    await mountAdminPage(SuggestionsPanel, {
      "proactive.get": () => VIEW,
      "proactive.set": () => {
        throw new Error("proactive.activeHours.start: a time like 09:00");
      },
    });
    await screen.findByRole("switch");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "08:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("proactive.activeHours.start: a time like 09:00");
  });

  test("without Telegram the switch is disabled and says why", async () => {
    await mountAdminPage(SuggestionsPanel, { "proactive.get": () => ({ ...VIEW, telegram: false, enabled: false }) });
    const toggle = await screen.findByRole("switch", { name: "Message me on Telegram when something needs me" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Connect Telegram first\./)).toBeTruthy();
  });

  test("Use the default sends null for enabled", async () => {
    const { socket } = await mountAdminPage(SuggestionsPanel, { "proactive.get": () => ({ ...VIEW, enabled: false, explicit: true }), "proactive.set": (p) => apply(p) });
    fireEvent.click(await screen.findByRole("button", { name: "Use the default" }));
    await waitFor(() => expect(socket.adminCalls.at(-1)).toEqual({ method: "proactive.set", params: { enabled: null } }));
  });
});
