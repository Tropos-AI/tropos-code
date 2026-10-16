import { afterEach, describe, expect, test } from "bun:test";
import { runDoctor, selectChecks, summarize } from "./engine";
import { makeFixture, type Fixture } from "./testing";
import type { Check, Finding } from "./types";

let fx: Fixture;
afterEach(() => fx?.close());

const mk = (id: string, area: string, findings: Finding[], extra: Partial<Check> = {}): Check => ({ id, area, title: id, run: async () => findings.map((f) => ({ ...f })), ...extra });
const base = () => ({ home: fx.home, userHome: fx.userHome, env: fx.env });

describe("selectChecks", () => {
  const checks = [mk("a.one", "a", []), mk("a.two", "a", []), mk("b", "b", []), mk("sec", "security", [], { audit: true })];
  test("a plain run skips audit-only checks", () => {
    expect(selectChecks(checks, undefined).map((c) => c.id)).toEqual(["a.one", "a.two", "b"]);
  });
  test("matches an id, an area, or an id prefix", () => {
    expect(selectChecks(checks, "a.two").map((c) => c.id)).toEqual(["a.two"]);
    expect(selectChecks(checks, "a").map((c) => c.id)).toEqual(["a.one", "a.two"]);
    expect(selectChecks(checks, ["security", "b"]).map((c) => c.id)).toEqual(["b", "sec"]);
  });
});

describe("runDoctor", () => {
  test("tags findings with their area and sums them", async () => {
    fx = await makeFixture();
    const r = await runDoctor({
      ...base(),
      checks: [mk("c", "x", [{ id: "c.1", level: "ok", message: "m" }, { id: "c.2", level: "warn", message: "w" }, { id: "c.3", level: "error", message: "e" }])],
    });
    expect(r.findings.map((f) => f.area)).toEqual(["x", "x", "x"]);
    expect(r.summary).toEqual({ ok: 1, info: 0, warn: 1, error: 1, fixed: 0 });
  });

  test("a crashing check becomes an error finding instead of aborting", async () => {
    fx = await makeFixture();
    const bad: Check = { id: "bad", area: "x", title: "bad", run: async () => { throw new Error("boom"); } };
    const r = await runDoctor({ ...base(), checks: [bad, mk("ok", "x", [{ id: "ok", level: "ok", message: "fine" }])] });
    expect(r.findings[0]).toMatchObject({ id: "bad.crashed", level: "error", detail: "boom" });
    expect(r.summary.ok).toBe(1);
  });

  const fixable = (calls: string[], safe: boolean): Check =>
    mk("f", "x", [{ id: "f.1", level: "warn", message: "w", fixable: true, safe }], {
      fix: async (f) => {
        calls.push(f.id);
        return { ok: true, message: "done" };
      },
    });

  test("fixes run only with fix set; a fixed finding counts as fixed, not as a warning", async () => {
    fx = await makeFixture();
    const calls: string[] = [];
    const without = await runDoctor({ ...base(), checks: [fixable(calls, false)] });
    expect(calls).toEqual([]);
    expect(without.summary.warn).toBe(1);
    const withFix = await runDoctor({ ...base(), checks: [fixable(calls, false)], fix: true });
    expect(calls).toEqual(["f.1"]);
    expect(withFix.summary).toMatchObject({ warn: 0, fixed: 1 });
    expect(withFix.findings[0]).toMatchObject({ fixed: true, fixMessage: "done" });
  });

  test('fix "safe" skips fixes that are not marked safe', async () => {
    fx = await makeFixture();
    const calls: string[] = [];
    await runDoctor({ ...base(), checks: [fixable(calls, false)], fix: "safe" });
    await runDoctor({ ...base(), checks: [fixable(calls, true)], fix: "safe" });
    expect(calls).toEqual(["f.1"]);
  });

  test("confirm can decline a fix, and a throwing fix is reported not thrown", async () => {
    fx = await makeFixture();
    const calls: string[] = [];
    const declined = await runDoctor({ ...base(), checks: [fixable(calls, true)], fix: true, confirm: async () => false });
    expect(calls).toEqual([]);
    expect(declined.findings[0]!.fixed).toBeUndefined();
    const throwing = mk("t", "x", [{ id: "t", level: "error", message: "e", fixable: true }], { fix: async () => { throw new Error("nope"); } });
    const r = await runDoctor({ ...base(), checks: [throwing], fix: true });
    expect(r.findings[0]).toMatchObject({ fixed: false, fixMessage: "nope" });
    expect(r.summary.error).toBe(1);
  });
});

test("summarize ignores fixed findings in their level", () => {
  expect(summarize([{ id: "a", level: "error", message: "", fixed: true }, { id: "b", level: "info", message: "" }])).toEqual({ ok: 0, info: 1, warn: 0, error: 0, fixed: 1 });
});
