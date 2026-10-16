import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { createCronService, type CronServiceOptions } from "./scheduler";
import { CronStore, type NewJob } from "./store";
import type { CronDeps, CronJob } from "./types";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

const T0 = Date.parse("2026-10-15T12:00:00Z");
const MIN = 60_000;

interface Call {
  job: CronJob;
  signal: AbortSignal;
  resolve(text: string): void;
  reject(e: Error): void;
}

function harness(over: Partial<CronServiceOptions> = {}) {
  let clock = T0;
  const timers = new Map<number, { fn: () => void; due: number }>();
  let nextTimer = 1;
  const calls: Call[] = [];
  const delivered: { target: string; text: string }[] = [];
  const logs: string[] = [];
  let deliverError: Error | undefined;
  const store = new CronStore(home, { now: () => clock });
  const deps: CronDeps = {
    home,
    now: () => clock,
    log: (m) => logs.push(m),
    runJob: (job, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ job, signal, resolve: (text) => resolve({ text }), reject });
      }),
    deliver: async (target, text) => {
      if (deliverError) throw deliverError;
      delivered.push({ target, text });
    },
  };
  const service = createCronService({
    store,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, due: clock + ms });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
    ...over,
  });
  /** Moves the clock and fires every timer that has come due. */
  async function advance(ms: number): Promise<void> {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.due <= clock && timers.has(id)) {
        timers.delete(id);
        t.fn();
      }
    }
    await flush();
  }
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    store,
    service,
    deps,
    calls,
    delivered,
    logs,
    timers,
    advance,
    flush,
    setClock: (t: number) => (clock = t),
    failDelivery: (e: Error) => (deliverError = e),
    start: async () => {
      await service.start(deps);
      await flush();
    },
  };
}

const every = (ms = 5 * MIN): NewJob => ({ name: "job", schedule: { kind: "every", ms }, prompt: "do it" });

test("runs a job when it comes due and delivers '<name>: <text>'", async () => {
  const h = harness();
  const job = h.store.add({ ...every(), deliver: "telegram:1" });
  await h.start();
  expect(h.calls).toHaveLength(0);
  await h.advance(5 * MIN);
  expect(h.calls).toHaveLength(1);
  h.calls[0]!.resolve("  all good \n");
  await h.flush();
  expect(h.delivered).toEqual([{ target: "telegram:1", text: "job: all good" }]);
  const runs = h.store.runs(job.id);
  expect(runs[0]).toMatchObject({ status: "ok", summary: "  all good \n" });
  expect(h.store.get(job.id)).toMatchObject({ lastStatus: "ok", lastRunAt: T0 + 5 * MIN, nextRunAt: T0 + 10 * MIN });
  await h.service.stop();
});

test("deliver none delivers nothing; long results are trimmed to 3500", async () => {
  const h = harness();
  h.store.add(every());
  h.store.add({ ...every(), name: "long", deliver: "telegram:2" });
  await h.start();
  await h.advance(5 * MIN);
  expect(h.calls).toHaveLength(2);
  h.calls[0]!.resolve("quiet");
  h.calls[1]!.resolve("x".repeat(9000));
  await h.flush();
  expect(h.delivered).toHaveLength(1);
  expect(h.delivered[0]!.text).toHaveLength(3500);
  expect(h.delivered[0]!.text.startsWith("long: xxx")).toBe(true);
  await h.service.stop();
});

test("the timer is armed for the earliest run, capped at a tick, and re-armed after changes", async () => {
  const h = harness();
  h.store.add(every(30 * MIN));
  await h.start();
  expect([...h.timers.values()].map((t) => t.due - T0)).toEqual([MIN]);
  const soon = h.store.add(every(2 * MIN));
  await h.advance(MIN);
  // a tick re-reads the file, so the job added from the CLI is now the earliest
  expect([...h.timers.values()].map((t) => t.due - (T0 + MIN))).toEqual([MIN]);
  await h.advance(MIN);
  expect(h.calls.map((c) => c.job.id)).toEqual([soon.id]);
  await h.service.stop();
  expect(h.timers.size).toBe(0);
});

test("never two concurrent runs of one job: the overlapping slot is recorded as skipped", async () => {
  const h = harness();
  const job = h.store.add(every(MIN));
  await h.start();
  await h.advance(MIN);
  expect(h.calls).toHaveLength(1);
  await h.advance(MIN);
  expect(h.calls).toHaveLength(1);
  expect(h.store.runs(job.id)[0]).toMatchObject({ status: "skipped" });
  h.calls[0]!.resolve("done");
  await h.flush();
  await h.advance(MIN);
  expect(h.calls).toHaveLength(2);
  await h.service.stop();
});

test("the global cap holds extra jobs back until a slot frees up", async () => {
  const h = harness({ maxConcurrent: 2 });
  for (const n of ["a", "b", "c"]) h.store.add({ ...every(), name: n });
  await h.start();
  await h.advance(5 * MIN);
  expect(h.calls.map((c) => c.job.name)).toEqual(["a", "b"]);
  h.calls[0]!.resolve("ok");
  await h.flush();
  expect(h.calls.map((c) => c.job.name)).toEqual(["a", "b", "c"]);
  await h.service.stop();
});

test("a run over its time limit is aborted and recorded as timeout", async () => {
  const h = harness();
  const job = h.store.add({ ...every(60 * MIN), maxRuntimeMs: 2 * MIN, deliver: "telegram:1" });
  await h.start();
  await h.advance(60 * MIN);
  const call = h.calls[0]!;
  expect(call.signal.aborted).toBe(false);
  await h.advance(2 * MIN);
  expect(call.signal.aborted).toBe(true);
  expect(h.store.runs(job.id)[0]).toMatchObject({ status: "timeout" });
  expect(h.store.get(job.id)!.lastStatus).toBe("timeout");
  expect(h.delivered[0]!.text).toContain("job: failed (timed out");
  // the slot is free again even though the runner never settled
  h.calls[0]!.reject(new Error("late"));
  await h.flush();
  await h.service.stop();
});

test("a failing runner is recorded and does not stop the service", async () => {
  const h = harness();
  const job = h.store.add(every());
  await h.start();
  await h.advance(5 * MIN);
  h.calls[0]!.reject(new Error("model exploded"));
  await h.flush();
  expect(h.store.runs(job.id)[0]).toMatchObject({ status: "error", error: "model exploded" });
  await h.advance(5 * MIN);
  expect(h.calls).toHaveLength(2);
  await h.service.stop();
});

test("a runner that throws synchronously is an error run too", async () => {
  const h = harness();
  const job = h.store.add(every());
  h.deps.runJob = () => {
    throw new Error("boom");
  };
  await h.start();
  await h.advance(5 * MIN);
  expect(h.store.runs(job.id)[0]).toMatchObject({ status: "error", error: "boom" });
  await h.service.stop();
});

test("delivery failure is recorded in the run and the summary is kept", async () => {
  const h = harness();
  const job = h.store.add({ ...every(), deliver: "telegram:1" });
  h.failDelivery(new Error("chat gone"));
  await h.start();
  await h.advance(5 * MIN);
  h.calls[0]!.resolve("the result");
  await h.flush();
  expect(h.store.runs(job.id)[0]).toMatchObject({ status: "ok", summary: "the result", error: "delivery failed: chat gone" });
  await h.service.stop();
});

test("missed-run policy: less than 6 hours late runs once, then goes back on schedule", async () => {
  const h = harness();
  const job = h.store.add(every(60 * MIN)); // due at T0 + 1h
  h.setClock(T0 + 5 * 3_600_000); // gateway was down; now 4h late
  await h.start();
  expect(h.calls).toHaveLength(1);
  h.calls[0]!.resolve("caught up");
  await h.flush();
  expect(h.store.runs(job.id)).toHaveLength(1);
  expect(h.store.get(job.id)!.nextRunAt).toBe(T0 + 6 * 3_600_000);
  await h.service.stop();
});

test("missed-run policy: 6 hours or more late is recorded as missed and rescheduled", async () => {
  const h = harness();
  const job = h.store.add(every(60 * MIN));
  h.setClock(T0 + 8 * 3_600_000);
  await h.start();
  expect(h.calls).toHaveLength(0);
  expect(h.store.runs(job.id)[0]).toMatchObject({ status: "missed" });
  expect(h.store.get(job.id)).toMatchObject({ lastStatus: "missed", nextRunAt: T0 + 9 * 3_600_000, enabled: true });
  await h.service.stop();
});

test("a missed one-shot is recorded and disabled", async () => {
  const h = harness();
  const job = h.store.add({ name: "once", prompt: "p", schedule: { kind: "at", at: new Date(T0 + MIN).toISOString() } });
  h.setClock(T0 + 10 * 3_600_000);
  await h.start();
  expect(h.calls).toHaveLength(0);
  expect(h.store.get(job.id)).toMatchObject({ enabled: false, lastStatus: "missed" });
  await h.service.stop();
});

test("a one-shot runs once and disables itself", async () => {
  const h = harness();
  const job = h.store.add({ name: "once", prompt: "p", schedule: { kind: "at", at: new Date(T0 + 3 * MIN).toISOString() } });
  await h.start();
  await h.advance(3 * MIN);
  expect(h.calls).toHaveLength(1);
  expect(h.store.get(job.id)).toMatchObject({ enabled: false });
  h.calls[0]!.resolve("done");
  await h.flush();
  await h.advance(10 * MIN);
  expect(h.calls).toHaveLength(1);
  await h.service.stop();
});

test("disabled jobs don't run; enabling starts counting from now", async () => {
  const h = harness();
  const job = h.store.add(every());
  h.store.setEnabled(job.id, false);
  await h.start();
  await h.advance(20 * MIN);
  expect(h.calls).toHaveLength(0);
  h.store.setEnabled(job.id, true);
  expect(h.store.get(job.id)!.nextRunAt).toBe(T0 + 25 * MIN);
  await h.advance(5 * MIN);
  expect(h.calls).toHaveLength(1);
  await h.service.stop();
});

test("a removed job stops running; a corrupt file doesn't crash the tick", async () => {
  const h = harness();
  const job = h.store.add(every());
  await h.start();
  h.store.remove(job.id);
  await h.advance(5 * MIN);
  expect(h.calls).toHaveLength(0);
  h.store.add(every());
  await Bun.write(h.store.jobsPath, "garbage");
  await h.advance(5 * MIN);
  expect(h.calls).toHaveLength(0);
  expect(h.timers.size).toBe(1);
  await h.service.stop();
});

test("runNow runs regardless of schedule or enabled, and refuses a job that is running", async () => {
  const h = harness();
  const job = h.store.add({ ...every(60 * MIN), enabled: false, deliver: "telegram:1" });
  await h.start();
  const p = h.service.runNow(job.id.slice(0, 4));
  await h.flush();
  expect(h.calls).toHaveLength(1);
  await expect(h.service.runNow(job.id)).rejects.toThrow(/already running/);
  h.calls[0]!.resolve("manual");
  expect(await p).toMatchObject({ status: "ok", summary: "manual" });
  expect(h.delivered[0]!.text).toBe("job: manual");
  await expect(h.service.runNow("nope")).rejects.toThrow(/no job/);
  await h.service.stop();
});

test("stop aborts running jobs and waits for them to be recorded", async () => {
  const h = harness();
  const job = h.store.add(every());
  await h.start();
  await h.advance(5 * MIN);
  await h.service.stop();
  expect(h.calls[0]!.signal.aborted).toBe(true);
  expect(h.store.runs(job.id)[0]).toMatchObject({ status: "error", error: "stopped" });
  expect(h.timers.size).toBe(0);
});

test("cron jobs follow their time zone", async () => {
  const h = harness();
  h.setClock(Date.parse("2026-03-08T06:00:00Z")); // 01:00 EST, the night clocks jump
  const job = h.store.add({ name: "ny", prompt: "p", schedule: { kind: "cron", expr: "30 2 * * *", tz: "America/New_York" } });
  expect(job.nextRunAt).toBe(Date.parse("2026-03-08T07:00:00Z"));
  await h.start();
  await h.advance(MIN * 60);
  expect(h.calls).toHaveLength(1);
  await h.service.stop();
});
