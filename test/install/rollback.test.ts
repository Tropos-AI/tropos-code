// test/install/rollback.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { InstallError } from "../../src/install/errors";
import { installTarget } from "../../src/install/installer";
import { versionPath } from "../../src/install/layout";
import { readLink } from "../../src/install/link";
import { rollback } from "../../src/install/rollback";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

describe("rollback (spec §10.7)", () => {
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

  test("a corrupted previous version is never activated (R6.3)", async () => {
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
});
