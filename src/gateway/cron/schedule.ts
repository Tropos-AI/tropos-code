// src/gateway/cron/schedule.ts — schedules and their next run times.
import { z } from "zod";

export type Schedule = { kind: "cron"; expr: string; tz?: string } | { kind: "every"; ms: number } | { kind: "at"; at: string };

export const MIN_INTERVAL_MS = 60_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

export class ScheduleError extends Error {}

// --- cron expressions ---

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Field {
  set: Set<number>;
  star: boolean;
}

interface Parsed {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

function parseValue(text: string, names: string[] | undefined, offset: number, label: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const idx = names ? names.indexOf(text.toLowerCase()) : -1;
  if (idx < 0) throw new ScheduleError(`bad ${label} value "${text}"`);
  return idx + offset;
}

function parseField(text: string, min: number, max: number, label: string, names?: string[], nameOffset = 0): Field {
  const set = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") throw new ScheduleError(`empty item in ${label} field`);
    const [range = "", stepText, extra] = item.split("/");
    if (extra !== undefined || (stepText !== undefined && !/^\d+$/.test(stepText))) throw new ScheduleError(`bad step in ${label} field "${item}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new ScheduleError(`step must be at least 1 in ${label} field`);
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a = "", b = "", more] = range.split("-");
      if (more !== undefined) throw new ScheduleError(`bad range "${range}" in ${label} field`);
      lo = parseValue(a, names, nameOffset, label);
      hi = parseValue(b, names, nameOffset, label);
    } else {
      lo = parseValue(range, names, nameOffset, label);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new ScheduleError(`${label} value out of range (${min}-${max}) in "${item}"`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, star: text.startsWith("*") || text.startsWith("?") };
}

function parseCron(expr: string): Parsed {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError(`a cron expression has 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  // Day of week allows 0-7, both Sunday: 7 is folded into 0 after parsing.
  const dowField = parseField(dow, 0, 7, "day-of-week", DAYS);
  if (dowField.set.delete(7)) dowField.set.add(0);
  return {
    minute: parseField(m, 0, 59, "minute"),
    hour: parseField(h, 0, 23, "hour"),
    dom: parseField(dom, 1, 31, "day-of-month"),
    month: parseField(mon, 1, 12, "month", MONTHS, 1),
    dow: dowField,
  };
}

// --- time zones ---

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      throw new ScheduleError(`unknown time zone "${tz}"`);
    }
    formatters.set(tz, f);
  }
  return f;
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Offset of `tz` from UTC at an instant, in minutes (local = utc + offset). */
function offsetMinutes(tz: string, utcMs: number): number {
  const second = Math.floor(utcMs / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(second)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const local = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((local - second) / MINUTE);
}

/**
 * The instant a wall-clock time (given as its UTC-labelled milliseconds) happens in `tz`, for a day whose offset may change.
 * An ambiguous time (clocks go back) gives the first occurrence; a skipped one (clocks go forward) gives the moment the clocks jump.
 */
function wallToUtc(tz: string, wall: number, before: number, after: number): number {
  const valid = [...new Set([before, after])].filter((o) => offsetMinutes(tz, wall - o * MINUTE) === o).map((o) => wall - o * MINUTE);
  if (valid.length > 0) return Math.min(...valid);
  // In a gap: find the first minute already on the later offset.
  let lo = wall - after * MINUTE;
  let hi = wall - before * MINUTE;
  if (lo > hi) [lo, hi] = [hi, lo];
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / MINUTE / 2) * MINUTE;
    if (offsetMinutes(tz, mid) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** A wall-clock time in a zone as an instant. */
export function zonedTimeToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  return wallToUtc(tz, wall, offsetMinutes(tz, wall - 15 * 3_600_000), offsetMinutes(tz, wall + 15 * 3_600_000));
}

function dayMatches(p: Parsed, m: number, d: number, dow: number): boolean {
  if (!p.month.set.has(m)) return false;
  const domOk = p.dom.set.has(d);
  const dowOk = p.dow.set.has(dow);
  // Standard cron: when both day fields are restricted a day matches if either does.
  if (!p.dom.star && !p.dow.star) return domOk || dowOk;
  return domOk && dowOk;
}

function nextCron(s: { expr: string; tz?: string }, after: number): number | null {
  const p = parseCron(s.expr);
  const tz = s.tz ?? systemTimeZone();
  formatter(tz);
  const minutes = [...p.minute.set].sort((a, b) => a - b);
  const hours = [...p.hour.set].sort((a, b) => a - b);
  const local = new Date(after + offsetMinutes(tz, after) * MINUTE);
  let day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - DAY;
  // A Feb 29 schedule needs up to eight years of days to find a leap year across century gaps.
  for (let i = 0; i < 366 * 8; i++, day += DAY) {
    const date = new Date(day);
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!dayMatches(p, m, d, date.getUTCDay())) continue;
    const before = offsetMinutes(tz, day - 15 * 3_600_000);
    const afterOff = offsetMinutes(tz, day + 39 * 3_600_000);
    let best: number | null = null;
    for (const h of hours) {
      for (const mi of minutes) {
        const wall = day + h * 3_600_000 + mi * MINUTE;
        const utc = before === afterOff ? wall - before * MINUTE : wallToUtc(tz, wall, before, afterOff);
        if (utc > after && (best === null || utc < best)) best = utc;
      }
      // Hours ascend, so once a later hour has a candidate on a stable-offset day no earlier one can beat it.
      if (best !== null && before === afterOff) break;
    }
    if (best !== null) return best;
  }
  return null;
}

/** The first run strictly after `after`, or null when there is none (a one-shot in the past). */
export function nextRun(schedule: Schedule, after: Date): Date | null {
  const t = after.getTime();
  switch (schedule.kind) {
    case "every":
      return new Date(t + schedule.ms);
    case "at": {
      const at = Date.parse(schedule.at);
      return at > t ? new Date(at) : null;
    }
    case "cron": {
      const next = nextCron(schedule, t);
      return next === null ? null : new Date(next);
    }
  }
}

/** When a schedule first runs, counting from `from`. A one-shot keeps its own time even when that is already past, so a late start can still catch it. */
export function firstRun(schedule: Schedule, from: number): number | undefined {
  if (schedule.kind === "at") return Date.parse(schedule.at);
  return nextRun(schedule, new Date(from))?.getTime();
}

/** Throws ScheduleError when the schedule can't run as written. */
export function validateSchedule(s: Schedule): Schedule {
  if (s.kind === "cron") {
    parseCron(s.expr);
    if (s.tz !== undefined) formatter(s.tz);
  } else if (s.kind === "every") {
    if (!Number.isFinite(s.ms) || s.ms < MIN_INTERVAL_MS) throw new ScheduleError("an interval must be at least 1 minute");
  } else if (Number.isNaN(Date.parse(s.at))) {
    throw new ScheduleError(`"${s.at}" is not a date`);
  }
  return s;
}

export const scheduleSchema: z.ZodType<Schedule> = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("cron"), expr: z.string().min(1), tz: z.string().optional() }),
    z.object({ kind: z.literal("every"), ms: z.number().int().min(MIN_INTERVAL_MS, "an interval must be at least 1 minute") }),
    z.object({ kind: z.literal("at"), at: z.string().min(1) }),
  ])
  .superRefine((s, ctx) => {
    try {
      validateSchedule(s);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
    }
  });

// --- human schedules ---

const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE, h: 3_600_000, d: DAY };

function duration(text: string): number | null {
  const m = /^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2]![0]!.toLowerCase()]!;
}

function clock(text: string): { h: number; mi: number } | null {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(text.trim()) ?? /^(\d{1,2})()\s*(am|pm)$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "pm" ? 12 : 0);
  }
  return h > 23 || mi > 59 ? null : { h, mi };
}

/**
 * Turns "every 30m", "every day at 09:00", "every weekday at 9:30", "0 9 * * 1-5", "in 20m" or "at 2026-10-20T10:00"
 * into a schedule. A date with no zone is read in `tz` (the system zone by default).
 */
export function parseHumanSchedule(text: string, opts: { now?: number; tz?: string } = {}): Schedule {
  const raw = text.trim().replace(/\s+/g, " ");
  const lower = raw.toLowerCase();
  const fail = (): never => {
    throw new ScheduleError(`can't read schedule "${text}". Try "every 30m", "every day at 09:00", "in 20m", "at 2026-10-20T10:00" or a 5-field cron expression.`);
  };
  if (raw.split(" ").length === 5 && !/^(every|in|at)\b/.test(lower)) {
    return validateSchedule({ kind: "cron", expr: raw, ...(opts.tz ? { tz: opts.tz } : {}) });
  }
  let m = /^every (.+)$/.exec(lower);
  if (m) {
    const body = m[1]!;
    const ms = duration(body) ?? (body === "hour" ? 3_600_000 : body === "minute" ? MINUTE : null);
    if (ms !== null) return validateSchedule({ kind: "every", ms });
    const at = /^(day|weekday|weekend|[a-z]+?)s? at (.+)$/.exec(body);
    const time = at ? clock(at[2]!) : null;
    if (at && time) {
      const who = at[1]!;
      const named = DAYS.findIndex((d) => who.length >= 3 && who.startsWith(d));
      const dow = who === "day" ? "*" : who === "weekday" ? "1-5" : who === "weekend" ? "0,6" : named >= 0 ? String(named) : null;
      if (dow !== null) return validateSchedule({ kind: "cron", expr: `${time.mi} ${time.h} * * ${dow}`, ...(opts.tz ? { tz: opts.tz } : {}) });
    }
    return fail();
  }
  m = /^in (.+)$/.exec(lower);
  if (m) {
    const ms = duration(m[1]!);
    if (ms === null || ms <= 0) return fail();
    return { kind: "at", at: new Date((opts.now ?? Date.now()) + ms).toISOString() };
  }
  m = /^at (.+)$/i.exec(raw);
  if (m) return { kind: "at", at: parseDateTime(m[1]!, opts.tz) ?? fail() };
  return fail();
}

function parseDateTime(text: string, tz?: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  if (m[7]) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}${m[7].toUpperCase()}`);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return new Date(zonedTimeToUtc(tz ?? systemTimeZone(), y, mo, d, h, mi) + sec * 1000).toISOString();
}
