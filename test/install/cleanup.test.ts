// test/install/cleanup.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "../../src/install/cleanup";
import { withInstallLock } from "../../src/install/engine";
import { versionPath } from "../../src/install/layout";
import { lockVersionShared } from "../../src/install/locks";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

const runCleanup = async (now?: Date) => (await withInstallLock(now ? { ...f.deps, now: () => now } : f.deps, { wait: true }, (s) => cleanup(s)))!.value;

describe("cleanup (spec §10.5)", () => {
  test("keeps current, previous and the 3 newest verified; removes the rest with their manifests", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"], current: "1.2.0", previous: "1.0.0", link: "1.2.0" });
    expect(await runCleanup()).toEqual(["1.1.0"]);
    expect((await readdir(f.layout.versions)).sort()).toEqual(["1.0.0", "1.2.0", "1.3.0", "1.4.0"]);
    expect((await readdir(f.layout.manifests)).sort()).toEqual(["1.0.0", "1.2.0", "1.3.0", "1.4.0"]);
  });

  test("never deletes a version a session is running (R5.4)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"], current: "1.4.0", previous: "1.3.0", link: "1.4.0" });
    const session = (await lockVersionShared(f.layout, "1.0.0"))!;
    expect(await runCleanup()).toEqual(["1.1.0"]);
    session.release();
    expect(await runCleanup()).toEqual(["1.0.0"]);
  });

  test("an entry it cannot remove (a directory at versions/<v>) is logged and skipped; the rest is still cleaned", async () => {
    const lines: string[] = [];
    f = await makeEngineFixture({ log: (line) => void lines.push(line) });
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"], current: "1.4.0", previous: "1.3.0", link: "1.4.0" });
    await rm(versionPath(f.layout, "1.0.0"));
    await mkdir(versionPath(f.layout, "1.0.0"));
    await writeFile(join(versionPath(f.layout, "1.0.0"), "inside"), "x");
    expect(await runCleanup()).toEqual(["1.1.0"]);
    expect(lines.some((l) => l.startsWith("cleanup: could not remove 1.0.0:"))).toBe(true);
    expect(await readdir(versionPath(f.layout, "1.0.0"))).toEqual(["inside"]);
  });

  test("never deletes unmanaged versions (Review Focus 3)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"], current: "1.3.0", link: "1.3.0" });
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await writeFile(join(f.layout.versions, ".unmanaged-0.0.9-1"), "old local build");
    expect(await runCleanup()).toEqual(["1.0.0"]);
    expect(await readdir(f.layout.versions)).toContain("0.1.0");
    expect(await readdir(f.layout.versions)).toContain(".unmanaged-0.0.9-1");
  });

  test("removes a manifest whose binary is gone (crash between the two writes, amendment A10)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"], current: "1.3.0", link: "1.3.0" });
    await Bun.$`rm ${versionPath(f.layout, "1.2.0")}`;
    const removed = await runCleanup();
    expect(removed).toContain("1.2.0");
    expect(await readdir(f.layout.manifests)).not.toContain("1.2.0");
  });

  test("quarantine is deleted after 7 days, staging after 1 hour", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    const now = Date.UTC(2026, 9, 13);
    await writeFile(join(f.layout.versions, `.corrupt-1.0.0-${now - 8 * 86_400_000}`), "old");
    await writeFile(join(f.layout.versions, `.corrupt-1.0.0-${now - 86_400_000}`), "recent");
    await mkdir(join(f.layout.staging, "1.0.0.abc"));
    await writeFile(join(f.layout.staging, "1.0.0.def"), "partial");
    await utimes(join(f.layout.staging, "1.0.0.abc"), new Date(now - 7_200_000), new Date(now - 7_200_000));
    await utimes(join(f.layout.staging, "1.0.0.def"), new Date(now - 60_000), new Date(now - 60_000));
    const removed = await runCleanup(new Date(now));
    expect(removed.sort()).toEqual([`.corrupt-1.0.0-${now - 8 * 86_400_000}`, "staging/1.0.0.abc"].sort());
  });

  test("quarantine of a version a process still runs is kept", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    const now = Date.UTC(2026, 9, 13);
    const name = `.corrupt-1.0.0-${now - 8 * 86_400_000}`;
    await writeFile(join(f.layout.versions, name), "old");
    const session = (await lockVersionShared(f.layout, "1.0.0"))!;
    expect(await runCleanup(new Date(now))).toEqual([]);
    session.release();
  });
});
