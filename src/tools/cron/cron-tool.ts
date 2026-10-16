// src/tools/cron/cron-tool.ts — lets the agent manage scheduled jobs. Kind "exec": it always asks, and the permission
// preview shows the whole job, because a scheduled prompt runs later with nobody watching.
import { z } from "zod";
import { errorText } from "../../error-text";
import { parseHumanSchedule, scheduleSchema, type Schedule } from "../../gateway/cron/schedule";
import type { CronStore } from "../../gateway/cron/store";
import type { CronJob, RunRecord } from "../../gateway/cron/types";
import { defineTool, type PermissionPreview, type ToolOutput } from "../types";

const structured = z.object({
  kind: z.enum(["cron", "every", "at"]),
  expr: z.string().optional().describe('For kind "cron": 5 fields, minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5".'),
  tz: z.string().optional().describe('IANA zone for kind "cron", e.g. "Europe/Athens"; the machine\'s zone when omitted.'),
  ms: z.number().optional().describe('For kind "every": the interval in milliseconds, at least 60000.'),
  at: z.string().optional().describe('For kind "at": an ISO date-time, e.g. "2026-10-20T10:00:00Z".'),
});

const schema = z.object({
  action: z.enum(["list", "add", "remove", "enable", "disable", "run"]),
  id: z.string().optional().describe("The job id (or a unique prefix) for remove, enable, disable and run."),
  name: z.string().optional().describe("A short name for add; it prefixes the delivered message."),
  schedule: z
    .union([structured, z.string()])
    .optional()
    .describe('For add: {kind:"cron",expr,tz?} | {kind:"every",ms} | {kind:"at",at}, or text such as "every 30m", "every day at 09:00", "in 20m".'),
  prompt: z.string().optional().describe("For add: what the scheduled run should do. It runs alone, without this conversation, so say everything it needs."),
  project: z.string().optional().describe('For add: the project id the run works in; "default" when omitted.'),
  deliverTo: z.string().optional().describe('For add: where the result goes, a chat key like "telegram:123" or "none". Defaults to this chat when known.'),
  allowCommands: z.array(z.string()).optional().describe('For add: rules like "Bash(npm test:*)" the run may use without asking. Leave out unless needed.'),
});

type Input = z.infer<typeof schema>;

export interface CronToolOptions {
  store: CronStore;
  /** The chat the tool is being used from (the daemon fills this in); used when `deliverTo` is not given. */
  defaultDeliver?: () => string | undefined;
  /** The owner's sessions: every job is visible and changeable, and `defaultDeliver` only supplies the default target. */
  seeAll?: boolean;
  /** The chat the tool is used in, recorded on new jobs: a job made in a guest's chat runs as untrusted. */
  origin?: string;
  /** Starts a job now without waiting for it (the daemon's scheduler); `run` is refused when absent. */
  runNow?: (id: string) => Promise<RunRecord>;
}

function describeSchedule(s: Schedule): string {
  if (s.kind === "cron") return `cron "${s.expr}"${s.tz ? ` (${s.tz})` : ""}`;
  if (s.kind === "every") return `every ${s.ms % 3_600_000 === 0 ? `${s.ms / 3_600_000}h` : s.ms % 60_000 === 0 ? `${s.ms / 60_000}m` : `${s.ms}ms`}`;
  return `once at ${s.at}`;
}

export function createCronTool(opts: CronToolOptions) {
  const { store } = opts;

  function resolveSchedule(raw: NonNullable<Input["schedule"]>): Schedule {
    if (typeof raw === "string") return parseHumanSchedule(raw);
    const parsed = scheduleSchema.safeParse(raw.kind === "cron" ? { kind: "cron", expr: raw.expr, tz: raw.tz } : raw.kind === "every" ? { kind: "every", ms: raw.ms } : { kind: "at", at: raw.at });
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
    return parsed.data;
  }

  function target(input: Input): string {
    return input.deliverTo?.trim() || opts.defaultDeliver?.() || "none";
  }

  function jobText(j: Pick<CronJob, "name" | "schedule" | "prompt" | "deliver" | "project" | "allowCommands">): string {
    const lines = [`name: ${j.name}`, `schedule: ${describeSchedule(j.schedule)}`, `project: ${j.project}`, `deliver: ${j.deliver}`];
    if (j.allowCommands?.length) lines.push(`runs without asking: ${j.allowCommands.join(", ")}`);
    lines.push("prompt:", j.prompt);
    return lines.join("\n");
  }

  // From a chat, only that chat's own jobs are visible: another chat's prompts, targets and ids stay out of reach.
  function visible(j: CronJob | undefined): CronJob | undefined {
    if (!j || !opts.defaultDeliver || opts.seeAll) return j;
    return j.deliver === opts.defaultDeliver() ? j : undefined;
  }

  // Resolves an id or prefix among the visible jobs only, so an ambiguous-prefix error cannot name other chats' ids.
  function findVisible(idOrPrefix: string): CronJob | undefined {
    if (!opts.defaultDeliver || opts.seeAll) return store.find(idOrPrefix);
    const mine = store.list().filter((j) => visible(j));
    const exact = mine.find((j) => j.id === idOrPrefix);
    if (exact || !idOrPrefix) return exact;
    const hits = mine.filter((j) => j.id.startsWith(idOrPrefix));
    if (hits.length > 1) throw new Error(`"${idOrPrefix}" matches ${hits.length} jobs: ${hits.map((j) => j.id).join(", ")}`);
    return hits[0];
  }

  function lookup(input: Input): CronJob {
    if (!input.id) throw new Error("id is required");
    const job = findVisible(input.id);
    if (!job) throw new Error(`no job "${input.id}"`);
    return job;
  }

  function line(j: CronJob): string {
    const next = j.enabled && j.nextRunAt ? ` next ${new Date(j.nextRunAt).toISOString()}` : "";
    return `${j.id}  ${j.enabled ? "on " : "off"}  ${j.name}  ${describeSchedule(j.schedule)}  deliver ${j.deliver}${next}`;
  }

  return defineTool({
    name: "Cron",
    kind: "exec",
    description:
      "Schedule work for later: list, add, remove, enable, disable or run scheduled jobs. A job runs its prompt in a fresh session of a project at the scheduled times " +
      "(cron expression, fixed interval of at least a minute, or once) and delivers the result to a chat. The user is asked to approve every use.",
    schema,
    summarize: (input) => (input.action === "add" ? `add job ${input.name ?? ""}`.trim() : input.id ? `${input.action} ${input.id}` : input.action),
    subject: (input) => ({ paths: [], target: `cron:${input.action}` }),
    preview(input): PermissionPreview | undefined {
      try {
        if (input.action === "add") {
          if (!input.name || !input.schedule || !input.prompt) return { header: "Cron: add job", text: "(incomplete request)" };
          return {
            header: "Cron: add job (runs later without anyone watching)",
            text: jobText({ name: input.name, schedule: resolveSchedule(input.schedule), prompt: input.prompt, project: input.project ?? "default", deliver: target(input), allowCommands: input.allowCommands }),
          };
        }
        if (input.action === "list") return undefined;
        const job = input.id ? findVisible(input.id) : undefined;
        return { header: `Cron: ${input.action} job`, text: job ? jobText(job) : `no job "${input.id ?? ""}"` };
      } catch (e) {
        return { header: `Cron: ${input.action}`, text: errorText(e) };
      }
    },
    async run(input): Promise<ToolOutput> {
      try {
        switch (input.action) {
          case "list": {
            const jobs = store.list().filter((j) => visible(j));
            return { content: jobs.length ? jobs.map(line).join("\n") : "No scheduled jobs.", summary: `${jobs.length} job${jobs.length === 1 ? "" : "s"}` };
          }
          case "add": {
            if (!input.name?.trim()) throw new Error("name is required");
            if (!input.prompt?.trim()) throw new Error("prompt is required");
            if (!input.schedule) throw new Error("schedule is required");
            const schedule = resolveSchedule(input.schedule);
            // A chat (or an injected prompt in it) cannot aim a job's output at somebody else's chat.
            const requested = input.deliverTo?.trim();
            if (requested && requested !== "none" && requested !== opts.defaultDeliver?.()) {
              throw new Error(`A job can only be delivered to the chat that creates it, or to none (got "${requested}").`);
            }
            const job = store.add({
              name: input.name.trim(),
              schedule,
              prompt: input.prompt,
              project: input.project ?? "default",
              deliver: target(input),
              createdBy: "agent",
              ...(opts.origin ? { origin: opts.origin } : {}),
              ...(input.allowCommands?.length ? { allowCommands: input.allowCommands } : {}),
            });
            const next = job.nextRunAt ? ` First run ${new Date(job.nextRunAt).toISOString()}.` : "";
            return { content: `Added job ${job.id} (${job.name}): ${describeSchedule(schedule)}, delivering to ${job.deliver}.${next}`, summary: `added ${job.name}` };
          }
          case "remove": {
            const job = lookup(input);
            store.remove(job.id);
            return { content: `Removed job ${job.id} (${job.name}).`, summary: `removed ${job.name}` };
          }
          case "enable":
          case "disable": {
            const job = lookup(input);
            const updated = store.setEnabled(job.id, input.action === "enable")!;
            const next = updated.enabled && updated.nextRunAt ? ` Next run ${new Date(updated.nextRunAt).toISOString()}.` : "";
            return { content: `Job ${job.id} (${job.name}) is now ${updated.enabled ? "enabled" : "disabled"}.${next}`, summary: `${input.action}d ${job.name}` };
          }
          case "run": {
            const job = lookup(input);
            if (!opts.runNow) throw new Error("running a job now is only possible while the gateway is running");
            // The run can take many minutes: start it and let the delivery and the run history report the outcome.
            opts.runNow(job.id).catch(() => {});
            return { content: `Started job ${job.id} (${job.name}). Its result goes to ${job.deliver}.`, summary: `started ${job.name}` };
          }
        }
      } catch (e) {
        return { content: errorText(e), isError: true, summary: "failed" };
      }
    },
  });
}
