// test/install/binary.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { publishFixture, makeFixtureRelease } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import pkg from "../../package.json";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
let prodBin: string;
let testBin: string;
const home = () => join(dir, "home");

beforeAll(async () => {
  dir = await makeTmpDir();
  key = await makeTestKey(dir, "e2e");
  await writeFile(join(dir, "signers"), allowedSignersText(key));
  prodBin = process.env.TROPOS_TEST_BINARY ?? join(dir, "tropos-prod");
  testBin = join(dir, "tropos-test");
  if (!process.env.TROPOS_TEST_BINARY) await Bun.$`bun build.ts --outfile ${prodBin}`.quiet();
  await Bun.$`bun build.ts --test-build --test-signers ${join(dir, "signers")} --outfile ${testBin}`.quiet();
  srv = startReleaseServer();
}, 300_000);
afterAll(async () => {
  srv.stop();
  await removeDir(dir);
});

async function exec(bin: string, args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn([bin, ...args], {
    env: { PATH: process.env.PATH!, HOME: home(), TROPOS_HOME: join(home(), ".tropos"), TROPOS_TEST_RELEASES_BASE: srv.base, ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("production binary", () => {
  test("contains no test-build hooks (amendment A3)", async () => {
    const bytes = Buffer.from(await Bun.file(prodBin).arrayBuffer());
    for (const marker of ["TROPOS_TEST_RELEASES_BASE", "TROPOS_TEST_SIGNERS", "TROPOS_TEST_BUILD"]) expect(bytes.includes(marker)).toBe(false);
  });

  test("build.ts rejects --test-signers without --test-build", async () => {
    const r = await Bun.$`bun build.ts --test-signers ${join(dir, "signers")} --outfile ${join(dir, "never")}`.quiet().nothrow();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("--test-signers only makes sense with --test-build");
  });

  test("subcommands outside a native install exit 73", async () => {
    expect((await exec(prodBin, ["update"])).code).toBe(73);
  });

  test("rejects a manifest not signed by the pinned key", async () => {
    const r = await makeFixtureRelease({ version: pkg.version, key, dir, binary: new Uint8Array(await Bun.file(prodBin).arrayBuffer()) });
    await writeFile(join(dir, "pm.json"), r.verified.bytes);
    await writeFile(join(dir, "pm.sig"), r.verified.signature);
    const out = await exec(prodBin, ["install", "--self", "--manifest", join(dir, "pm.json"), "--signature", join(dir, "pm.sig")]);
    expect(out.code).toBe(65);
    expect(out.stderr).toContain("untrusted key");
  });
});

describe("test-build binary: install --self → update → rollback", () => {
  test("full flow", async () => {
    const self = await makeFixtureRelease({ version: pkg.version, key, dir, binary: new Uint8Array(await Bun.file(testBin).arrayBuffer()) });
    publishFixture(srv, self);
    await writeFile(join(dir, "m.json"), self.verified.bytes);
    await writeFile(join(dir, "m.sig"), self.verified.signature);

    const installed = await exec(testBin, ["install", "--self", "--manifest", join(dir, "m.json"), "--signature", join(dir, "m.sig")]);
    expect(installed.stderr).toBe("");
    expect(installed.code).toBe(0);
    const link = join(home(), ".local/bin/tropos");
    expect((await exec(link, ["--version"])).stdout).toBe(`${pkg.version} (Tropos Code)\n`);

    const next = "99.0.0";
    publishFixture(srv, await makeFixtureRelease({ version: next, key, dir }));
    srv.put("channels", "latest", `${next}\n`);
    const updated = await exec(link, ["update"]);
    expect(updated.code).toBe(0);
    expect(updated.stdout).toContain(`Updated Tropos Code from ${pkg.version} to ${next}.`);
    expect(await readlink(link)).toEndWith(`/versions/${next}`);

    const rolled = await exec(join(home(), ".local/share/tropos/versions", pkg.version), ["rollback"]);
    expect(rolled.code).toBe(0);
    expect((await exec(link, ["--version"])).stdout).toBe(`${pkg.version} (Tropos Code)\n`);
  }, 120_000);
});
