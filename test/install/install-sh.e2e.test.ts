// test/install/install-sh.e2e.test.ts
// install.sh hands off to a real (test-build) tcode, which then updates and rolls back — success criteria 1–4.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { makeSandbox, type Sandbox } from "./helpers/sh-runner";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
let testBin: string;
let sb: Sandbox | undefined;

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
  srv?.stop();
  if (sb) await removeDir(sb.dir);
  if (dir) await removeDir(dir);
});

describe("install.sh → tcode install --self → update → rollback", () => {
  test("the whole path with real binaries", async () => {
    const box = await makeSandbox({ signers: allowedSignersText(key), base: srv.base });
    sb = box;
    const env = { TROPOS_TEST_RELEASES_BASE: srv.base };
    const installed = await box.run([], { env });
    expect(installed.stderr).toBe("");
    expect(installed.code).toBe(0);
    const link = join(box.home, ".local/bin/tcode");
    expect(await readlink(link)).toEndWith(`/versions/${pkg.version}`);

    const run = async (bin: string, args: string[]) => {
      const proc = Bun.spawn([bin, ...args], { env: { PATH: "/usr/bin:/bin", HOME: box.home, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code, msg: `exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}` };
    };
    const version = async (v: string) => {
      const r = await run(link, ["--version"]);
      expect(r.msg).toContain("exit 0");
      expect(r.stdout).toBe(`${v} (Tropos Code)\n`);
    };
    await version(pkg.version);

    publishFixture(srv, await makeFixtureRelease({ version: "99.0.0", key, dir }));
    srv.put("channels", "latest", "99.0.0\n");
    const update = await run(link, ["update"]);
    expect(update.stderr, update.msg).toBe("");
    expect(update.code, update.msg).toBe(0);
    expect(await readlink(link)).toEndWith("/versions/99.0.0");
    await version("99.0.0");

    const rollback = await run(join(box.home, ".local/share/tropos/versions", pkg.version), ["rollback"]);
    expect(rollback.stderr, rollback.msg).toBe("");
    expect(rollback.code, rollback.msg).toBe(0);
    expect(await readlink(link)).toEndWith(`/versions/${pkg.version}`);
    await version(pkg.version);
  }, 180_000);
});
