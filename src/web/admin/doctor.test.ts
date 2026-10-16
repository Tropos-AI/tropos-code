import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Check } from "../../doctor/types";
import { doctorHandlers } from "./doctor";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.close());

function checks(log: string[]): Check[] {
  return [
    {
      id: "t.safe",
      area: "t",
      title: "safe",
      run: async () => [{ id: "t.safe", level: "warn", message: "safe problem", detail: "tok 123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789 here", fixable: true, safe: true, data: { secret: "x" } }],
      fix: async () => (log.push("safe"), { ok: true, message: "done safe" }),
    },
    {
      id: "t.risky",
      area: "t",
      title: "risky",
      run: async () => [{ id: "t.risky", level: "error", message: "risky problem", fixable: true }, { id: "t.fine", level: "ok", message: "fine" }],
      fix: async () => (log.push("risky"), { ok: false, message: "could not" }),
    },
    { id: "u.plain", area: "u", title: "plain", run: async () => [{ id: "u.plain", level: "warn", message: "no fix" }] },
  ];
}

test("doctor.run maps findings (no data, secrets scrubbed) and summarises; only the safe fixes run with fix", async () => {
  const log: string[] = [];
  const admin = adminWith(kit, doctorHandlers(kit.ctx, { checks: checks(log) }));
  const plain = (await admin.handle("doctor.run", undefined)) as any;
  expect(plain.findings.map((f: any) => f.id)).toEqual(["t.safe", "t.risky", "t.fine", "u.plain"]);
  expect(plain.findings[0]).toMatchObject({ area: "t", level: "warn", fixable: true });
  expect(plain.findings[0].data).toBeUndefined();
  expect(plain.findings[0].detail).not.toContain("ABCdef");
  expect(plain.summary).toEqual({ ok: 1, info: 0, warn: 2, error: 1, fixed: 0 });
  expect(log).toEqual([]);

  const fixed = (await admin.handle("doctor.run", { fix: true })) as any;
  expect(log).toEqual(["safe"]);
  expect(fixed.findings[0].fixed).toBe(true);
  expect(fixed.summary.fixed).toBe(1);

  const only = (await admin.handle("doctor.run", { only: "u" })) as any;
  expect(only.findings.map((f: any) => f.id)).toEqual(["u.plain"]);
});

test("doctor.fix runs one finding's fix even when it is not safe", async () => {
  const log: string[] = [];
  const admin = adminWith(kit, doctorHandlers(kit.ctx, { checks: checks(log) }));
  expect(await admin.handle("doctor.fix", { id: "t.risky" })).toEqual({ ok: false, message: "could not" });
  expect(log).toEqual(["risky"]);
  expect(await admin.handle("doctor.fix", { id: "t.safe" })).toEqual({ ok: true, message: "done safe" });
  expect(log).toEqual(["risky", "safe"]);
  expect(await admin.handle("doctor.fix", { id: "u.plain" })).toMatchObject({ ok: false });
  expect(await failure(admin, "doctor.fix", { id: "nope" })).toContain("nope");
  expect(await failure(admin, "doctor.fix", {})).toContain("which finding");
});
