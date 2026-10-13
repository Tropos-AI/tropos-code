// test/install/install-sh.e2e.test.ts
// install.sh hands off to a real (test-build) tropos, which then updates and rolls back — success criteria 1–4.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { makeSandbox } from "./helpers/sh-runner";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
let testBin: string;

beforeAll(async () => {
  dir = await makeTmpDir();
  key = await makeTestKey(dir, "e2e");
  await writeFile(join(dir, "signers"), allowedSignersText(key));
  testBin = join(dir, "tropos-test");
  await Bun.$`bun build.ts --test-build --test-signers ${join(dir, "signers")} --outfile ${testBin}`.quiet();
  srv = startReleaseServer();
  publishFixture(srv, await makeFixtureRelease({ version: pkg.version, key, dir, binary: new Uint8Array(await Bun.file(testBin).arrayBuffer()) }));
  srv.put("channels", "latest", `${pkg.version}\n`);
}, 300_000);
afterAll(async () => {
  srv.stop();
  await removeDir(dir);
});

describe("install.sh → tropos install --self → update → rollback", () => {
  test("the whole path with real binaries", async () => {
    const sb = await makeSandbox({ signers: allowedSignersText(key), base: srv.base });
    const env = { TROPOS_TEST_RELEASES_BASE: srv.base };
    const installed = await sb.run([], { env });
    expect(installed.stderr).toBe("");
    expect(installed.code).toBe(0);
    const link = join(sb.home, ".local/bin/tropos");
    expect(await readlink(link)).toEndWith(`/versions/${pkg.version}`);

    publishFixture(srv, await makeFixtureRelease({ version: "99.0.0", key, dir }));
    srv.put("channels", "latest", "99.0.0\n");
    const run = (bin: string, args: string[]) =>
      Bun.spawn([bin, ...args], { env: { PATH: "/usr/bin:/bin", HOME: sb.home, ...env }, stdout: "pipe", stderr: "pipe" });
    const update = run(link, ["update"]);
    expect(await update.exited).toBe(0);
    expect(await readlink(link)).toEndWith("/versions/99.0.0");

    const rollback = run(join(sb.home, ".local/share/tropos/versions", pkg.version), ["rollback"]);
    expect(await rollback.exited).toBe(0);
    expect(await readlink(link)).toEndWith(`/versions/${pkg.version}`);
  }, 180_000);
});
