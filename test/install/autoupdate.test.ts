// test/install/autoupdate.test.ts
import { appendFile, chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { runBackgroundUpdate } from "../../src/install/autoupdate";
import { installTarget } from "../../src/install/installer";
import { versionPath } from "../../src/install/layout";
import { readLink } from "../../src/install/link";
import { acquireInstallLock } from "../../src/install/locks";
import { writeState } from "../../src/install/state";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());
const now = new Date("2026-10-13T12:00:00Z");

describe("runBackgroundUpdate (spec §11, layer 10)", () => {
  test("installs a newer version and records it for the announcement", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "latest", "1.1.0\n");
    await runBackgroundUpdate(f.deps, "latest");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.1.0" });
    expect((await f.state()).autoUpdate).toEqual({ lastCheck: now.toISOString(), failures: 0, nextCheck: "2026-10-13T18:00:00.000Z", lastUpdated: "1.1.0", announced: false });
  });

  test("a network failure only backs off", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await runBackgroundUpdate({ ...f.deps, fetch: async () => { throw new Error("offline"); } }, "latest");
    expect((await f.state()).current).toBe("1.0.0");
    expect((await f.state()).autoUpdate).toMatchObject({ failures: 1, nextCheck: "2026-10-14T00:00:00.000Z" });
  });

  test("never downgrades and never installs a skipped version", async () => {
    f = await makeEngineFixture({ now: () => now });
    for (const v of ["0.9.0", "1.0.0", "1.1.0"]) await f.release(v);
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "stable", "0.9.0\n");
    await runBackgroundUpdate(f.deps, "stable");
    expect((await f.state()).current).toBe("1.0.0");
    await writeState(f.layout, { ...(await f.state()), skip: { "1.1.0": "rolled-back" } });
    f.srv.put("channels", "latest", "1.1.0\n");
    await runBackgroundUpdate(f.deps, "latest");
    expect((await f.state()).current).toBe("1.0.0");
  });

  test("channel above current: stays (R9.3)", async () => {
    f = await makeEngineFixture({ now: () => now });
    for (const v of ["1.0.0", "1.1.0"]) await f.release(v);
    await installTarget(f.deps, "1.1.0", false);
    f.srv.put("channels", "stable", "1.0.0\n");
    await runBackgroundUpdate(f.deps, "stable");
    expect((await f.state()).current).toBe("1.1.0");
  });

  test("does not wait for a busy install lock and changes nothing", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    const before = await f.state();
    const held = (await acquireInstallLock(f.layout, { wait: false, version: "x" }))!;
    await runBackgroundUpdate(f.deps, "latest");
    held.release();
    expect(await f.state()).toEqual(before);
  });

  test("an unreadable state file never makes it reject", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await rm(f.layout.stateFile, { force: true });
    await mkdir(f.layout.stateFile);
    await expect(runBackgroundUpdate(f.deps, "latest")).resolves.toBeUndefined();
  });

  test("a throwing log sink neither rejects nor stops the update", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "latest", "1.1.0\n");
    await expect(runBackgroundUpdate({ ...f.deps, log: () => { throw new Error("sink"); } }, "latest")).resolves.toBeUndefined();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.1.0" });
  });

  test("a non-Error rejection still resolves and records the backoff", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await expect(runBackgroundUpdate({ ...f.deps, fetch: async () => { throw undefined; } }, "latest")).resolves.toBeUndefined();
    expect((await f.state()).autoUpdate.failures).toBe(1);
  });

  test("a throwing clock never makes it reject", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await expect(runBackgroundUpdate({ ...f.deps, now: () => { throw new Error("clock"); } }, "latest")).resolves.toBeUndefined();
  });

  test.each([
    ["a null-prototype object", () => Object.create(null)],
    ["an object whose toString throws", () => ({ toString() { throw new Error("x"); } })],
  ])("pathological rejection value (%s) still resolves", async (_n, make) => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await expect(runBackgroundUpdate({ ...f.deps, fetch: async () => { throw make(); } }, "latest")).resolves.toBeUndefined();
  });
});

describe("background updates never act on what they must not touch (I1, I3, A11)", () => {
  test("a dev 0.4.0 local build with latest 0.3.1: nothing changes, nothing is installed", async () => {
    const lines: string[] = [];
    f = await makeEngineFixture({ now: () => now, log: (line) => void lines.push(line) });
    await f.release("0.3.1");
    await writeFile(versionPath(f.layout, "0.4.0"), "#!/bin/sh\necho local\n");
    await chmod(versionPath(f.layout, "0.4.0"), 0o755);
    await symlink(versionPath(f.layout, "0.4.0"), f.layout.binLink);
    f.srv.put("channels", "latest", "0.3.1\n");
    await runBackgroundUpdate({ ...f.deps, runningVersion: "0.4.0" }, "latest");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "0.4.0" });
    expect(await readdir(f.layout.versions)).toEqual(["0.4.0"]);
    expect(lines.some((l) => l.includes("unmanaged local build"))).toBe(true);
  });

  test("an unmanaged running build is skipped even when the channel is ahead of it", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("0.5.0");
    await writeFile(versionPath(f.layout, "0.4.0"), "#!/bin/sh\necho local\n");
    await chmod(versionPath(f.layout, "0.4.0"), 0o755);
    await symlink(versionPath(f.layout, "0.4.0"), f.layout.binLink);
    f.srv.put("channels", "latest", "0.5.0\n");
    await runBackgroundUpdate({ ...f.deps, runningVersion: "0.4.0" }, "latest");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "0.4.0" });
    expect(f.srv.requests.some((r) => r.includes("0.5.0"))).toBe(false);
  });

  test("a fatal recovery stops the run: logged, nothing installed, link left in place, backoff recorded", async () => {
    const lines: string[] = [];
    f = await makeEngineFixture({ now: () => now, log: (line) => void lines.push(line) });
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    await appendFile(versionPath(f.layout, "1.0.0"), "damage");
    await f.release("1.1.0");
    f.srv.put("channels", "latest", "1.1.0\n");
    await runBackgroundUpdate(f.deps, "latest");
    expect(await readdir(f.layout.versions)).toEqual(["1.0.0"]);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(lines).toContain("background update failed: no verified Tropos version is installed; reinstall with install.sh");
    expect((await f.state()).autoUpdate.failures).toBe(1);
  });

  test("every recovery action is logged, not only fatal ones", async () => {
    const lines: string[] = [];
    f = await makeEngineFixture({ now: () => now, log: (line) => void lines.push(line) });
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.0.0", link: "1.1.0" });
    f.srv.put("channels", "latest", "1.1.0\n");
    await runBackgroundUpdate(f.deps, "latest");
    expect(lines).toContain(`recovery: adopted 1.1.0, which ${f.layout.binLink} points to`);
  });

  test("a health check that cannot run neither installs nor skips the release", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "latest", "1.1.0\n");
    await runBackgroundUpdate({ ...f.deps, health: async (b, v) => (v === "1.1.0" ? "unknown" : f.deps.health(b, v)) }, "latest");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", skip: {} });
    expect((await f.state()).autoUpdate.failures).toBe(1);
  });
});
