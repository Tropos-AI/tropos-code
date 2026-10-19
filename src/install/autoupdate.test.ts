// src/install/autoupdate.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { CHECK_INTERVAL_MS, announcement, nextCheckAfter, shouldCheck, spawnBackgroundUpdate, startDueGatewayUpdate, type AutoUpdateInputs } from "./autoupdate";
import { ensureLayout, resolveLayout } from "./layout";
import { emptyState, writeState } from "./state";

const now = new Date("2026-10-13T12:00:00Z");
const base: AutoUpdateInputs = { env: {}, native: true, print: false, stdinTTY: true, stdoutTTY: true, autoUpdates: true, state: null, now };
const withNext = (iso: string | null) => ({ ...emptyState(), autoUpdate: { ...emptyState().autoUpdate, nextCheck: iso } });

describe("shouldCheck", () => {
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
    const s = { ...emptyState(), current: "1.2.0", autoUpdate: { ...emptyState().autoUpdate, lastUpdated: "1.2.0", announced: false } };
    expect(announcement(s)).toBe("Updated to 1.2.0");
    expect(announcement({ ...s, autoUpdate: { ...s.autoUpdate, announced: true } })).toBeNull();
  });

  test("never for an older update once a newer version was installed by hand", () => {
    const s = { ...emptyState(), current: "1.3.0", autoUpdate: { ...emptyState().autoUpdate, lastUpdated: "1.2.0", announced: false } };
    expect(announcement(s)).toBeNull();
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
    // Publish env by rename: `env > file` creates the file before writing it, so polling for existence could read it empty.
    await writeFile(fake, `#!/bin/sh\nsleep 1\necho "$@" > "${dir}/args"\nenv > "${dir}/env.tmp"\nmv "${dir}/env.tmp" "${dir}/env"\n`);
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

describe("the gateway's update check", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(() => removeDir(dir));

  test("shouldCheck: the gateway has no terminal but checks like a session would; the other rules still hold", () => {
    const gateway = { ...base, stdinTTY: false, stdoutTTY: false, gateway: true };
    expect(shouldCheck(gateway)).toEqual({ check: true });
    expect(shouldCheck({ ...gateway, autoUpdates: false })).toEqual({ check: false, reason: "disabled-by-setting" });
    expect(shouldCheck({ ...gateway, env: { TROPOS_DISABLE_AUTOUPDATER: "1" } })).toEqual({ check: false, reason: "disabled-by-env" });
    expect(shouldCheck({ ...gateway, state: withNext("2026-10-13T13:00:00.000Z") })).toEqual({ check: false, reason: "not-due" });
  });

  test("starts the background update when due on a managed install; never for a local build, when off, or when not due", async () => {
    const layout = resolveLayout({ HOME: dir });
    await ensureLayout(layout);
    const spawned: string[][] = [];
    const spawn = ((cmd: string[]) => (spawned.push(cmd), { unref() {} })) as unknown as typeof Bun.spawn;
    const d = { env: { HOME: dir }, execPath: join(dir, "tcode-bin"), layout, autoUpdates: true, version: "1.2.0", now: () => now, spawn };
    // No manifest: an unmanaged local build, which background updates would replace with a release.
    expect(await startDueGatewayUpdate(d)).toBe(false);
    await mkdir(join(layout.manifests, "1.2.0"), { recursive: true });
    await writeFile(join(layout.manifests, "1.2.0", "manifest.json"), "{}");
    expect(await startDueGatewayUpdate({ ...d, autoUpdates: false })).toBe(false);
    expect(spawned).toEqual([]);
    expect(await startDueGatewayUpdate(d)).toBe(true);
    expect(spawned).toEqual([[join(dir, "tcode-bin"), "update", "--background"]]);
    await writeState(layout, withNext("2026-10-13T13:00:00.000Z"));
    expect(await startDueGatewayUpdate(d)).toBe(false);
  });
});
