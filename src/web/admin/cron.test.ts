import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FilePairing } from "../../gateway/pairing";
import { CronStore } from "../../gateway/cron/store";
import { cronHandlers, scheduleText } from "./cron";
import { adminOverWs, makeKit, writeText, type Kit } from "./ops-testkit";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.cleanup());

const base = { name: "Morning", schedule: "every day at 09:00", prompt: "summarise the news" };

test("add parses text schedules and returns a readable view", async () => {
  const h = cronHandlers(kit.ctx);
  const job = await h["cron.add"]!({ ...base, tz: "Europe/Athens" });
  expect(job).toMatchObject({ name: "Morning", scheduleText: "every day at 09:00 (Europe/Athens)", project: "default", deliver: "none", enabled: true, createdBy: "user" });
  expect(job.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "Europe/Athens" });
  expect(Date.parse(job.nextRunAt!)).toBeGreaterThan(kit.clock.now);
  expect(await h["cron.list"]!(undefined)).toEqual([job]);
  expect(new CronStore(kit.home).list()).toHaveLength(1);
});

test("add accepts a structured schedule and refuses under a minute", async () => {
  const h = cronHandlers(kit.ctx);
  const ok = await h["cron.add"]!({ ...base, schedule: { kind: "every", ms: 120_000 } });
  expect(ok.scheduleText).toBe("every 2 minutes");
  await expect(h["cron.add"]!({ ...base, schedule: { kind: "every", ms: 30_000 } })).rejects.toThrow(/at least 1 minute/);
  await expect(h["cron.add"]!({ ...base, schedule: "every 30s" })).rejects.toThrow(/at least 1 minute/);
  await expect(h["cron.add"]!({ ...base, schedule: "whenever" })).rejects.toThrow(/can't read schedule/);
  await expect(h["cron.add"]!({ ...base, schedule: "0 9 * * *", tz: "Not/AZone" })).rejects.toThrow(/time zone/);
});

test("add validates name, prompt, project and deliver", async () => {
  const h = cronHandlers(kit.ctx);
  await expect(h["cron.add"]!({ ...base, name: "  " })).rejects.toThrow(/name/);
  await expect(h["cron.add"]!({ ...base, prompt: "" })).rejects.toThrow(/prompt/);
  await expect(h["cron.add"]!({ ...base, project: "nope" })).rejects.toThrow(/no project/);
  await expect(h["cron.add"]!({ ...base, deliver: "everyone" })).rejects.toThrow(/Deliver/);
  const j = await h["cron.add"]!({ ...base, deliver: "telegram:123" });
  expect(j.deliver).toBe("telegram:123");
});

test("update changes fields and recomputes the next run when the schedule changes", async () => {
  const h = cronHandlers(kit.ctx);
  const job = await h["cron.add"]!(base);
  const up = await h["cron.update"]!({ id: job.id, patch: { name: "Evening", schedule: "every 10m" } });
  expect(up).toMatchObject({ name: "Evening", scheduleText: "every 10 minutes" });
  expect(Date.parse(up.nextRunAt!)).toBe(kit.clock.now + 600_000);
  await expect(h["cron.update"]!({ id: "zzzz", patch: {} })).rejects.toThrow(/no such job/);
});

test("setEnabled hides nextRunAt while paused; remove deletes", async () => {
  const h = cronHandlers(kit.ctx);
  const job = await h["cron.add"]!(base);
  const off = await h["cron.setEnabled"]!({ id: job.id, enabled: false });
  expect(off.enabled).toBe(false);
  expect(off.nextRunAt).toBeUndefined();
  expect((await h["cron.setEnabled"]!({ id: job.id, enabled: true })).nextRunAt).toBeDefined();
  expect(await h["cron.remove"]!({ id: job.id })).toEqual({ removed: true });
  expect(await h["cron.list"]!(undefined)).toEqual([]);
});

test("runNow without a gateway explains how to start it", async () => {
  const h = cronHandlers(kit.ctx);
  const job = await h["cron.add"]!(base);
  await expect(h["cron.runNow"]!({ id: job.id })).rejects.toThrow("The gateway isn't running, so the job will run at its next scheduled time. Start it with `tcode gateway`.");
});

test("runNow goes through the gateway; an immediate refusal is reported", async () => {
  const calls: string[] = [];
  const h = cronHandlers({ ...kit.ctx, gateway: { runCronNow: async (id) => void calls.push(id), reload: async () => {} } });
  const job = await h["cron.add"]!(base);
  expect(await h["cron.runNow"]!({ id: job.id })).toEqual({ started: true });
  expect(calls).toEqual([job.id]);
  const busy = cronHandlers({ ...kit.ctx, gateway: { runCronNow: async () => Promise.reject(new Error('"Morning" is already running')), reload: async () => {} } });
  await expect(busy["cron.runNow"]!({ id: job.id })).rejects.toThrow(/already running/);
  // A long run does not hold the call open.
  const slow = cronHandlers({ ...kit.ctx, gateway: { runCronNow: () => new Promise(() => {}), reload: async () => {} } });
  expect(await slow["cron.runNow"]!({ id: job.id })).toEqual({ started: true });
});

test("runs are newest first with ISO times", async () => {
  const h = cronHandlers(kit.ctx);
  const job = await h["cron.add"]!(base);
  const store = new CronStore(kit.home);
  for (const [i, status] of (["ok", "error"] as const).entries()) {
    store.appendRun({ jobId: job.id, runId: `r${i}`, startedAt: 1_000_000 * (i + 1), endedAt: 1_000_000 * (i + 1) + 5, status, summary: `s${i}`, ...(status === "error" ? { error: "boom" } : {}) });
  }
  const runs = await h["cron.runs"]!({ id: job.id, limit: 5 });
  expect(runs.map((r) => r.runId)).toEqual(["r1", "r0"]);
  expect(runs[0]).toMatchObject({ status: "error", error: "boom", startedAt: new Date(2_000_000).toISOString() });
});

test("scheduleText reads the common shapes", () => {
  expect(scheduleText({ kind: "cron", expr: "30 9 * * 1-5" })).toBe("every weekday at 09:30");
  expect(scheduleText({ kind: "cron", expr: "0 8 * * 1" })).toBe("every Monday at 08:00");
  expect(scheduleText({ kind: "cron", expr: "*/5 * * * *" })).toBe("cron */5 * * * *");
  expect(scheduleText({ kind: "every", ms: 3_600_000 })).toBe("every hour");
});

test("end to end over the WebSocket", async () => {
  await writeText(join(kit.home, "gateway.json"), "{}\n");
  const ws = await adminOverWs(kit.ctx, cronHandlers(kit.ctx));
  try {
    const added = await ws.call("cron.add", base);
    expect(added).toMatchObject({ ok: true, result: { name: "Morning" } });
    const id = (added.result as { id: string }).id;
    expect(await ws.call("cron.list")).toMatchObject({ ok: true, result: [{ id }] });
    expect(await ws.call("cron.runNow", { id })).toMatchObject({ ok: false, error: expect.stringContaining("gateway isn't running") });
    expect(await ws.call("cron.add", { ...base, schedule: "every 10s" })).toMatchObject({ ok: false });
    expect(await ws.call("cron.remove", { id })).toMatchObject({ ok: true, result: { removed: true } });
  } finally {
    await ws.close();
  }
});

test("cron.add without deliver sends to the owner's chat when there is an owner, else nowhere", async () => {
  const h = cronHandlers(kit.ctx);
  expect((await h["cron.add"]!(base)).deliver).toBe("none");
  const pairing = new FilePairing({ path: join(kit.home, "gateway", "pairing.json") });
  const c = await pairing.challenge("telegram", "42");
  if (c.kind !== "code") throw new Error("expected a code");
  await pairing.approve("telegram", c.code);
  expect((await h["cron.add"]!(base)).deliver).toBe("telegram:42");
  expect((await h["cron.add"]!({ ...base, deliver: "none" })).deliver).toBe("none");
});
