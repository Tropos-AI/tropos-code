// src/web/admin/cron.ts — `cron.*`: the scheduler's jobs, read and written through CronStore (the gateway picks
// changes up within a minute), plus "run now" through the running gateway.
import { listProjects } from "../../gateway/projects";
import { ScheduleError, firstRun, parseHumanSchedule, scheduleSchema, type Schedule } from "../../gateway/cron/schedule";
import { CronStore, CronStoreError } from "../../gateway/cron/store";
import type { CronJob } from "../../gateway/cron/types";
import type { CronJobView, CronRunView, CronScheduleView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

export interface CronDeps {
  store: CronStore;
}

const NAME_MAX = 100;
const PROMPT_MAX = 20_000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");

function everyText(ms: number): string {
  const units: [number, string][] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]];
  for (const [size, word] of units) if (ms % size === 0) return `every ${ms / size === 1 ? word : `${ms / size} ${word}s`}`;
  return `every ${Math.round(ms / 1000)} seconds`;
}

/** "every day at 09:00", "every weekday at 09:30", "every 30 minutes", "once at 2026-10-20 10:00 UTC"; the raw expression when it is not a simple one. */
export function scheduleText(s: Schedule): string {
  if (s.kind === "every") return everyText(s.ms);
  if (s.kind === "at") return `once at ${s.at}`;
  const zone = s.tz ? ` (${s.tz})` : "";
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|0,6|[0-6])$/.exec(s.expr);
  if (m) {
    const when = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
    const who = m[3] === "*" ? "day" : m[3] === "1-5" ? "weekday" : m[3] === "0,6" ? "weekend day" : DAY_NAMES[Number(m[3])]!;
    return `every ${who} at ${when}${zone}`;
  }
  return `cron ${s.expr}${zone}`;
}

const iso = (t: number | undefined): string | undefined => (t === undefined ? undefined : new Date(t).toISOString());

function view(job: CronJob): CronJobView {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule as CronScheduleView,
    scheduleText: scheduleText(job.schedule),
    prompt: job.prompt,
    project: job.project,
    deliver: job.deliver,
    enabled: job.enabled,
    // A paused job has no next run to promise.
    nextRunAt: job.enabled ? iso(job.nextRunAt) : undefined,
    lastRunAt: iso(job.lastRunAt),
    lastStatus: job.lastStatus,
    createdBy: job.createdBy,
  };
}

export function cronHandlers(ctx: AdminContext, deps: Partial<CronDeps> = {}): AdminHandlers {
  const store = deps.store ?? new CronStore(ctx.home, { now: ctx.now });

  function schedule(input: unknown, tz: string | undefined): Schedule {
    try {
      if (typeof input === "string") return parseHumanSchedule(input, { now: ctx.now(), ...(tz ? { tz } : {}) });
      const parsed = scheduleSchema.safeParse(input);
      if (!parsed.success) throw new ScheduleError(parsed.error.issues[0]?.message ?? "invalid schedule");
      const s = parsed.data;
      return s.kind === "cron" && !s.tz && tz ? { ...s, tz } : s;
    } catch (err) {
      if (err instanceof ScheduleError) throw new AdminError(err.message);
      throw err;
    }
  }

  function text(value: unknown, what: string, max: number): string {
    if (typeof value !== "string" || !value.trim()) throw new AdminError(`${what} can't be empty.`);
    if (value.length > max) throw new AdminError(`${what} is too long (at most ${max} characters).`);
    return what === "The prompt" ? value : value.trim();
  }

  async function projectId(value: unknown): Promise<string> {
    if (typeof value !== "string" || !value) throw new AdminError("Choose a project.");
    if (!(await listProjects(ctx.home)).some((p) => p.id === value)) throw new AdminError(`There is no project "${value.slice(0, 60)}".`);
    return value;
  }

  function deliver(value: unknown): string {
    if (typeof value !== "string" || (value !== "none" && !/^[a-z][a-z0-9_-]*:\S{1,120}$/i.test(value))) throw new AdminError('Deliver to "none" or a chat such as telegram:123456.');
    return value;
  }

  function checkTz(tz: unknown): string | undefined {
    if (tz === undefined || tz === "") return undefined;
    if (typeof tz !== "string") throw new AdminError("The time zone must be a name such as Europe/Athens.");
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
    } catch {
      throw new AdminError(`"${tz.slice(0, 60)}" is not a time zone.`);
    }
    return tz;
  }

  function find(id: unknown): CronJob {
    if (typeof id !== "string") throw new AdminError("Choose a job.");
    try {
      const job = store.find(id);
      if (!job) throw new AdminError("There is no such job.");
      return job;
    } catch (err) {
      if (err instanceof CronStoreError) throw new AdminError(err.message);
      throw err;
    }
  }

  return {
    "cron.list": async () => store.list().map(view),

    async "cron.add"(p) {
      const tz = checkTz(p.tz);
      const job = store.add({
        name: text(p.name, "The name", NAME_MAX),
        schedule: schedule(p.schedule, tz),
        prompt: text(p.prompt, "The prompt", PROMPT_MAX),
        project: await projectId(p.project ?? "default"),
        deliver: deliver(p.deliver ?? "none"),
        createdBy: "user",
      });
      return view(job);
    },

    async "cron.update"({ id, patch }) {
      const job = find(id);
      const next: Partial<CronJob> = {};
      if (patch.name !== undefined) next.name = text(patch.name, "The name", NAME_MAX);
      if (patch.prompt !== undefined) next.prompt = text(patch.prompt, "The prompt", PROMPT_MAX);
      if (patch.project !== undefined) next.project = await projectId(patch.project);
      if (patch.deliver !== undefined) next.deliver = deliver(patch.deliver);
      if (patch.schedule !== undefined || patch.tz !== undefined) {
        const tz = checkTz(patch.tz);
        const current = job.schedule.kind === "cron" ? job.schedule.tz : undefined;
        const s = schedule(patch.schedule ?? job.schedule, tz ?? current);
        next.schedule = s;
        // The next run is counted from the new schedule, from now.
        if (job.enabled) next.nextRunAt = firstRun(s, ctx.now());
      }
      const updated = store.update(job.id, next);
      if (!updated) throw new AdminError("There is no such job.");
      return view(updated);
    },

    async "cron.remove"({ id }) {
      return { removed: store.remove(find(id).id) };
    },

    async "cron.setEnabled"({ id, enabled }) {
      if (typeof enabled !== "boolean") throw new AdminError("enabled must be true or false.");
      const job = store.setEnabled(find(id).id, enabled);
      if (!job) throw new AdminError("There is no such job.");
      return view(job);
    },

    async "cron.runNow"({ id }) {
      const job = find(id);
      if (!ctx.gateway) throw new AdminError("The gateway isn't running, so the job will run at its next scheduled time. Start it with `tcode gateway`.");
      // A run can take minutes, so only an immediate refusal ("already running") is reported; its record
      // appears in cron.runs when it ends.
      const run = ctx.gateway.runCronNow(job.id);
      run.catch(() => undefined);
      const early = await Promise.race([run.then(() => null, (e: unknown) => e), new Promise<null>((r) => setTimeout(() => r(null), 150))]);
      if (early) throw new AdminError(early instanceof Error ? early.message : "The job could not be started.");
      return { started: true };
    },

    async "cron.runs"({ id, limit }) {
      const job = find(id);
      const n = limit === undefined ? 20 : Math.min(Math.max(Math.trunc(limit), 1), 200);
      return store.runs(job.id, n).map(
        (r): CronRunView => ({ runId: r.runId, startedAt: new Date(r.startedAt).toISOString(), endedAt: new Date(r.endedAt).toISOString(), status: r.status, summary: r.summary, ...(r.error ? { error: r.error } : {}) }),
      );
    },
  };
}
