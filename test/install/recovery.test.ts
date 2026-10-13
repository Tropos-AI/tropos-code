// test/install/recovery.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm, symlink, writeFile } from "node:fs/promises";
import { versionPath } from "../../src/install/layout";
import { readLink, switchLink } from "../../src/install/link";
import { lockVersionShared } from "../../src/install/locks";
import { emptyState, writeState } from "../../src/install/state";
import { withInstallLock } from "../../src/install/engine";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

describe("recovery (spec §10.6)", () => {
  test("nothing installed: nothing to do", async () => {
    f = await makeEngineFixture();
    expect(await f.recoverNow()).toEqual({ actions: [], fatal: null });
  });

  test("a local build linked by the old installer is left alone", async () => {
    f = await makeEngineFixture();
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await symlink(versionPath(f.layout, "0.1.0"), f.layout.binLink);
    expect(await f.recoverNow()).toEqual({ actions: [], fatal: null });
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "0.1.0" });
  });

  test("unreadable state is rebuilt from the symlink", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", link: "1.1.0" });
    await writeFile(f.layout.stateFile, '{"schema": 1, "gen');
    const r = await f.recoverNow();
    expect(r.actions[0]).toStartWith("install state was unreadable");
    expect(await f.state()).toMatchObject({ current: "1.1.0", previous: "1.0.0", pending: null });
  });

  test("interrupted first install with the link already switched: finish it", async () => {
    f = await makeEngineFixture();
    await f.direct("1.0.0");
    await switchLink(f.layout, "1.0.0");
    await writeState(f.layout, { ...emptyState(), pending: { op: "switch", from: null, to: "1.0.0" } });
    await f.recoverNow();
    expect(await f.state()).toMatchObject({ current: "1.0.0", pending: null });
  });

  test("interrupted first install before the switch: no link, clear message", async () => {
    f = await makeEngineFixture();
    await f.direct("1.0.0");
    await writeState(f.layout, { ...emptyState(), pending: { op: "switch", from: null, to: "1.0.0" } });
    const r = await f.recoverNow();
    expect(r.fatal).toBe("installation did not complete; run install.sh again");
    expect(await readLink(f.layout)).toEqual({ kind: "missing" });
    expect(await f.state()).toMatchObject({ current: null, pending: null });
  });

  test("interrupted first install never removes the user's old local-build link", async () => {
    f = await makeEngineFixture();
    await f.direct("1.0.0");
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await symlink(versionPath(f.layout, "0.1.0"), f.layout.binLink);
    await writeState(f.layout, { ...emptyState(), pending: { op: "switch", from: null, to: "1.0.0" } });
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "0.1.0" });
  });

  test("interrupted upgrade whose target is broken: back to from", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], link: "1.1.0" });
    await writeState(f.layout, { ...emptyState(), current: "1.0.0", pending: { op: "switch", from: "1.0.0", to: "1.1.0" } });
    await appendFile(versionPath(f.layout, "1.1.0"), "x");
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", pending: null });
  });

  test("symlink moved to another healthy managed version: adopted", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.0.0", link: "1.1.0" });
    await f.recoverNow();
    expect(await f.state()).toMatchObject({ current: "1.1.0", previous: "1.0.0" });
  });

  test("current deleted: first healthy fallback (R6.2)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", previous: "1.0.0", link: "1.1.0" });
    await rm(versionPath(f.layout, "1.1.0"));
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", previous: null });
  });

  test("current corrupted while a session runs it: link moves, file stays (R5.2)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", previous: "1.0.0", link: "1.1.0" });
    const session = (await lockVersionShared(f.layout, "1.1.0"))!;
    await appendFile(versionPath(f.layout, "1.1.0"), "corrupt");
    const before = await Bun.file(versionPath(f.layout, "1.1.0")).text();
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await Bun.file(versionPath(f.layout, "1.1.0")).text()).toBe(before);
    session.release();
  });

  test("previous corrupted: previous becomes null (R6.3)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", previous: "1.0.0", link: "1.1.0" });
    await appendFile(versionPath(f.layout, "1.0.0"), "x");
    await f.recoverNow();
    expect((await f.state()).previous).toBeNull();
  });

  test("no healthy candidate: our link is removed and the condition is fatal", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    await appendFile(versionPath(f.layout, "1.0.0"), "x");
    const r = await f.recoverNow();
    expect(r.fatal).toBe("no verified Tropos version is installed; reinstall with install.sh");
    expect(await readLink(f.layout)).toEqual({ kind: "missing" });
    expect((await f.state()).current).toBeNull();
  });

  test("the fallback tail skips versions that failed a health check here", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0"], current: "1.2.0", link: "1.2.0" });
    await writeState(f.layout, { ...(await f.state()), skip: { "1.1.0": "health-check" } });
    await rm(versionPath(f.layout, "1.2.0"));
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("a foreign link is never touched", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0" });
    await symlink("/usr/bin/true", f.layout.binLink);
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "foreign", target: "/usr/bin/true" });
  });

  test("finishing a pending switch records from as previous", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], link: "1.1.0" });
    await writeState(f.layout, { ...emptyState(), current: "1.0.0", pending: { op: "switch", from: "1.0.0", to: "1.1.0" } });
    await f.recoverNow();
    expect(await f.state()).toMatchObject({ current: "1.1.0", previous: "1.0.0", pending: null });
  });

  test("link to an unverifiable managed version: switched back to current", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.0.0", link: "1.1.0" });
    await appendFile(versionPath(f.layout, "1.1.0"), "x");
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0" });
  });

  test("dangling link: relinked to the healthy current", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0" });
    await symlink(versionPath(f.layout, "9.9.9"), f.layout.binLink);
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("missing state with a managed healthy link: state rebuilt", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], link: "1.1.0" });
    await rm(f.layout.stateFile);
    await f.recoverNow();
    expect(await f.state()).toMatchObject({ current: "1.1.0", previous: "1.0.0", pending: null });
  });

  test("corrupt state with a foreign symlink: untouched", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0" });
    await symlink("/usr/bin/true", f.layout.binLink);
    await writeFile(f.layout.stateFile, "{bad");
    const r = await f.recoverNow();
    expect(r.fatal).toBeNull();
    expect(await readLink(f.layout)).toEqual({ kind: "foreign", target: "/usr/bin/true" });
  });

  test("corrupt state with a regular file at the link path: untouched", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0" });
    await writeFile(f.layout.binLink, "user file");
    await writeFile(f.layout.stateFile, "{bad");
    await f.recoverNow();
    expect(await Bun.file(f.layout.binLink).text()).toBe("user file");
  });

  test("pending switch with a foreign link: link untouched, pending cleared", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.0.0" });
    await symlink("/usr/bin/true", f.layout.binLink);
    await writeState(f.layout, { ...emptyState(), current: "1.0.0", pending: { op: "switch", from: "1.0.0", to: "1.1.0" } });
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "foreign", target: "/usr/bin/true" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", pending: null });
  });

  test("corrupt state with a local-build link: link left alone", async () => {
    f = await makeEngineFixture();
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await symlink(versionPath(f.layout, "0.1.0"), f.layout.binLink);
    await writeFile(f.layout.stateFile, "{bad");
    const r = await f.recoverNow();
    expect(r.fatal).toBeNull();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "0.1.0" });
    expect(await f.state()).toMatchObject({ current: null, previous: null, pending: null });
  });

  test("pending switch: from damaged, a healthy to is activated", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], link: "1.0.0" });
    await writeState(f.layout, { ...emptyState(), current: "1.0.0", pending: { op: "switch", from: "1.0.0", to: "1.1.0" } });
    await appendFile(versionPath(f.layout, "1.0.0"), "x");
    const r = await f.recoverNow();
    expect(r.fatal).toBeNull();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.1.0" });
    expect(await f.state()).toMatchObject({ current: "1.1.0", pending: null });
  });
});

describe("withInstallLock", () => {
  test("releases the lock when fn throws", async () => {
    f = await makeEngineFixture();
    await expect(withInstallLock(f.deps, { wait: false }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withInstallLock(f.deps, { wait: false }, async () => 1)).toMatchObject({ value: 1 });
  });

  test("returns null when wait is false and the lock is held", async () => {
    f = await makeEngineFixture();
    let inner: unknown = "unset";
    await withInstallLock(f.deps, { wait: false }, async () => {
      inner = await withInstallLock(f.deps, { wait: false }, async () => 1);
    });
    expect(inner).toBeNull();
  });

  test("recovery runs before fn", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.0.0", link: "1.1.0" });
    const seen = await withInstallLock(f.deps, { wait: true }, async (s) => s.state.current);
    expect(seen!.value).toBe("1.1.0");
  });
});
