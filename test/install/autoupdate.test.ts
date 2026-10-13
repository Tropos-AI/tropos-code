// test/install/autoupdate.test.ts
import { mkdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { runBackgroundUpdate } from "../../src/install/autoupdate";
import { installTarget } from "../../src/install/installer";
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
});
