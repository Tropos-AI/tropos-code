import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { CronStore } from "../../gateway/cron/store";
import run from "./cron";
import { makeFixture, type Fixture } from "./lifecycle-fixture";

let f: Fixture;
let store: CronStore;
beforeEach(async () => {
  f = await makeFixture();
  store = new CronStore(f.ctx.home);
});
afterEach(() => f.cleanup());

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

describe("tcode cron", () => {
  test("add stores a 0600 job from a human schedule", async () => {
    expect(await run(["add", "--name", "digest", "--schedule", "every day at 09:00", "--prompt", "summarize", "--deliver", "telegram:1", "--project", "web", "--tz", "Europe/Athens", "--allow", "Bash(npm test:*)"], f.ctx)).toBe(0);
    const [job] = store.list();
    expect(job).toMatchObject({ name: "digest", prompt: "summarize", deliver: "telegram:1", project: "web", createdBy: "user", allowCommands: ["Bash(npm test:*)"], schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Athens" } });
    expect(f.stdout()).toContain(job!.id);
    expect(statSync(store.jobsPath).mode & 0o777).toBe(0o600);
  });

  test("add accepts --flag=value and a raw cron expression; a bad schedule fails", async () => {
    expect(await run(["add", "--name=n", "--schedule=*/10 * * * *", "--prompt=p"], f.ctx)).toBe(0);
    expect(store.list()[0]!.schedule).toEqual({ kind: "cron", expr: "*/10 * * * *" });
    expect(await run(["add", "--name", "n", "--schedule", "every 10s", "--prompt", "p"], f.ctx)).toBe(1);
    expect(f.stderr()).toContain("1 minute");
    expect(store.list()).toHaveLength(1);
  });

  test("add without required flags is a usage error", async () => {
    expect(await run(["add", "--name", "n"], f.ctx)).toBe(64);
    expect(await run(["add", "--name"], f.ctx)).toBe(64);
    expect(await run(["frobnicate"], f.ctx)).toBe(64);
  });

  test("list prints a table and --json prints the jobs", async () => {
    expect(await run(["list"], f.ctx)).toBe(0);
    expect(f.stdout()).toContain("No scheduled jobs");
    const job = store.add({ name: "alpha", prompt: "p", schedule: { kind: "every", ms: 1_800_000 } });
    expect(await run(["list"], f.ctx)).toBe(0);
    expect(f.stdout()).toContain("alpha");
    expect(f.stdout()).toContain("every 30m");
    expect(f.stdout()).toContain(job.id);
    const before = f.stdout().length;
    await run(["list", "--json"], f.ctx);
    expect(JSON.parse(f.stdout().slice(before))[0].id).toBe(job.id);
  });

  test("rm, enable and disable take a unique prefix; unknown ids fail", async () => {
    const job = store.add({ name: "a", prompt: "p", schedule: { kind: "every", ms: 60_000 } });
    expect(await run(["disable", job.id.slice(0, 3)], f.ctx)).toBe(0);
    expect(store.get(job.id)!.enabled).toBe(false);
    expect(await run(["enable", job.id], f.ctx)).toBe(0);
    expect(store.get(job.id)!.enabled).toBe(true);
    expect(await run(["rm", "nope"], f.ctx)).toBe(1);
    expect(await run(["rm"], f.ctx)).toBe(64);
    expect(await run(["rm", job.id.slice(0, 3)], f.ctx)).toBe(0);
    expect(store.list()).toEqual([]);
  });

  test("an ambiguous prefix is refused", async () => {
    const a = store.add({ name: "a", prompt: "p", schedule: { kind: "every", ms: 60_000 } });
    await writeFile(store.jobsPath, JSON.stringify({ version: 1, jobs: [{ ...a, id: "abc1" }, { ...a, id: "abc2" }] }));
    expect(await run(["rm", "abc"], f.ctx)).toBe(1);
    expect(f.stderr()).toContain("matches 2 jobs");
  });

  test("run makes the job due and does not execute it; says when the gateway is down", async () => {
    const job = store.add({ name: "a", prompt: "p", schedule: { kind: "every", ms: 3_600_000 } });
    expect(await run(["run", job.id], { ...f.ctx, now: () => NOW })).toBe(0);
    expect(store.get(job.id)!.nextRunAt).toBe(NOW);
    expect(f.stdout()).toContain("next tick");
    expect(f.stdout()).toContain("not right now");
    expect(store.runs(job.id)).toEqual([]);
  });

  test("run notices a live gateway", async () => {
    const job = store.add({ name: "a", prompt: "p", schedule: { kind: "every", ms: 3_600_000 } });
    await mkdir(join(f.ctx.home, "gateway"), { recursive: true });
    await writeFile(join(f.ctx.home, "gateway", "state.json"), JSON.stringify({ pid: process.pid }));
    await run(["run", job.id], f.ctx);
    expect(f.stdout()).toContain("within a minute");
    await run(["status"], f.ctx);
    expect(f.stdout()).toContain("Gateway: running");
  });

  test("runs lists history newest first", async () => {
    const job = store.add({ name: "a", prompt: "p", schedule: { kind: "every", ms: 60_000 } });
    expect(await run(["runs", job.id], f.ctx)).toBe(0);
    expect(f.stdout()).toContain("has not run yet");
    for (let i = 0; i < 3; i++) store.appendRun({ jobId: job.id, runId: `r${i}`, startedAt: NOW + i * 1000, endedAt: NOW + i * 1000 + 2000, status: i === 1 ? "error" : "ok", summary: `result ${i}`, ...(i === 1 ? { error: "boom" } : {}) });
    const before = f.stdout().length;
    expect(await run(["runs", job.id, "-n", "2"], f.ctx)).toBe(0);
    const out = f.stdout().slice(before);
    expect(out.indexOf("result 2")).toBeLessThan(out.indexOf("boom"));
    expect(out).not.toContain("result 0");
    expect(await run(["runs", job.id, "-n", "x"], f.ctx)).toBe(64);
  });

  test("status shows next runs and flags due or disabled jobs", async () => {
    store.add({ name: "soon", prompt: "p", schedule: { kind: "every", ms: 3_600_000 } });
    const off = store.add({ name: "off", prompt: "p", schedule: { kind: "every", ms: 3_600_000 } });
    store.setEnabled(off.id, false);
    expect(await run(["status"], f.ctx)).toBe(0);
    expect(f.stdout()).toContain("Gateway: not running");
    expect(f.stdout()).toContain("soon");
    expect(f.stdout()).toContain("disabled");
  });
});
