// src/install/session.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { makeEngineFixture, type EngineFixture } from "../../test/install/helpers/engine";
import { versionPath } from "./layout";
import { tryLockVersionExclusive } from "./locks";
import { startNativeSession, type NativeSessionDeps } from "./session";
import { emptyState, readState, writeState } from "./state";

let f: EngineFixture;
afterEach(() => f?.close());

const deps = (extra: Partial<NativeSessionDeps> = {}): NativeSessionDeps => ({
  env: { HOME: f.home },
  execPath: versionPath(f.layout, "1.0.0"),
  print: false,
  stdinTTY: true,
  stdoutTTY: true,
  autoUpdates: true,
  version: "1.0.0",
  spawn: (() => ({ unref() {} })) as unknown as typeof Bun.spawn,
  ...extra,
});

describe("startNativeSession", () => {
  test("not native for dev runs", async () => {
    f = await makeEngineFixture();
    expect(await startNativeSession(deps({ execPath: "/usr/local/bin/bun" }))).toEqual({ kind: "not-native" });
  });

  test("holds the in-use lock so cleanup cannot remove the running version", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    const r = await startNativeSession(deps());
    expect(r).toMatchObject({ kind: "native", version: "1.0.0", holdsLock: true });
    expect(tryLockVersionExclusive(f.layout, "1.0.0")).toBeNull();
  });

  test("re-executes through ~/.local/bin/tropos when its binary was removed before it locked", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", link: "1.1.0" });
    await rm(versionPath(f.layout, "1.0.0"));
    expect(await startNativeSession(deps())).toEqual({ kind: "reexec", via: f.layout.binLink });
  });

  test("never re-executes twice", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.1.0"], current: "1.1.0", link: "1.1.0" });
    const r = await startNativeSession(deps({ env: { HOME: f.home, TROPOS_REEXEC: "1" } }));
    expect(r.kind).toBe("native");
  });

  test("announces an update once, then spawns a check when due", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    await writeState(f.layout, { ...emptyState(), current: "1.0.0", autoUpdate: { ...emptyState().autoUpdate, lastUpdated: "1.0.0", announced: false } });
    const spawned: string[][] = [];
    const spawn = ((cmd: string[]) => (spawned.push(cmd), { unref() {} })) as unknown as typeof Bun.spawn;
    const first = await startNativeSession(deps({ spawn }));
    expect(first).toMatchObject({ announcement: "Updated to 1.0.0", updateSpawned: true });
    expect(spawned).toEqual([[versionPath(f.layout, "1.0.0"), "update", "--background"]]);
    const read = await readState(f.layout);
    expect(read.kind === "ok" && read.state.autoUpdate.announced).toBe(true);
    expect(await startNativeSession(deps({ spawn }))).toMatchObject({ kind: "native", announcement: null });
  });

  test("print mode takes the lock but never spawns or announces", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    const r = await startNativeSession(deps({ print: true }));
    expect(r).toMatchObject({ kind: "native", holdsLock: true, announcement: null, updateSpawned: false });
  });
});
