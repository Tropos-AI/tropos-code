// test/install/rollback.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { InstallError } from "../../src/install/errors";
import { installTarget } from "../../src/install/installer";
import { versionPath } from "../../src/install/layout";
import { readLink } from "../../src/install/link";
import { rollback } from "../../src/install/rollback";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

describe("rollback", () => {
  test("switches to previous and skips the version rolled back from", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
    const { value } = await rollback(f.deps);
    expect(value).toEqual({ version: "1.0.0", previous: "1.1.0", changed: true });
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", previous: "1.1.0", skip: { "1.1.0": "rolled-back" } });
  });

  test("without a previous version it fails with integrity", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    const e = (await rollback(f.deps).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("integrity");
    expect(e.message).toStartWith("no verified previous version to roll back to");
  });

  test("a corrupted previous version is never activated", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await f.release("1.2.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
    await installTarget(f.deps, "1.2.0", false);
    await appendFile(versionPath(f.layout, "1.1.0"), "x");
    const e = (await rollback(f.deps).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("integrity");
    expect(e.message).toContain("verified versions: 1.0.0");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.2.0" });
  });

  async function twoVersions() {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
  }

  test("a foreign file at bin/tropos is refused and left unchanged", async () => {
    await twoVersions();
    await rm(f.layout.binLink);
    await writeFile(f.layout.binLink, "user file");
    const e = (await rollback(f.deps).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("local");
    expect(await readFile(f.layout.binLink, "utf8")).toBe("user file");
  });

  test("a world-writable bin directory is refused", async () => {
    await twoVersions();
    await chmod(f.layout.binDir, 0o777);
    const e = (await rollback(f.deps).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("local");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.1.0" });
  });

  test("a failed post-switch check restores the current version and skips the target", async () => {
    await twoVersions();
    const deps = { ...f.deps, health: async (b: string, v: string) => (b === f.layout.binLink ? ("bad" as const) : f.deps.health(b, v)) };
    const e = (await rollback(deps).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("integrity");
    expect(e.message).toBe("version 1.0.0 failed its check; still using 1.1.0");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.1.0" });
    expect(await f.state()).toMatchObject({ current: "1.1.0", pending: null, skip: { "1.0.0": "health-check" } });
  });

  test("an inconclusive post-switch check keeps the rollback target active (75), never drops the link", async () => {
    await twoVersions();
    let switched = false;
    const health = async (b: string, v: string) => {
      if (b === f.layout.binLink) switched = true;
      return switched ? ("unknown" as const) : f.deps.health(b, v);
    };
    const e = (await rollback({ ...f.deps, health }).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("busy");
    expect(e.message).toBe("the health check of 1.0.0 could not be run after switching; 1.0.0 stays active — try `tcode --version`");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", previous: "1.1.0", pending: null, skip: { "1.1.0": "rolled-back" } });
    expect((await f.state()).skip["1.0.0"]).toBeUndefined();
  });
});
