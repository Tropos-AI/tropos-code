// test/install/key-rotation.test.ts
// Spec §6.1: phase 1 trusts {K1, K2} while signing with K1; phase 2 signs with K2; clients that trust only K1
// must refuse K2 releases with the reinstall hint; a third key is never accepted. The old-installer gate
// (release.yml smoke-public b) is exactly "an install.sh that trusts only K1 fails on a K2 release".
import { afterEach, describe, expect, test } from "bun:test";
import { InstallError } from "../../src/install/errors";
import { installTarget } from "../../src/install/installer";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey } from "./helpers/keys";
import { handoffBinary, makeSandbox } from "./helpers/sh-runner";

let f: EngineFixture;
afterEach(() => f?.close());

describe("key rotation K1 → K2 (spec §6.1, layer 9)", () => {
  test("tcode: K1-only clients refuse K2 releases with the reinstall hint; phase-1 clients accept both; K3 never", async () => {
    f = await makeEngineFixture(); // f.key is K1
    const k2 = await makeTestKey(f.root, "k2");
    const k3 = await makeTestKey(f.root, "k3");
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    publishFixture(f.srv, await makeFixtureRelease({ version: "2.0.0", key: k2, dir: f.root }));
    const refused = (await installTarget(f.deps, "2.0.0", false).catch((e) => e)) as InstallError;
    expect(refused.kind).toBe("integrity");
    expect(refused.message).toContain("reinstall with install.sh");
    const phase1 = { ...f.deps, trusted: [...f.key.trusted, ...k2.trusted] };
    expect((await installTarget(phase1, "2.0.0", false)).value.version).toBe("2.0.0");
    expect((await installTarget(phase1, "1.0.0", false)).value.version).toBe("1.0.0"); // K1 releases still verify
    publishFixture(f.srv, await makeFixtureRelease({ version: "3.0.0", key: k3, dir: f.root }));
    expect(((await installTarget(phase1, "3.0.0", false).catch((e) => e)) as InstallError).kind).toBe("integrity");
  });

  test("install.sh: the published-installer gate fails a K2 release when the installer trusts only K1", async () => {
    f = await makeEngineFixture();
    const k2 = await makeTestKey(f.root, "k2");
    const k3 = await makeTestKey(f.root, "k3");
    publishFixture(f.srv, await makeFixtureRelease({ version: "2.0.0", key: k2, dir: f.root, binary: handoffBinary("2.0.0") }));
    const k1Only = await makeSandbox({ signers: allowedSignersText(f.key), base: f.srv.base });
    expect((await k1Only.run(["2.0.0"])).code).toBe(65);
    const phase1 = await makeSandbox({ signers: allowedSignersText(f.key, k2), base: f.srv.base });
    expect((await phase1.run(["2.0.0"])).code).toBe(0);
    publishFixture(f.srv, await makeFixtureRelease({ version: "3.0.0", key: k3, dir: f.root, binary: handoffBinary("3.0.0") }));
    expect((await phase1.run(["3.0.0"])).code).toBe(65);
  });
});
