// src/cli/lifecycle/cron.ts — `tcode cron`: manage scheduled jobs. Works on the job files directly; the gateway picks changes up within a minute.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ScheduleError, parseHumanSchedule, type Schedule } from "../../gateway/cron/schedule";
import { CronStore, CronStoreError } from "../../gateway/cron/store";
import type { CronJob } from "../../gateway/cron/types";
import type { LifecycleContext, LifecycleRun } from "./types";

const USAGE = `Usage: tcode cron <command>
  list [--json]                       Show the scheduled jobs
  add --name <n> --schedule "<when>" --prompt "<text>" [--project <id>] [--deliver <chat|none>] [--tz <zone>] [--allow "<rule>"]...
      [--harness-recursion <k>]       run it through the harness lab (k = 1-5 compositions); the best attempt becomes a branch
                                      <when> is "every 30m", "every day at 09:00", "in 20m", "at 2026-10-20T10:00" or a cron expression
  rm <id>                             Delete a job
  enable <id> | disable <id>          Turn a job on or off
  run <id>                            Make a job due now; the gateway runs it at its next tick
  runs <id> [-n 20]                   Show a job's recent runs
  status                              Show whether the gateway runs and when each job fires next
Ids can be shortened to any unique prefix.
`;

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
}

class UsageError extends Error {}

const BOOLEAN_FLAGS = new Set(["json"]);

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-n") {
      const v = argv[++i];
      if (v === undefined) throw new UsageError("-n needs a number");
      out.flags.set("n", [v]);
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq < 0 ? undefined : eq);
      if (BOOLEAN_FLAGS.has(name)) {
        out.bools.add(name);
        continue;
      }
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      out.flags.set(name, [...(out.flags.get(name) ?? []), value]);
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

const flag = (p: Parsed, name: string): string | undefined => p.flags.get(name)?.at(-1);

function describe(s: Schedule): string {
  if (s.kind === "cron") return `${s.expr}${s.tz ? ` ${s.tz}` : ""}`;
  if (s.kind === "every") return `every ${s.ms % 3_600_000 === 0 ? `${s.ms / 3_600_000}h` : s.ms % 60_000 === 0 ? `${s.ms / 60_000}m` : `${s.ms}ms`}`;
  return `at ${s.at}`;
}

const iso = (t: number | undefined): string => (t === undefined ? "-" : new Date(t).toISOString().replace(/\.\d+Z$/, "Z"));

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join("  ")).join("\n") + "\n";
}

/** Whether a gateway process is alive: its state file names a pid that still exists. */
function gatewayRunning(home: string): boolean {
  try {
    const state = JSON.parse(readFileSync(join(home, "gateway", "state.json"), "utf8")) as { pid?: number };
    if (typeof state.pid !== "number") return false;
    process.kill(state.pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pick(store: CronStore, p: Parsed): CronJob {
  const id = p.positional[1];
  if (!id) throw new UsageError("a job id is required");
  const job = store.find(id);
  if (!job) throw new CronStoreError(`no job "${id}". See \`tcode cron list\`.`);
  return job;
}

function list(store: CronStore, p: Parsed, ctx: LifecycleContext): number {
  const jobs = store.list();
  if (p.bools.has("json")) {
    ctx.out(`${JSON.stringify(jobs, null, 2)}\n`);
    return 0;
  }
  if (jobs.length === 0) {
    ctx.out("No scheduled jobs. Add one with `tcode cron add`.\n");
    return 0;
  }
  ctx.out(table([["ID", "ON", "NAME", "SCHEDULE", "PROJECT", "DELIVER", "LAST"], ...jobs.map((j) => [j.id, j.enabled ? "yes" : "no", j.name, describe(j.schedule), j.project, j.deliver, j.lastStatus ?? "-"])]));
  return 0;
}

function add(store: CronStore, p: Parsed, ctx: LifecycleContext): number {
  const name = flag(p, "name")?.trim();
  const when = flag(p, "schedule");
  const prompt = flag(p, "prompt");
  if (!name || !when || !prompt?.trim()) throw new UsageError("add needs --name, --schedule and --prompt");
  const tz = flag(p, "tz");
  const schedule = parseHumanSchedule(when, { now: ctx.now(), ...(tz ? { tz } : {}) });
  const allow = p.flags.get("allow");
  const recursion = flag(p, "harness-recursion");
  const k = recursion === undefined ? undefined : Number(recursion);
  if (k !== undefined && (!Number.isInteger(k) || k < 1 || k > 5)) throw new UsageError("--harness-recursion must be a whole number from 1 to 5");
  const job = store.add({
    name,
    schedule,
    prompt,
    project: flag(p, "project") ?? "default",
    deliver: flag(p, "deliver") ?? "none",
    createdBy: "user",
    ...(allow?.length ? { allowCommands: allow } : {}),
    ...(k !== undefined ? { harnessRecursion: k } : {}),
  });
  ctx.out(`Added ${job.id} (${job.name}): ${describe(schedule)}; next run ${iso(job.nextRunAt)}.${k ? ` It runs through the harness lab (k=${k}): four or more runs, the best one handed over as a branch.` : ""}\n`);
  return 0;
}

function runs(store: CronStore, p: Parsed, ctx: LifecycleContext): number {
  const job = pick(store, p);
  const n = Number(flag(p, "n") ?? 20);
  if (!Number.isInteger(n) || n < 1) throw new UsageError("-n must be a positive number");
  const records = store.runs(job.id, n);
  if (records.length === 0) {
    ctx.out(`${job.name} has not run yet.\n`);
    return 0;
  }
  ctx.out(
    table([
      ["STARTED", "STATUS", "TOOK", "SUMMARY"],
      ...records.map((r) => [iso(r.startedAt), r.status, `${Math.round((r.endedAt - r.startedAt) / 1000)}s`, (r.error ? `${r.error} ` : "") + r.summary.replace(/\s+/g, " ").slice(0, 80)]),
    ]),
  );
  return 0;
}

function status(store: CronStore, ctx: LifecycleContext): number {
  ctx.out(gatewayRunning(ctx.home) ? "Gateway: running\n" : "Gateway: not running (jobs only run while it is; start it with `tcode gateway`)\n");
  const jobs = store.list();
  if (jobs.length === 0) {
    ctx.out("No scheduled jobs.\n");
    return 0;
  }
  const due = ctx.now();
  ctx.out(
    table([
      ["ID", "NAME", "NEXT RUN", "LAST"],
      ...jobs.map((j) => [j.id, j.name, !j.enabled ? "disabled" : j.nextRunAt === undefined ? "-" : `${iso(j.nextRunAt)}${j.nextRunAt <= due ? " (due)" : ""}`, j.lastRunAt ? `${iso(j.lastRunAt)} ${j.lastStatus ?? ""}`.trim() : "-"]),
    ]),
  );
  return 0;
}

const run: LifecycleRun = async (argv, ctx) => {
  const store = new CronStore(ctx.home, { now: () => ctx.now() });
  try {
    const p = parseArgs(argv);
    const cmd = p.positional[0];
    switch (cmd) {
      case "list":
      case "ls":
        return list(store, p, ctx);
      case "add":
        return add(store, p, ctx);
      case "rm":
      case "remove": {
        const job = pick(store, p);
        store.remove(job.id);
        ctx.out(`Removed ${job.id} (${job.name}).\n`);
        return 0;
      }
      case "enable":
      case "disable": {
        const job = pick(store, p);
        const updated = store.setEnabled(job.id, cmd === "enable")!;
        ctx.out(`${updated.id} (${updated.name}) is ${updated.enabled ? `enabled; next run ${iso(updated.nextRunAt)}` : "disabled"}.\n`);
        return 0;
      }
      case "run": {
        const job = pick(store, p);
        // The CLI never executes a job itself: a run needs the gateway's sandbox and sessions.
        store.update(job.id, { nextRunAt: ctx.now() });
        const running = gatewayRunning(ctx.home);
        ctx.out(`${job.name} is due now and will run at the gateway's next tick${running ? " (within a minute)" : ", once the gateway is running (it is not right now)"}.\n`);
        if (!job.enabled) ctx.out("Note: the job is disabled; enable it for the run to happen.\n");
        return 0;
      }
      case "runs":
        return runs(store, p, ctx);
      case "status":
        return status(store, ctx);
      default:
        (cmd ? ctx.err : ctx.out)(USAGE);
        return cmd ? 64 : 0;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(`tcode cron: ${e.message}\n${USAGE}`);
      return 64;
    }
    if (e instanceof ScheduleError || e instanceof CronStoreError) {
      ctx.err(`tcode cron: ${e.message}\n`);
      return 1;
    }
    ctx.err(`tcode cron: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
};
export default run;
