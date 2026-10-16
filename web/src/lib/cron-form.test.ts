import { describe, expect, test } from "bun:test";

import { DEFAULT_SCHEDULE_FORM, formFromJob, scheduleText } from "@/lib/cron-form";

describe("scheduleText", () => {
  test("presets map to every/cron text", () => {
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "every15" })).toEqual({ ok: true, text: "every 15m", usesTimeZone: false });
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "hourly" })).toEqual({ ok: true, text: "every 1h", usesTimeZone: false });
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "daily", time: "07:05" })).toEqual({ ok: true, text: "5 7 * * *", usesTimeZone: true });
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "weekdays", time: "18:30" })).toMatchObject({ text: "30 18 * * 1-5" });
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "weekly", time: "09:00", weekday: "0" })).toMatchObject({ text: "0 9 * * 0" });
  });

  test("custom passes text through and flags a missing value or a bad time", () => {
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "custom", custom: " every 30m " })).toEqual({ ok: true, text: "every 30m", usesTimeZone: false });
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "custom", custom: "0 9 * * 1-5" })).toMatchObject({ usesTimeZone: true });
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "custom", custom: " " }).ok).toBe(false);
    expect(scheduleText({ ...DEFAULT_SCHEDULE_FORM, preset: "daily", time: "25:00" }).ok).toBe(false);
  });
});

describe("formFromJob", () => {
  test("round-trips presets", () => {
    expect(formFromJob({ schedule: { kind: "every", ms: 900_000 } }).preset).toBe("every15");
    expect(formFromJob({ schedule: { kind: "every", ms: 3_600_000 } }).preset).toBe("hourly");
    expect(formFromJob({ schedule: { kind: "every", ms: 1_800_000 } })).toMatchObject({ preset: "custom", custom: "every 30m" });
    expect(formFromJob({ schedule: { kind: "cron", expr: "0 9 * * *" } })).toMatchObject({ preset: "daily", time: "09:00" });
    expect(formFromJob({ schedule: { kind: "cron", expr: "30 18 * * 1-5" } })).toMatchObject({ preset: "weekdays", time: "18:30" });
    expect(formFromJob({ schedule: { kind: "cron", expr: "0 8 * * 3" } })).toMatchObject({ preset: "weekly", weekday: "3", time: "08:00" });
    expect(formFromJob({ schedule: { kind: "cron", expr: "*/5 * * * *" } })).toMatchObject({ preset: "custom", custom: "*/5 * * * *" });
  });
});
