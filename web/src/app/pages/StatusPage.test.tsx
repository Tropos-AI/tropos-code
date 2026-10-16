import { afterEach, describe, expect, test } from "bun:test";

import type { DoctorReport, StatusSnapshot } from "@core/web/admin/api";

import { mountAdmin } from "@/components/admin/admin-test-kit";
import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { StatusPage, groupByArea } = await import("@/app/pages/StatusPage");

const STATUS: StatusSnapshot = {
  version: "0.4.0",
  channel: "latest",
  updateAvailable: "0.5.0",
  service: { manager: "launchd", installed: true, running: true, pid: 321 },
  gateway: { running: true, pid: 322, startedAt: "2026-10-15T08:00:00Z", telegram: true, webPort: 4317 },
  providers: [
    { id: "anthropic", name: "Anthropic", connected: true },
    { id: "openai", name: "OpenAI", connected: false },
  ],
  docker: { ok: false, problem: "Docker daemon is not running" },
  projects: { count: 2, defaultId: "default" },
  pairedSenders: 3,
  cronJobs: 4,
  health: { ok: 3, warn: 1, error: 1 },
  needsOnboarding: false,
};

const REPORT: DoctorReport = {
  findings: [
    { id: "path.rc", area: "Install", level: "warn", message: "PATH block is missing", detail: "~/.zshrc", fixable: true },
    { id: "docker.up", area: "Sandbox", level: "error", message: "Docker is not reachable" },
    { id: "cfg.ok", area: "Install", level: "ok", message: "Config is valid" },
  ],
  summary: { ok: 1, info: 0, warn: 1, error: 1, fixed: 0 },
};

afterEach(() => cleanup());

describe("groupByArea", () => {
  test("keeps the order areas first appear in", () => {
    expect(groupByArea(REPORT.findings).map((g) => [g.area, g.findings.length])).toEqual([
      ["Install", 2],
      ["Sandbox", 1],
    ]);
  });
});

describe("StatusPage", () => {
  test("shows the overview cards and the findings grouped by area", async () => {
    stubMatchMedia();
    await mountAdmin(StatusPage, { "status.get": () => STATUS, "doctor.run": () => REPORT });
    await screen.findByText("v0.4.0");
    expect(screen.getByText("Update available: v0.5.0")).toBeTruthy();
    expect(screen.getByText("pid 321", { exact: false })).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("Docker daemon is not running")).toBeTruthy();
    const install = await screen.findByRole("region", { name: "Install" });
    expect(within(install).getByText("PATH block is missing")).toBeTruthy();
    expect(within(install).getAllByText("Warning:").length).toBe(1);
    expect(screen.getByRole("region", { name: "Sandbox" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open setup" })).toBeNull();
  });

  test("points to setup when onboarding is needed", async () => {
    stubMatchMedia();
    await mountAdmin(StatusPage, { "status.get": () => ({ ...STATUS, needsOnboarding: true }), "doctor.run": () => REPORT });
    const link = await screen.findByRole("link", { name: /Open setup/ });
    expect(link.getAttribute("href")).toBe("#/setup");
  });

  test("a Fix button runs doctor.fix and then reloads the findings", async () => {
    stubMatchMedia();
    let fixed = false;
    const { socket } = await mountAdmin(StatusPage, {
      "status.get": () => STATUS,
      "doctor.run": () => (fixed ? { findings: [{ ...REPORT.findings[0]!, level: "ok", fixable: false, fixed: true }], summary: { ok: 1, info: 0, warn: 0, error: 0, fixed: 1 } } : REPORT),
      "doctor.fix": () => {
        fixed = true;
        return { ok: true, message: "Added the PATH block to ~/.zshrc" };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Fix: PATH block is missing" }));
    await screen.findByText("Added the PATH block to ~/.zshrc");
    expect(socket.callsOf("doctor.fix")[0]!.params).toEqual({ id: "path.rc" });
    await screen.findByText("Fixed");
    expect(screen.queryByRole("button", { name: /^Fix:/ })).toBeNull();
  });

  test("Run checks, deep checks and Fix all safe issues pass their options", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(StatusPage, { "status.get": () => STATUS, "doctor.run": () => REPORT });
    await screen.findByText("PATH block is missing");
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    await waitFor(() => expect(socket.callsOf("doctor.run").length).toBe(2));
    await screen.findByText(/Checks finished: 1 ok, 0 info, 1 warning, 1 error\./);
    fireEvent.click(screen.getByRole("button", { name: "Run deep checks" }));
    await waitFor(() => expect(socket.callsOf("doctor.run").length).toBe(3));
    fireEvent.click(screen.getByRole("button", { name: "Fix all safe issues" }));
    await waitFor(() => expect(socket.callsOf("doctor.run").length).toBe(4));
    expect(socket.callsOf("doctor.run").slice(1).map((c) => c.params)).toEqual([undefined, { deep: true }, { fix: true }]);
  });

  test("a failing status shows a calm error with Retry that loads again", async () => {
    stubMatchMedia();
    let fail = true;
    await mountAdmin(StatusPage, {
      "status.get": () => {
        if (fail) throw new Error("Not available in the demo.");
        return STATUS;
      },
      "doctor.run": () => REPORT,
    });
    await screen.findByText("Not available in the demo.");
    expect(screen.getByText("Couldn't load status")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("v0.4.0");
  });
});
