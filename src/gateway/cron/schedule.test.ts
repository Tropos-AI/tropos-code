import { describe, expect, test } from "bun:test";
import { nextRun, parseHumanSchedule, scheduleSchema, validateSchedule, type Schedule } from "./schedule";

const cron = (expr: string, tz = "UTC"): Schedule => ({ kind: "cron", expr, tz });
const next = (s: Schedule, after: string) => nextRun(s, new Date(after))?.toISOString() ?? null;

describe("cron expressions", () => {
  test("every minute and fixed times", () => {
    expect(next(cron("* * * * *"), "2026-01-01T00:00:30Z")).toBe("2026-01-01T00:01:00.000Z");
    expect(next(cron("0 9 * * *"), "2026-01-01T09:00:00Z")).toBe("2026-01-02T09:00:00.000Z");
    expect(next(cron("0 9 * * *"), "2026-01-01T08:59:59Z")).toBe("2026-01-01T09:00:00.000Z");
  });
  test("lists, ranges, steps", () => {
    expect(next(cron("*/15 * * * *"), "2026-01-01T10:16:00Z")).toBe("2026-01-01T10:30:00.000Z");
    expect(next(cron("5,10 1-2 * * *"), "2026-01-01T01:10:00Z")).toBe("2026-01-01T02:05:00.000Z");
    expect(next(cron("10-20/5 * * * *"), "2026-01-01T10:11:00Z")).toBe("2026-01-01T10:15:00.000Z");
    expect(next(cron("30/20 * * * *"), "2026-01-01T10:31:00Z")).toBe("2026-01-01T10:50:00.000Z");
  });
  test("names and Sunday as 0 or 7", () => {
    // 2026-01-04 is a Sunday
    expect(next(cron("0 12 * * sun"), "2026-01-01T00:00:00Z")).toBe("2026-01-04T12:00:00.000Z");
    expect(next(cron("0 12 * * 0"), "2026-01-01T00:00:00Z")).toBe("2026-01-04T12:00:00.000Z");
    expect(next(cron("0 12 * * 7"), "2026-01-01T00:00:00Z")).toBe("2026-01-04T12:00:00.000Z");
    expect(next(cron("0 0 1 MAR *"), "2026-01-01T00:00:00Z")).toBe("2026-03-01T00:00:00.000Z");
    expect(next(cron("0 0 * * mon-fri"), "2026-01-02T00:00:00Z")).toBe("2026-01-05T00:00:00.000Z");
  });
  test("day-of-month OR day-of-week when both are restricted", () => {
    // the 15th or any Friday; 2026-01-02 is a Friday
    expect(next(cron("0 0 15 * 5"), "2026-01-01T00:00:00Z")).toBe("2026-01-02T00:00:00.000Z");
    expect(next(cron("0 0 15 * 5"), "2026-01-09T00:00:00Z")).toBe("2026-01-15T00:00:00.000Z");
    // only one restricted: AND with the star
    expect(next(cron("0 0 15 * *"), "2026-01-01T00:00:00Z")).toBe("2026-01-15T00:00:00.000Z");
    expect(next(cron("0 0 */2 * 5"), "2026-01-01T00:00:00Z")).toBe("2026-01-09T00:00:00.000Z");
  });
  test("Feb 29 and day 31", () => {
    expect(next(cron("0 0 29 2 *"), "2026-01-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next(cron("0 0 31 * *"), "2026-04-01T00:00:00Z")).toBe("2026-05-31T00:00:00.000Z");
  });
  test("rejects bad expressions", () => {
    for (const e of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "a * * * *", "5-1 * * * *", "1,,2 * * * *", "* * * * 8"]) {
      expect(() => validateSchedule(cron(e))).toThrow();
    }
    expect(() => validateSchedule(cron("* * * * *", "Mars/Base"))).toThrow(/time zone/);
  });
});

describe("time zones", () => {
  const ny = (e: string) => cron(e, "America/New_York");
  test("plain offset", () => {
    expect(next(ny("0 9 * * *"), "2026-01-15T00:00:00Z")).toBe("2026-01-15T14:00:00.000Z");
    expect(next(ny("0 9 * * *"), "2026-07-15T00:00:00Z")).toBe("2026-07-15T13:00:00.000Z");
  });
  test("spring forward: a skipped local time runs when the clocks jump", () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT; 02:30 does not exist
    expect(next(ny("30 2 * * *"), "2026-03-08T00:00:00Z")).toBe("2026-03-08T07:00:00.000Z");
    // then back to normal the next day
    expect(next(ny("30 2 * * *"), "2026-03-08T07:00:00Z")).toBe("2026-03-09T06:30:00.000Z");
    // a job at 03:00 and a skipped one do not make a second run for the same instant
    expect(next(ny("0 3 * * *"), "2026-03-08T00:00:00Z")).toBe("2026-03-08T07:00:00.000Z");
  });
  test("spring forward: times around the gap keep their wall clock", () => {
    expect(next(ny("30 1 * * *"), "2026-03-08T00:00:00Z")).toBe("2026-03-08T06:30:00.000Z");
    expect(next(ny("30 3 * * *"), "2026-03-08T00:00:00Z")).toBe("2026-03-08T07:30:00.000Z");
  });
  test("fall back: an ambiguous time runs once, at its first occurrence", () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST; 01:30 happens twice (05:30Z and 06:30Z)
    const s = ny("30 1 * * *");
    const first = next(s, "2026-11-01T00:00:00Z");
    expect(first).toBe("2026-11-01T05:30:00.000Z");
    expect(next(s, first!)).toBe("2026-11-02T06:30:00.000Z");
  });
  test("fall back: every-15-minute jobs don't double up", () => {
    const s = ny("*/30 1 * * *");
    const seen: string[] = [];
    let at = new Date("2026-11-01T04:00:00Z");
    for (let i = 0; i < 4; i++) {
      at = nextRun(s, at)!;
      seen.push(at.toISOString());
    }
    expect(seen).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:00:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });
  test("Europe/Athens (UTC+2 / +3)", () => {
    const at = (e: string) => cron(e, "Europe/Athens");
    expect(next(at("0 9 * * *"), "2026-01-15T00:00:00Z")).toBe("2026-01-15T07:00:00.000Z");
    expect(next(at("0 9 * * *"), "2026-07-15T00:00:00Z")).toBe("2026-07-15T06:00:00.000Z");
    // 2026-03-29 03:00 EET -> 04:00 EEST; 03:30 is skipped
    expect(next(at("30 3 * * *"), "2026-03-29T00:00:00Z")).toBe("2026-03-29T01:00:00.000Z");
    // 2026-10-25 04:00 EEST -> 03:00 EET; 03:30 happens twice (00:30Z and 01:30Z)
    expect(next(at("30 3 * * *"), "2026-10-24T22:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
    expect(next(at("30 3 * * *"), "2026-10-25T00:30:00Z")).toBe("2026-10-26T01:30:00.000Z");
  });
  test("the zone decides the day", () => {
    // 23:30 UTC is already the next day in Athens
    expect(next(cron("0 0 * * *", "Europe/Athens"), "2026-01-15T23:30:00Z")).toBe("2026-01-16T22:00:00.000Z");
  });
});

describe("every and at", () => {
  test("every adds the interval", () => {
    expect(next({ kind: "every", ms: 300_000 }, "2026-01-01T00:00:00Z")).toBe("2026-01-01T00:05:00.000Z");
  });
  test("at is a one-shot", () => {
    const s: Schedule = { kind: "at", at: "2026-01-01T10:00:00Z" };
    expect(next(s, "2026-01-01T09:00:00Z")).toBe("2026-01-01T10:00:00.000Z");
    expect(next(s, "2026-01-01T10:00:00Z")).toBeNull();
  });
  test("minimum interval and schema", () => {
    expect(() => validateSchedule({ kind: "every", ms: 59_999 })).toThrow(/1 minute/);
    expect(scheduleSchema.safeParse({ kind: "every", ms: 1000 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: "at", at: "nope" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: "cron", expr: "*/5 * * * *" }).success).toBe(true);
  });
});

describe("parseHumanSchedule", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  test("intervals", () => {
    expect(parseHumanSchedule("every 30m")).toEqual({ kind: "every", ms: 1_800_000 });
    expect(parseHumanSchedule("Every 2 hours")).toEqual({ kind: "every", ms: 7_200_000 });
    expect(parseHumanSchedule("every 1d")).toEqual({ kind: "every", ms: 86_400_000 });
    expect(parseHumanSchedule("every hour")).toEqual({ kind: "every", ms: 3_600_000 });
    expect(() => parseHumanSchedule("every 30s")).toThrow(/1 minute/);
  });
  test("daily and weekly", () => {
    expect(parseHumanSchedule("every day at 09:00")).toEqual({ kind: "cron", expr: "0 9 * * *" });
    expect(parseHumanSchedule("every weekday at 9:30", { tz: "Europe/Athens" })).toEqual({ kind: "cron", expr: "30 9 * * 1-5", tz: "Europe/Athens" });
    expect(parseHumanSchedule("every monday at 6pm")).toEqual({ kind: "cron", expr: "0 18 * * 1" });
    expect(parseHumanSchedule("every weekend at 10:00")).toEqual({ kind: "cron", expr: "0 10 * * 0,6" });
  });
  test("cron expressions pass through", () => {
    expect(parseHumanSchedule("0 9 * * 1-5")).toEqual({ kind: "cron", expr: "0 9 * * 1-5" });
    expect(() => parseHumanSchedule("99 9 * * 1-5")).toThrow();
  });
  test("one-shots", () => {
    expect(parseHumanSchedule("in 20m", { now })).toEqual({ kind: "at", at: "2026-10-15T12:20:00.000Z" });
    expect(parseHumanSchedule("at 2026-10-20T10:00", { tz: "Europe/Athens" })).toEqual({ kind: "at", at: "2026-10-20T07:00:00.000Z" });
    expect(parseHumanSchedule("at 2026-10-20T10:00:00Z")).toEqual({ kind: "at", at: "2026-10-20T10:00:00.000Z" });
    expect(parseHumanSchedule("at 2026-10-20", { tz: "UTC" })).toEqual({ kind: "at", at: "2026-10-20T00:00:00.000Z" });
  });
  test("nonsense is refused", () => {
    for (const t of ["", "whenever", "every banana", "every day at 25:00", "in 0m", "at tomorrow", "every sunday at"]) {
      expect(() => parseHumanSchedule(t)).toThrow();
    }
  });
});
