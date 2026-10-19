// src/gateway/cron/scheduler.ts — runs due jobs. One timer, armed for the earliest next run and never longer than a tick,
// so jobs edited on disk by the CLI are noticed within a minute.
import { randomBytes } from "node:crypto";
import { firstRun, nextRun } from "./schedule";
import { CronStore } from "./store";
import { DEFAULT_MAX_RUNTIME_MS, type CronDeps, type CronJob, type CronService, type RunRecord, type RunStatus } from "./types";

export const DELIVER_CHARS = 3500;
export const DEFAULT_LATE_MS = 6 * 3_600_000;
export const DEFAULT_TICK_MS = 60_000;

export interface CronServiceOptions {
  /** Defaults to a CronStore under deps.home. */
  store?: CronStore;
  /** Most jobs running at once. */
  maxConcurrent?: number;
  /** A run due longer ago than this is recorded as missed instead of run. */
  lateMs?: number;
  tickMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Running {
  controller: AbortController;
  done: Promise<RunRecord>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createCronService(opts: CronServiceOptions = {}): CronService & { store(): CronStore } {
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const lateMs = opts.lateMs ?? DEFAULT_LATE_MS;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const running = new Map<string, Running>();
  let deps: CronDeps | undefined;
  let store: CronStore | undefined = opts.store;
  let timer: unknown;
  let stopped = true;

  const now = () => (deps?.now ?? Date.now)();
  const log = (m: string) => deps?.log?.(`cron: ${m}`);

  function arm(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (stopped || !store) return;
    let delay = tickMs;
    try {
      const at = store
        .list()
        .filter((j) => j.enabled && j.nextRunAt !== undefined)
        .map((j) => j.nextRunAt!);
      // Due work that a full pool is holding back waits for a run to finish (which re-arms) or the next tick.
      if (at.length > 0 && running.size < maxConcurrent) delay = Math.min(tickMs, Math.max(0, Math.min(...at) - now()));
    } catch (e) {
      log(`could not read jobs: ${message(e)}`);
    }
    timer = setTimer(() => {
      timer = undefined;
      tick();
    }, delay);
  }

  /** The patch that moves a job past the run that was just started or skipped. */
  function advance(job: CronJob, from: number): Partial<CronJob> {
    if (job.schedule.kind === "at") return { enabled: false, nextRunAt: undefined };
    return { nextRunAt: nextRun(job.schedule, new Date(from))?.getTime() };
  }

  function record(job: CronJob, status: RunStatus, summary: string, at: number, error?: string): void {
    store!.appendRun({ jobId: job.id, runId: randomBytes(4).toString("hex"), startedAt: at, endedAt: at, status, summary, ...(error ? { error } : {}) });
    store!.update(job.id, { lastStatus: status });
  }

  function tick(): void {
    if (stopped || !store) return;
    try {
      const t = now();
      for (const job of store.list()) {
        if (!job.enabled) continue;
        if (job.nextRunAt === undefined) {
          const next = job.lastRunAt === undefined ? firstRun(job.schedule, job.createdAt) : firstRun(job.schedule, t);
          if (next === undefined) continue;
          job.nextRunAt = next;
          store.update(job.id, { nextRunAt: next });
        }
        if (job.nextRunAt > t) continue;
        if (t - job.nextRunAt > lateMs) {
          log(`${job.name}: run due ${new Date(job.nextRunAt).toISOString()} missed`);
          record(job, "missed", `Missed: it was due ${new Date(job.nextRunAt).toISOString()} and the gateway was not running.`, t);
          store.update(job.id, advance(job, t));
          continue;
        }
        if (running.has(job.id)) {
          record(job, "skipped", "Skipped: the previous run is still going.", t);
          store.update(job.id, advance(job, t));
          continue;
        }
        if (running.size >= maxConcurrent) continue;
        store.update(job.id, { ...advance(job, t), lastRunAt: t });
        void execute(job, t);
      }
    } catch (e) {
      log(`tick failed: ${message(e)}`);
    }
    arm();
  }

  /** Runs one job to the end and records it. Never rejects. */
  function execute(job: CronJob, startedAt: number): Promise<RunRecord> {
    const controller = new AbortController();
    const done = (async (): Promise<RunRecord> => {
      let status: RunStatus = "ok";
      let text = "";
      let error: string | undefined;
      const limit = job.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
      let timedOut = false;
      const watchdog = setTimer(() => {
        timedOut = true;
        controller.abort();
      }, limit);
      const aborted = new Promise<"aborted">((resolve) => controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
      try {
        const work = (async () => deps!.runJob(job, controller.signal))();
        // If the runner ignores the abort, its late failure must not surface as an unhandled rejection.
        work.catch(() => {});
        const result = await Promise.race([work, aborted]);
        if (result === "aborted") {
          status = timedOut ? "timeout" : "error";
          error = timedOut ? `timed out after ${Math.round(limit / 1000)}s` : "stopped";
        } else {
          text = String(result.text ?? "");
        }
      } catch (e) {
        status = "error";
        error = message(e);
      }
      clearTimer(watchdog);

      const target = job.deliver;
      if (target !== "none") {
        const body = status === "ok" ? `${job.name}: ${text.trim() || "(no output)"}` : `${job.name}: failed (${error ?? status})`;
        try {
          await deps!.deliver(target, body.trim().slice(0, DELIVER_CHARS));
        } catch (e) {
          error = error ? `${error}; delivery failed: ${message(e)}` : `delivery failed: ${message(e)}`;
          log(`${job.name}: delivery to ${target} failed: ${message(e)}`);
        }
      }

      const rec: RunRecord = { jobId: job.id, runId: randomBytes(4).toString("hex"), startedAt, endedAt: now(), status, summary: text.slice(0, 500), ...(error ? { error } : {}) };
      try {
        store!.appendRun(rec);
        store!.update(job.id, { lastStatus: status });
      } catch (e) {
        log(`could not record run of ${job.name}: ${message(e)}`);
      }
      return rec;
    })();
    running.set(job.id, { controller, done });
    void done.then(() => {
      running.delete(job.id);
      // A slot is free: anything the cap held back can go now.
      tick();
    });
    return done;
  }

  return {
    name: "cron",
    store() {
      if (!store) throw new Error("the cron service has not started");
      return store;
    },
    start(d) {
      deps = d;
      store ??= new CronStore(d.home, { now: d.now });
      stopped = false;
      // Due jobs run (or are marked missed) right away.
      tick();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      const pending = [...running.values()];
      for (const r of pending) r.controller.abort();
      await Promise.allSettled(pending.map((r) => r.done));
    },
    async runNow(idOrPrefix) {
      if (!deps || !store) throw new Error("the cron service has not started");
      const job = store.find(idOrPrefix);
      if (!job) throw new Error(`no job "${idOrPrefix}"`);
      if (running.has(job.id)) throw new Error(`"${job.name}" is already running`);
      const t = now();
      store.update(job.id, { lastRunAt: t });
      return execute(job, t);
    },
    running: () => running.size,
  };
}
