// web/src/lib/cron-form.ts — maps the schedule presets of the job dialog to what cron.add / cron.update take, and back
// from an existing job, so editing opens on the same preset the job was made with.
import type { CronJobView } from "@core/web/admin/api";

export type SchedulePreset = "every15" | "hourly" | "daily" | "weekdays" | "weekly" | "custom";

export interface ScheduleForm {
  preset: SchedulePreset;
  /** HH:MM, for daily / weekdays / weekly. */
  time: string;
  /** 0 (Sunday) – 6, for weekly. */
  weekday: string;
  /** "every 30m" or a 5-field cron expression, for custom. */
  custom: string;
}

export const DEFAULT_SCHEDULE_FORM: ScheduleForm = { preset: "daily", time: "09:00", weekday: "1", custom: "" };

export const WEEKDAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

function splitTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** Text the server's schedule parser reads, or an error to show beside the field. */
export function scheduleText(form: ScheduleForm): { ok: true; text: string; usesTimeZone: boolean } | { ok: false; error: string } {
  switch (form.preset) {
    case "every15":
      return { ok: true, text: "every 15m", usesTimeZone: false };
    case "hourly":
      return { ok: true, text: "every 1h", usesTimeZone: false };
    case "custom": {
      const text = form.custom.trim();
      if (!text) return { ok: false, error: 'Enter "every 30m" or a 5-field cron expression such as 0 9 * * 1-5.' };
      return { ok: true, text, usesTimeZone: !/^every\s/i.test(text) };
    }
    default: {
      const t = splitTime(form.time);
      if (!t) return { ok: false, error: "Enter the time as HH:MM, for example 09:00." };
      const day = form.preset === "daily" ? "*" : form.preset === "weekdays" ? "1-5" : form.weekday;
      return { ok: true, text: `${t.minute} ${t.hour} * * ${day}`, usesTimeZone: true };
    }
  }
}

function everyText(ms: number): string {
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
  return `every ${Math.max(1, Math.round(ms / 1000))}s`;
}

const pad = (n: string): string => n.padStart(2, "0");

/** The form that reproduces `job.schedule`; schedules no preset covers open as "custom". */
export function formFromJob(job: Pick<CronJobView, "schedule">): ScheduleForm {
  const s = job.schedule;
  if (s.kind === "every") {
    if (s.ms === 900_000) return { ...DEFAULT_SCHEDULE_FORM, preset: "every15" };
    if (s.ms === 3_600_000) return { ...DEFAULT_SCHEDULE_FORM, preset: "hourly" };
    return { ...DEFAULT_SCHEDULE_FORM, preset: "custom", custom: everyText(s.ms) };
  }
  if (s.kind === "at") return { ...DEFAULT_SCHEDULE_FORM, preset: "custom", custom: s.at };
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(s.expr.trim());
  if (match) {
    const time = `${pad(match[2]!)}:${pad(match[1]!)}`;
    if (match[3] === "*") return { ...DEFAULT_SCHEDULE_FORM, preset: "daily", time };
    if (match[3] === "1-5") return { ...DEFAULT_SCHEDULE_FORM, preset: "weekdays", time };
    return { ...DEFAULT_SCHEDULE_FORM, preset: "weekly", time, weekday: match[3]! };
  }
  return { ...DEFAULT_SCHEDULE_FORM, preset: "custom", custom: s.expr };
}

/** "none" for no delivery; otherwise the chat key as typed. */
export const NO_DELIVERY = "none";
