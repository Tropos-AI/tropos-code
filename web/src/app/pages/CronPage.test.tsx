import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CronJobView } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { CronPage, statusTone } = await import("@/app/pages/CronPage");

const has = (selector: string): boolean => document.querySelector(selector) !== null;

const JOB: CronJobView = {
  id: "j1",
  name: "Morning PRs",
  schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Athens" },
  scheduleText: "weekdays at 09:00",
  prompt: "Check my open pull requests.",
  project: "default",
  deliver: "telegram:4242",
  enabled: true,
  nextRunAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  lastRunAt: new Date(Date.now() - 20 * 3_600_000).toISOString(),
  lastStatus: "ok",
  createdBy: "user",
};
const FAILING: CronJobView = { ...JOB, id: "j2", name: "Disk check", schedule: { kind: "every", ms: 900_000 }, scheduleText: "every 15 minutes", deliver: "none", enabled: false, lastStatus: "error", createdBy: "agent", nextRunAt: undefined };

const PROJECTS = [
  { id: "default", name: "workspace", path: "/w", builtin: true, isDefault: true, gitRepo: true },
  { id: "app", name: "my-app", path: "/a", isDefault: false, gitRepo: true },
];
const PAIRING = { approved: [{ channel: "telegram", senderId: "4242", approvedAt: 1 }], pending: [] };

function base(over: Record<string, (p: never) => unknown> = {}) {
  let jobs = [JOB, FAILING];
  const handlers = {
    "cron.list": () => jobs,
    "projects.list": () => PROJECTS,
    "pairing.list": () => PAIRING,
    "cron.setEnabled": (p: { id: string; enabled: boolean }) => {
      jobs = jobs.map((j) => (j.id === p.id ? { ...j, enabled: p.enabled } : j));
      return jobs.find((j) => j.id === p.id);
    },
    "cron.runNow": () => ({ started: true }),
    "cron.remove": (p: { id: string }) => {
      jobs = jobs.filter((j) => j.id !== p.id);
      return { removed: true };
    },
    "cron.add": (p: { name: string }) => {
      jobs = [...jobs, { ...JOB, id: "j3", name: p.name }];
      return jobs.at(-1);
    },
    "cron.update": (p: { id: string; patch: { name?: string } }) => {
      jobs = jobs.map((j) => (j.id === p.id ? { ...j, ...p.patch, schedule: j.schedule } : j));
      return jobs.find((j) => j.id === p.id);
    },
    "cron.runs": () => [
      { runId: "r1", startedAt: "2026-10-14T09:00:00Z", endedAt: "2026-10-14T09:00:42Z", status: "ok", summary: "Two PRs need review." },
      { runId: "r2", startedAt: "2026-10-13T09:00:00Z", status: "error", summary: "", error: "sandbox unavailable" },
    ],
    ...over,
  };
  return handlers as never;
}

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("statusTone", () => {
  test("maps statuses to badge tones", () => {
    expect(statusTone("ok")).toBe("ok");
    expect(statusTone("error")).toBe("error");
    expect(statusTone("running")).toBe("accent");
    expect(statusTone(undefined)).toBe("off");
  });
});

describe("CronPage", () => {
  test("lists jobs with readable schedule, status, project and delivery", async () => {
    await mountAdminPage(CronPage, base());
    const list = await screen.findByRole("list", { name: "Scheduled jobs" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first!.textContent).toContain("weekdays at 09:00");
    expect(first!.textContent).toContain("workspace");
    expect(first!.textContent).toContain("telegram:4242");
    expect(first!.textContent).toContain("ok");
    expect(second!.textContent).toContain("made by the agent");
    expect(second!.textContent).toContain("history only");
    expect(within(second!).getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  test("empty state explains that the agent can create jobs", async () => {
    await mountAdminPage(CronPage, { "cron.list": () => [], "projects.list": () => [], "pairing.list": () => PAIRING } as never);
    expect(await screen.findByText("No scheduled jobs")).toBeTruthy();
    expect(document.body.textContent).toContain("ask the agent in a chat");
  });

  test("error state is calm and retries", async () => {
    let fail = true;
    await mountAdminPage(CronPage, { "cron.list": () => (fail ? Promise.reject(new Error("Not available in the demo.")) : [JOB]), "projects.list": () => PROJECTS, "pairing.list": () => PAIRING } as never);
    expect((await screen.findByRole("alert")).textContent).toContain("Not available in the demo.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Scheduled jobs" })).toBeTruthy();
  });

  test("the switch pauses a job through cron.setEnabled", async () => {
    const { socket } = await mountAdminPage(CronPage, base());
    fireEvent.click(await screen.findByRole("switch", { name: "Pause Morning PRs" }));
    await waitFor(() => expect(socket.adminOf("cron.setEnabled")[0]?.params).toEqual({ id: "j1", enabled: false }));
    await waitFor(() => expect(has('[role="switch"][aria-label="Enable Morning PRs"]')).toBe(true));
  });

  test("Run now starts the job; with the gateway down it shows the reason calmly", async () => {
    const { socket } = await mountAdminPage(CronPage, base());
    fireEvent.click(await screen.findByRole("button", { name: "Run Morning PRs now" }));
    expect(await screen.findByText(/Started\./)).toBeTruthy();
    expect(socket.adminOf("cron.runNow")[0]?.params).toEqual({ id: "j1" });
    cleanup();
    await mountAdminPage(CronPage, base({ "cron.runNow": () => Promise.reject(new Error("The gateway is not running.")) }));
    fireEvent.click(await screen.findByRole("button", { name: "Run Morning PRs now" }));
    const note = await screen.findByText(/The gateway is not running\./);
    expect(note.textContent).toContain("Status page");
  });

  test("Delete asks first", async () => {
    const { socket } = await mountAdminPage(CronPage, base());
    fireEvent.click(await screen.findByRole("button", { name: "Delete Disk check" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Disk check?" });
    expect(socket.adminOf("cron.remove")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(socket.adminOf("cron.remove")[0]?.params).toEqual({ id: "j2" }));
    await waitFor(() => expect(has('[aria-label="Delete Disk check"]')).toBe(false));
  });

  test("New job: presets, validation and cron.add", async () => {
    const { socket } = await mountAdminPage(CronPage, base());
    fireEvent.click(await screen.findByRole("button", { name: "New job" }));
    const dialog = await screen.findByRole("dialog", { name: "New scheduled job" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create job" }));
    expect((await within(dialog).findByText("Give the job a name.")).closest('[role="alert"]')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Nightly" } });
    fireEvent.change(within(dialog).getByLabelText("What should the agent do?"), { target: { value: "Summarise today." } });
    fireEvent.change(within(dialog).getByLabelText("Repeat"), { target: { value: "weekdays" } });
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "18:30" } });
    fireEvent.change(within(dialog).getByLabelText("Project"), { target: { value: "app" } });
    fireEvent.change(within(dialog).getByLabelText("Send the result to"), { target: { value: "telegram:4242" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create job" }));
    await waitFor(() => expect(socket.adminOf("cron.add")).toHaveLength(1));
    const params = socket.adminOf("cron.add")[0]!.params as Record<string, unknown>;
    expect(params).toMatchObject({ name: "Nightly", prompt: "Summarise today.", schedule: "30 18 * * 1-5", project: "app", deliver: "telegram:4242" });
    expect(typeof params.tz).toBe("string");
    await waitFor(() => expect(has('[aria-label="Close dialog"]')).toBe(false));
    expect(await screen.findByText("Nightly")).toBeTruthy();
  });

  test("custom schedules and a typed chat go through; server errors stay in the dialog", async () => {
    const { socket } = await mountAdminPage(CronPage, base({ "cron.add": () => Promise.reject(new Error("Invalid schedule: every 0m")) }));
    fireEvent.click(await screen.findByRole("button", { name: "New job" }));
    const dialog = await screen.findByRole("dialog", { name: "New scheduled job" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Poll" } });
    fireEvent.change(within(dialog).getByLabelText("What should the agent do?"), { target: { value: "Ping." } });
    fireEvent.change(within(dialog).getByLabelText("Repeat"), { target: { value: "custom" } });
    fireEvent.change(within(dialog).getByLabelText("Custom schedule"), { target: { value: "every 0m" } });
    fireEvent.change(within(dialog).getByLabelText("Send the result to"), { target: { value: "__custom__" } });
    fireEvent.change(within(dialog).getByLabelText("Chat"), { target: { value: "telegram:99" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create job" }));
    expect((await within(dialog).findByText(/Invalid schedule/)).closest('[role="alert"]')).toBeTruthy();
    expect(socket.adminOf("cron.add")[0]!.params).toMatchObject({ schedule: "every 0m", deliver: "telegram:99" });
    expect((socket.adminOf("cron.add")[0]!.params as Record<string, unknown>).tz).toBeUndefined();
  });

  test("Edit opens on the job's own preset and saves with cron.update", async () => {
    const { socket } = await mountAdminPage(CronPage, base());
    fireEvent.click(await screen.findByRole("button", { name: "Edit Morning PRs" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Morning PRs" });
    expect((within(dialog).getByLabelText("Repeat") as HTMLSelectElement).value).toBe("weekdays");
    expect((within(dialog).getByLabelText("Time") as HTMLInputElement).value).toBe("09:00");
    expect((within(dialog).getByLabelText("Time zone") as HTMLSelectElement).value).toBe("Europe/Athens");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Morning reviews" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(socket.adminOf("cron.update")).toHaveLength(1));
    expect(socket.adminOf("cron.update")[0]!.params).toMatchObject({ id: "j1", patch: { name: "Morning reviews", schedule: "0 9 * * 1-5", tz: "Europe/Athens" } });
  });

  test("the runs drawer lists past runs", async () => {
    const { socket } = await mountAdminPage(CronPage, base());
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Show runs of Morning PRs" }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const runs = await screen.findByRole("list", { name: "Runs" });
    expect(runs.textContent).toContain("Two PRs need review.");
    expect(runs.textContent).toContain("sandbox unavailable");
    expect(socket.adminOf("cron.runs")[0]?.params).toEqual({ id: "j1", limit: 20 });
  });

  test("falls back to a text field for delivery when nobody is paired", async () => {
    await mountAdminPage(CronPage, base({ "pairing.list": () => ({ approved: [], pending: [] }) }));
    fireEvent.click(await screen.findByRole("button", { name: "New job" }));
    const dialog = await screen.findByRole("dialog", { name: "New scheduled job" });
    const select = within(dialog).getByLabelText("Send the result to") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["none", "__custom__"]);
  });
});
