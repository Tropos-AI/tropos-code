// test/install/install-sh.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { detectPlatform } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, sshSign, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { SHELLS, handoffBinary, makeSandbox } from "./helpers/sh-runner";

let root: string;
let key: TestKey;
let srv: ReleaseServer;
const platform = detectPlatform();

beforeAll(async () => {
  root = await makeTmpDir();
  key = await makeTestKey(root, "k");
});
afterAll(() => removeDir(root));
beforeEach(async () => {
  srv?.stop();
  srv = startReleaseServer();
  for (const v of ["1.0.0", "1.1.0"]) publishFixture(srv, await makeFixtureRelease({ version: v, key, dir: root, binary: handoffBinary(v) }));
});

const sandbox = (extra: Parameters<typeof makeSandbox>[0] extends infer O ? Partial<O> : never = {}) =>
  makeSandbox({ signers: allowedSignersText(key), base: srv.base, ...extra });

describe.each(SHELLS.map((s) => [s.join(" "), s]))("install.sh under %s", (_name, shell) => {
  test("latest via the primary pointer hands off to install --self", async () => {
    srv.put("channels", "latest", "1.1.0\n");
    const sb = await sandbox({ shell: shell as string[] });
    const r = await sb.run();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Verified Tropos Code 1.1.0 for ${platform}.`);
    const handoff = (await readFile(join(sb.home, "handoff"), "utf8")).trim();
    expect(handoff).toMatch(/^install --self --manifest .+\/manifest\.json --signature .+\/manifest\.json\.sig$/);
    expect(srv.requests).toContain(`/t/r/releases/download/v1.1.0/tropos-${platform}.zst`);
  });
});

describe("install.sh targets and sources", () => {
  test("an explicit version needs no pointer", async () => {
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(srv.requests.some((p) => p.includes("/channels/"))).toBe(false);
  });

  test("stable through the .bak slot when the primary is missing (R3.1)", async () => {
    srv.put("channels", "stable.bak", "1.0.0\n");
    const r = await (await sandbox()).run(["stable"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Verified Tropos Code 1.0.0");
  }, 30_000);

  test("latest falls back to GitHub's latest release when both slots fail", async () => {
    srv.setLatest("v1.1.0");
    const r = await (await sandbox()).run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Verified Tropos Code 1.1.0");
  }, 30_000);

  test("without zstd it downloads the raw binary", async () => {
    srv.put("channels", "latest", "1.1.0\n");
    const r = await (await sandbox({ hide: ["zstd"] })).run();
    expect(r.code).toBe(0);
    expect(srv.requests).toContain(`/t/r/releases/download/v1.1.0/tropos-${platform}`);
    expect(srv.requests.some((p) => p.endsWith(".zst"))).toBe(false);
  });

  test("installs into a HOME containing spaces (Review Focus 2)", async () => {
    const sb = await sandbox({ home: "Jane Doe/home" });
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(await Bun.file(join(sb.home, "handoff")).exists()).toBe(true);
  });

  test("TROPOS_INSTALL_FROM reads a local folder and still verifies", async () => {
    const folder = join(root, "draft");
    const r1 = await makeFixtureRelease({ version: "2.0.0", key, dir: root, binary: handoffBinary("2.0.0") });
    await Bun.$`mkdir -p ${folder}`;
    await Bun.write(join(folder, "manifest.json"), r1.verified.bytes);
    await Bun.write(join(folder, "manifest.json.sig"), r1.verified.signature);
    await Bun.write(join(folder, `tropos-${platform}`), r1.binary);
    await Bun.write(join(folder, `tropos-${platform}.zst`), r1.zst);
    const sb = await sandbox();
    expect((await sb.run(["2.0.0"], { env: { TROPOS_INSTALL_FROM: folder } })).code).toBe(0);
    expect((await sb.run(["latest"], { env: { TROPOS_INSTALL_FROM: folder } })).code).toBe(64);
    await Bun.write(join(folder, "manifest.json.sig"), "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n");
    expect((await sb.run(["2.0.0"], { env: { TROPOS_INSTALL_FROM: folder } })).code).toBe(65);
  });

  test("prints the PATH line when ~/.local/bin is not on PATH, and never edits startup files", async () => {
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"]);
    expect(r.stdout).toContain(`Add ${sb.home}/.local/bin to your PATH`);
    expect(r.stdout).toContain(`export PATH="${sb.home}/.local/bin:$PATH"`);
    expect(await Bun.file(join(sb.home, ".zshrc")).exists()).toBe(false);
  });
});

describe("install.sh platform detection and manifest bytes", () => {
  // `ldd /bin/sh` names musl on Alpine and glibc on Ubuntu; it is only consulted without a /lib/ld-musl loader.
  const hostHasMusl = async () => (await readdir("/lib").catch(() => [] as string[])).some((f) => /^ld-musl-.*\.so\.1$/.test(f));
  const linuxUname = `#!/bin/sh\ncase $1 in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n`;

  test("the ldd fallback picks the musl build when ldd names musl", async () => {
    if (await hostHasMusl()) return;
    const sb = await sandbox({ shims: { uname: linuxUname, ldd: `#!/bin/sh\necho "musl libc (x86_64)"\necho "Version 1.2.4"\n` } });
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Verified Tropos Code 1.0.0 for linux-x64-musl.");
    expect(srv.requests).toContain("/t/r/releases/download/v1.0.0/tropos-linux-x64-musl.zst");
  });

  test("the ldd fallback picks the glibc build when ldd names glibc", async () => {
    if (await hostHasMusl()) return;
    const glibc = `#!/bin/sh\nprintf '\\tlinux-vdso.so.1 (0x00007ffc)\\n\\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f1)\\n\\t/lib64/ld-linux-x86-64.so.2 (0x00007f2)\\n'\n`;
    const sb = await sandbox({ shims: { uname: linuxUname, ldd: glibc } });
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Verified Tropos Code 1.0.0 for linux-x64.");
    expect(srv.requests).toContain("/t/r/releases/download/v1.0.0/tropos-linux-x64.zst");
    expect(srv.requests.some((p) => p.includes("musl"))).toBe(false);
  });

  test.each([
    ["a NUL byte", "\u0000"],
    ["a non-ASCII byte", "\u00e9"],
    ["a carriage return", "\r"],
  ])("rejects a correctly signed manifest containing %s", async (_name, bad) => {
    const good = new TextDecoder().decode((await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() })).verified.bytes);
    const bytes = new TextEncoder().encode(good.replace('"schema": 1,', `"schema": 1,${bad}`));
    srv.put("v1.0.0", "manifest.json", bytes);
    srv.put("v1.0.0", "manifest.json.sig", await sshSign(key, bytes, "tropos-manifest", root));
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toBe("tcode install: the release manifest is malformed\n");
    expect(await Bun.file(join(sb.home, "handoff")).exists()).toBe(false);
  });
});
