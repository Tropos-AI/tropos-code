// src/install/autoupdate.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { CHECK_INTERVAL_MS, announcement, nextCheckAfter, shouldCheck, spawnBackgroundUpdate, type AutoUpdateInputs } from "./autoupdate";
import { ensureLayout, resolveLayout } from "./layout";
import { emptyState } from "./state";

const now = new Date("2026-10-13T12:00:00Z");
const base: AutoUpdateInputs = { env: {}, native: true, print: false, stdinTTY: true, stdoutTTY: true, autoUpdates: true, state: null, now };
const withNext = (iso: string | null) => ({ ...emptyState(), autoUpdate: { ...emptyState().autoUpdate, nextCheck: iso } });

describe("shouldCheck (spec §11)", () => {
  test("due on a native interactive session", () => {
    expect(shouldCheck(base)).toEqual({ check: true });
  });

  test.each([
    [{ native: false }, "not-native"],
    [{ print: true }, "print-mode"],
    [{ stdinTTY: false }, "not-a-terminal"],
    [{ stdoutTTY: false }, "not-a-terminal"],
    [{ env: { CI: "true" } }, "ci"],
    [{ env: { TROPOS_DISABLE_AUTOUPDATER: "1" } }, "disabled-by-env"],
    [{ autoUpdates: false }, "disabled-by-setting"],
    [{ state: withNext("2026-10-13T13:00:00.000Z") }, "not-due"],
  ])("%j → %s", (patch, reason) => {
    expect(shouldCheck({ ...base, ...(patch as Partial<AutoUpdateInputs>) })).toEqual({ check: false, reason });
  });

  test("CI=false does not disable", () => {
    expect(shouldCheck({ ...base, env: { CI: "false" } })).toEqual({ check: true });
  });

  test("treats a nextCheck more than 48 h ahead as due (clock moved back, Review Focus 4)", () => {
    expect(shouldCheck({ ...base, state: withNext("2026-10-20T12:00:00.000Z") })).toEqual({ check: true });
  });
});

describe("throttle and backoff", () => {
  test("6 h, then 12 h, 24 h, capped at 48 h", () => {
    const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
    expect(nextCheckAfter(now, 0)).toEqual(h(6));
    expect(nextCheckAfter(now, 1)).toEqual(h(12));
    expect(nextCheckAfter(now, 2)).toEqual(h(24));
    expect(nextCheckAfter(now, 3)).toEqual(h(48));
    expect(nextCheckAfter(now, 9)).toEqual(h(48));
    expect(CHECK_INTERVAL_MS).toBe(6 * 3_600_000);
  });
});

describe("announcement", () => {
  test("once after an update", () => {
    const s = { ...emptyState(), autoUpdate: { ...emptyState().autoUpdate, lastUpdated: "1.2.0", announced: false } };
    expect(announcement(s)).toBe("Updated to 1.2.0");
    expect(announcement({ ...s, autoUpdate: { ...s.autoUpdate, announced: true } })).toBeNull();
  });
});

describe("spawnBackgroundUpdate", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(() => removeDir(dir));

  test("returns at once and gives the child only the allow-listed environment (credential isolation)", async () => {
    const l = resolveLayout({ HOME: dir });
    await ensureLayout(l);
    const fake = join(dir, "fake-tropos");
    await writeFile(fake, `#!/bin/sh\nsleep 1\necho "$@" > "${dir}/args"\nenv > "${dir}/env"\n`);
    await chmod(fake, 0o755);
    const t0 = Date.now();
    expect(spawnBackgroundUpdate(fake, l, { ...process.env, HOME: dir, ANTHROPIC_API_KEY: "secret", GITHUB_TOKEN: "secret", OPENAI_API_KEY: "secret" })).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
    for (let i = 0; i < 50 && !(await Bun.file(join(dir, "env")).exists()); i++) await Bun.sleep(100);
    expect((await readFile(join(dir, "args"), "utf8")).trim()).toBe("update --background");
    const env = await readFile(join(dir, "env"), "utf8");
    expect(env).toContain(`HOME=${dir}`);
    expect(env).not.toContain("ANTHROPIC_API_KEY");
    expect(env).not.toContain("GITHUB_TOKEN");
    expect(env).not.toContain("OPENAI_API_KEY");
  });
});
