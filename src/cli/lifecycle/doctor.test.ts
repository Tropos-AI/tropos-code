import { afterEach, describe, expect, test } from "bun:test";
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { fakeRunner, makeFixture, type Fixture } from "../../doctor/testing";
import type { Check } from "../../doctor/types";
import doctorRun, { runDoctorCommand } from "./doctor";
import type { LifecycleContext } from "./types";

let fx: Fixture;
afterEach(() => fx?.close());

export function fakeContext(over: Partial<LifecycleContext> = {}): LifecycleContext & { stdout: string; stderr: string; asked: string[] } {
  const ctx = {
    stdout: "",
    stderr: "",
    asked: [] as string[],
    out(t: string) { ctx.stdout += t; },
    err(t: string) { ctx.stderr += t; },
    env: { PATH: "" } as NodeJS.ProcessEnv,
    cwd: "/",
    home: "/nonexistent-tropos",
    userHome: "/nonexistent-user",
    execPath: "/bin/bun",
    version: "9.9.9",
    interactive: false,
    async confirm(q: string, d = false) { ctx.asked.push(q); return d; },
    async prompt() { return ""; },
    now: () => Date.UTC(2026, 9, 15),
    ...over,
  };
  return ctx as never;
}

const ctxFor = (over: Partial<LifecycleContext> = {}) => fakeContext({ env: { ...fx.env }, home: fx.home, userHome: fx.userHome, cwd: fx.root, ...over });
const check = (level: "ok" | "warn" | "error", extra: Partial<Check> = {}, fixable = false): Check => ({
  id: "t.one",
  area: "demo",
  title: "demo",
  run: async () => [{ id: "t.one", level, message: `a ${level} thing`, fixable, safe: fixable }],
  ...extra,
});

describe("usage", () => {
  test("--help prints and exits 0", async () => {
    const ctx = fakeContext();
    expect(await doctorRun(["--help"], ctx)).toBe(0);
    expect(ctx.stdout).toContain("tcode doctor");
  });
  test.each([[["--bogus"]], [["extra"]], [["--lint", "--fix"]], [["--strict"]], [["--yes"]], [["--only"]]])("%j is a usage error (64)", async (argv) => {
    const ctx = fakeContext();
    expect(await runDoctorCommand(argv, ctx)).toBe(64);
    expect(ctx.stderr).toContain("tcode doctor");
  });
  test("--only with no match is a usage error", async () => {
    fx = await makeFixture();
    const ctx = ctxFor();
    expect(await runDoctorCommand(["--only", "nothing"], ctx, { checks: [check("ok")] })).toBe(64);
  });
});

describe("report and exit codes", () => {
  test("groups by area with marks, and exits 0 when no error remains", async () => {
    fx = await makeFixture();
    const ctx = ctxFor();
    expect(await runDoctorCommand([], ctx, { checks: [check("warn")] })).toBe(0);
    expect(ctx.stdout).toContain("demo\n  ! a warn thing");
    expect(ctx.stdout).toContain("1 warning");
  });
  test("an error exits 1", async () => {
    fx = await makeFixture();
    const ctx = ctxFor();
    expect(await runDoctorCommand([], ctx, { checks: [check("error")] })).toBe(1);
    expect(ctx.stdout).toContain("✖ a error thing");
  });
  test("--lint exits 2 on warnings only with --strict", async () => {
    fx = await makeFixture();
    expect(await runDoctorCommand(["--lint"], ctxFor(), { checks: [check("warn")] })).toBe(0);
    expect(await runDoctorCommand(["--lint", "--strict"], ctxFor(), { checks: [check("warn")] })).toBe(2);
    expect(await runDoctorCommand(["--lint", "--strict"], ctxFor(), { checks: [check("error")] })).toBe(1);
    expect(await runDoctorCommand(["--lint"], ctxFor(), { checks: [check("ok")] })).toBe(0);
  });
  test("--json prints the report without internal data", async () => {
    fx = await makeFixture();
    const ctx = ctxFor();
    await runDoctorCommand(["--json"], ctx, { checks: [check("warn", { run: async () => [{ id: "t", level: "warn", message: "m", data: { path: "/x" } }] })] });
    const out = JSON.parse(ctx.stdout);
    expect(out.summary.warn).toBe(1);
    expect(out.findings[0]).toMatchObject({ id: "t", area: "demo" });
    expect(out.findings[0].data).toBeUndefined();
  });
  test("a fixable problem points at --fix", async () => {
    fx = await makeFixture();
    const ctx = ctxFor();
    await runDoctorCommand([], ctx, { checks: [check("warn", {}, true)] });
    expect(ctx.stdout).toContain("[fixable]");
    expect(ctx.stdout).toContain("tcode doctor --fix");
  });
});

describe("--fix", () => {
  test("without a terminal only safe fixes run, and the rest are explained", async () => {
    fx = await makeFixture();
    const calls: string[] = [];
    const safe = check("warn", { id: "s", fix: async () => (calls.push("safe"), { ok: true, message: "ok" }) }, true);
    safe.run = async () => [{ id: "s", level: "warn", message: "safe one", fixable: true, safe: true }];
    const risky = check("warn", { id: "r", fix: async () => (calls.push("risky"), { ok: true, message: "ok" }) }, true);
    risky.run = async () => [{ id: "r", level: "warn", message: "risky one", fixable: true, safe: false }];
    const ctx = ctxFor();
    expect(await runDoctorCommand(["--fix"], ctx, { checks: [safe, risky] })).toBe(0);
    expect(calls).toEqual(["safe"]);
    expect(ctx.stdout).toContain("add --yes");
  });
  test("--yes applies every fix", async () => {
    fx = await makeFixture();
    const calls: string[] = [];
    const c = check("error", { fix: async () => (calls.push("x"), { ok: true, message: "repaired" }) });
    c.run = async () => [{ id: "t", level: "error", message: "broken", fixable: true, safe: false }];
    const ctx = ctxFor();
    expect(await runDoctorCommand(["--fix", "--yes"], ctx, { checks: [c] })).toBe(0);
    expect(calls).toEqual(["x"]);
    expect(ctx.stdout).toContain("(fixed: repaired)");
  });
  test("on a terminal each fix is confirmed; declining skips it and the error remains", async () => {
    fx = await makeFixture();
    const calls: string[] = [];
    const c = check("error", { fix: async () => (calls.push("x"), { ok: true, message: "r" }) });
    c.run = async () => [{ id: "t", level: "error", message: "broken", fixable: true }];
    const ctx = ctxFor({ interactive: true, confirm: async () => false });
    expect(await runDoctorCommand(["--fix"], ctx, { checks: [c] })).toBe(1);
    expect(calls).toEqual([]);
  });
  test("a real chmod fix on a throwaway home", async () => {
    fx = await makeFixture();
    const path = await fx.write("credentials.json", "{}", 0o644);
    await chmod(fx.home, 0o700);
    const ctx = ctxFor();
    await runDoctorCommand(["--fix", "--only", "permissions"], ctx, { runner: fakeRunner() });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(ctx.stdout).toContain("fixed");
  });
});

test("the default run uses the real checks against a throwaway home without touching it", async () => {
  fx = await makeFixture();
  const ctx = ctxFor();
  const code = await runDoctorCommand(["--lint", "--only", "settings"], ctx, { runner: fakeRunner() });
  expect(code).toBe(0);
  expect(ctx.stdout).toContain("settings");
  expect(await Bun.file(join(fx.home, "settings.json")).exists()).toBe(false);
});
