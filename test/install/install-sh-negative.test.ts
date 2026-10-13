// test/install/install-sh-negative.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectPlatform } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, sshSign, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { INSTALL_SH, handoffBinary, makeSandbox } from "./helpers/sh-runner";

let root: string;
let key: TestKey;
let other: TestKey;
let srv: ReleaseServer;
const platform = detectPlatform();
const asset = `tropos-${platform}`;

beforeAll(async () => {
  root = await makeTmpDir();
  [key, other] = await Promise.all([makeTestKey(root, "k"), makeTestKey(root, "other")]);
});
afterAll(() => removeDir(root));
beforeEach(async () => {
  srv?.stop();
  srv = startReleaseServer();
  publishFixture(srv, await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() }));
});

const sandbox = (extra: Partial<Parameters<typeof makeSandbox>[0]> = {}) => makeSandbox({ signers: allowedSignersText(key), base: srv.base, ...extra });
// macOS mktemp ignores $TMPDIR; this shim makes it behave like GNU mktemp -d so the TMPDIR tests mean the same everywhere.
const darwin = process.platform === "darwin";
const tmpdirMktemp = "#!/bin/sh\nd=\"${TMPDIR:-/tmp}/work.$$\"\n/bin/mkdir -p \"$d\" && echo \"$d\"\n";
const mktempShim: Record<string, string> = darwin ? { mktemp: tmpdirMktemp } : {};
const nothingInstalled = async (home: string) => expect(await Bun.file(join(home, "handoff")).exists()).toBe(false);

describe("signature and manifest (fail closed)", () => {
  test("tampered manifest", async () => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", "manifest.json", new TextDecoder().decode(r1.verified.bytes).replace('"size": ', '"size":  '));
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("signature is not valid");
    await nothingInstalled(sb.home);
  });

  test.each([
    ["an untrusted signer", async (bytes: Uint8Array) => sshSign(other, bytes, "tropos-manifest", root)],
    ["the installer namespace", async (bytes: Uint8Array) => sshSign(key, bytes, "tropos-installer", root)],
    ["garbage", async () => "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n"],
  ])("signature from %s", async (_n, sign) => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", "manifest.json.sig", await sign(r1.verified.bytes));
    const sb = await sandbox();
    expect((await sb.run(["1.0.0"])).code).toBe(65);
    await nothingInstalled(sb.home);
  });

  test("an empty pinned key set rejects a valid signature (A5)", async () => {
    const sb = await makeSandbox({ signers: "# no keys yet\n", base: srv.base });
    expect((await sb.run(["1.0.0"])).code).toBe(65);
  });

  test("a validly signed manifest for another version", async () => {
    const r2 = await makeFixtureRelease({ version: "2.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", "manifest.json", r2.verified.bytes);
    srv.put("v1.0.0", "manifest.json.sig", r2.verified.signature);
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("the manifest is for version 2.0.0, not 1.0.0");
  });

  test("a validly signed but non-canonical manifest", async () => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    const text = new TextDecoder().decode(r1.verified.bytes).replace('  "version": "1.0.0",\n', '  "version": "1.0.0",\n  "version": "1.0.0",\n');
    srv.put("v1.0.0", "manifest.json", text);
    srv.put("v1.0.0", "manifest.json.sig", await sshSign(key, text, "tropos-manifest", root));
    expect((await (await sandbox()).run(["1.0.0"])).stderr).toContain("the release manifest is malformed");
  });
});

describe("binary integrity", () => {
  test.each([
    ["short", (b: Uint8Array) => b.subarray(0, b.length - 1)],
    ["extra bytes", (b: Uint8Array) => Buffer.concat([b, Buffer.from("x")])],
  ])("raw binary %s → checksum mismatch", async (_n, mangle) => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", asset, mangle(r1.binary));
    srv.put("v1.0.0", `${asset}.zst`, "junk");
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("checksum mismatch");
    await nothingInstalled(sb.home);
  });

  test("corrupt .zst falls back to the raw binary", async () => {
    srv.put("v1.0.0", `${asset}.zst`, "junk");
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("downloading the uncompressed binary");
  });

  test("an asset larger than the manifest says is cut off by the file-size limit (R8.2)", async () => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", asset, Buffer.concat([r1.binary, new Uint8Array(8 * 1024 * 1024)]));
    srv.put("v1.0.0", `${asset}.zst`, "junk");
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.code).not.toBe(0);
  });
});

describe("network and channels", () => {
  test("an HTML pointer counts as missing; the .bak slot is used", async () => {
    srv.put("channels", "latest", "<html>Not Found</html>");
    srv.put("channels", "latest.bak", "1.0.0\n");
    expect((await (await sandbox()).run()).code).toBe(0);
  }, 30_000);

  test("500 then success", async () => {
    srv.put("channels", "latest", "1.0.0\n");
    srv.failNext("channels", "latest", 500, 2);
    expect((await (await sandbox()).run()).code).toBe(0);
  }, 30_000);

  test("server down → 69", async () => {
    srv.stop();
    expect((await (await sandbox()).run(["1.0.0"])).code).toBe(69);
  });

  test("stable with both slots missing fails clearly (R7.3)", async () => {
    srv.setLatest("v1.0.0");
    const r = await (await sandbox()).run(["stable"]);
    expect(r.code).toBe(69);
    expect(r.stderr).toContain("no release has been published yet");
    expect(srv.requests.some((p) => p.includes("/download/v"))).toBe(false);
  }, 60_000);

  test("latest with both slots missing and no GitHub latest release fails the same way (R7.3)", async () => {
    const sb = await sandbox();
    const r = await sb.run();
    expect(r.code).toBe(69);
    expect(r.stderr).toContain("no release has been published yet");
    expect(srv.requests).toContain("/t/r/releases/latest/download/manifest.json");
    expect(srv.requests.some((p) => p.includes("/download/v"))).toBe(false);
    await nothingInstalled(sb.home);
  }, 60_000);

  test("latest with the server down says the server could not be reached (R7.3)", async () => {
    srv.stop();
    const r = await (await sandbox()).run();
    expect(r.code).toBe(69);
    expect(r.stderr).toContain("could not be reached");
  }, 60_000);

  test("an explicit version works before any promotion (R7.3)", async () => {
    expect((await (await sandbox()).run(["1.0.0"])).code).toBe(0);
  });
});

describe("dependencies and platform", () => {
  test("no ssh-keygen → fail before downloading anything", async () => {
    const r = await (await sandbox({ hide: ["ssh-keygen"] })).run(["1.0.0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ssh-keygen (OpenSSH 8.1 or newer) is required");
    expect(srv.requests).toEqual([]);
  });

  test("an ssh-keygen without -Y → 65 with the upgrade message", async () => {
    const r = await (await sandbox({ shims: { "ssh-keygen": "#!/bin/sh\necho 'ssh-keygen: unknown option -- Y' >&2\nexit 1\n" } })).run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("install OpenSSH 8.1 or newer");
  });

  test("no curl and no wget", async () => {
    expect((await (await sandbox({ hide: ["curl", "wget"] })).run(["1.0.0"])).stderr).toContain("curl or wget is required");
  });

  test("no hash tool", async () => {
    expect((await (await sandbox({ hide: ["sha256sum", "shasum", "perl"] })).run(["1.0.0"])).stderr).toContain("sha256sum or shasum is required");
  });

  test.each([
    ["FreeBSD", "amd64", "unsupported operating system: FreeBSD"],
    ["MINGW64_NT-10.0", "x86_64", "unsupported operating system: MINGW64_NT-10.0"],
    ["Linux", "i686", "unsupported CPU architecture: i686"],
  ])("uname %s %s", async (os, machine, message) => {
    const uname = `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${machine} ;; esac\n`;
    const r = await (await sandbox({ shims: { uname } })).run(["1.0.0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test("refuses sudo from a user shell unless allowed", async () => {
    const sb = await sandbox({ shims: { id: "#!/bin/sh\necho 0\n" } });
    const refused = await sb.run(["1.0.0"], { env: { SUDO_USER: "alice" } });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("do not run this installer with sudo");
    expect((await sb.run(["1.0.0"], { env: { SUDO_USER: "alice", TROPOS_INSTALL_ALLOW_SUDO: "1" } })).code).toBe(0);
  });

  test.each([[["1.2"]], [["1.0.0", "extra"]], [["../1.0.0"]], [["nightly"]]])("usage error for %j", async (args) => {
    expect((await (await sandbox()).run(args)).code).toBe(64);
  });

  test("an explicit empty argument is a usage error, not latest (spec 8.2 step 1)", async () => {
    srv.put("channels", "latest", "1.0.0\n");
    const sb = await sandbox();
    const r = await sb.run([""]);
    expect(r.code).toBe(64);
    await nothingInstalled(sb.home);
  });

  test("the binary's exit code is passed through; a signal death is explained", async () => {
    const sb = await sandbox();
    expect((await sb.run(["1.0.0"], { env: { FAKE_EXIT: "73" } })).code).toBe(73);
    const killed = await sb.run(["1.0.0"], { env: { FAKE_SIGNAL: "1" } });
    expect(killed.code).toBe(137);
    expect(killed.stderr).toContain("stopped by a signal (exit 137)");
  });

  test("the temporary folder is removed on every exit", async () => {
    const sb = await sandbox({ shims: mktempShim });
    await Bun.$`mkdir -p ${join(sb.dir, "t")}`;
    await sb.run(["1.0.0"], { env: { TMPDIR: join(sb.dir, "t") } });
    await sb.run(["9.9.9"], { env: { TMPDIR: join(sb.dir, "t") } });
    expect(await readdir(join(sb.dir, "t"))).toEqual([]);
  });
});

describe("hardening", () => {
  test("a TMPDIR containing a backslash does not break checksum comparison", async () => {
    // GNU sha256sum prefixes the hash with a backslash when the FILE NAME contains one; hashing stdin never does.
    // On macOS there is no GNU sha256sum, so a shim emulates it on top of shasum; on Linux the real tool is used.
    const shasum = Bun.which("shasum");
    const shims: Record<string, string> = { ...mktempShim };
    if (darwin && shasum) shims.sha256sum = `#!/bin/sh\nif [ $# -gt 0 ]; then case $1 in *\\\\*) printf '\\\\' ;; esac; fi\nexec ${shasum} -a 256 "$@"\n`;
    const sb = await sandbox({ shims });
    const tmpdir = join(sb.dir, "t\\x");
    await Bun.$`mkdir -p ${tmpdir}`;
    const r = await sb.run(["1.0.0"], { env: { TMPDIR: tmpdir } });
    expect(r.stderr).not.toContain("checksum mismatch");
    expect(r.code).toBe(0);
  });

  test("a relative temporary directory from mktemp is refused and nothing is left behind", async () => {
    // Some mktemp builds honour a relative TMPDIR such as a=b, which awk would read as a variable assignment.
    const mktemp = '#!/bin/sh\necho a=b/work\n';
    const sb = await sandbox({ shims: { mktemp } });
    await Bun.$`mkdir -p ${join(sb.dir, "a=b", "work")}`;
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not an absolute path");
    expect(await Bun.file(join(sb.dir, "a=b", "work")).exists()).toBe(false); // the trap removed it
    await nothingInstalled(sb.home);
  });

  test("the temporary folder is removed even when chmod fails", async () => {
    const sb = await sandbox({ shims: { chmod: "#!/bin/sh\nexit 1\n", ...mktempShim } });
    await Bun.$`mkdir -p ${join(sb.dir, "t")}`;
    const r = await sb.run(["1.0.0"], { env: { TMPDIR: join(sb.dir, "t") } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("cannot secure the temporary directory");
    expect(await readdir(join(sb.dir, "t"))).toEqual([]);
    await nothingInstalled(sb.home);
  });

  test("the PATH hint does not need basename", async () => {
    const r = await (await sandbox({ hide: ["basename"] })).run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("~/.zshrc");
  });

  test("a failing tr fails the manifest byte check closed", async () => {
    const sb = await sandbox({ shims: { tr: "#!/bin/sh\nexit 1\n" } });
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("the release manifest is malformed");
    await nothingInstalled(sb.home);
  });
});

describe("truncated downloads of install.sh itself", () => {
  test("every 64-byte prefix runs nothing and creates nothing", async () => {
    const full = await readFile(INSTALL_SH);
    const dir = await makeTmpDir();
    try {
      // Stop before the final `main "$@"` line: only a complete download may run anything.
      const last = full.lastIndexOf('main "$@"');
      expect(last).toBeGreaterThan(0);
      for (let n = 64; n < last; n += 64) {
        const home = join(dir, `h${n}`);
        await Bun.$`mkdir -p ${home}`;
        const proc = Bun.spawn(["sh"], { stdin: new Blob([full.subarray(0, n)]), env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe", cwd: home });
        await proc.exited;
        expect(await readdir(home)).toEqual([]);
      }
    } finally {
      await removeDir(dir);
    }
  }, 120_000);
});

describe("shellcheck", () => {
  test.skipIf(!Bun.which("shellcheck"))("install.sh is clean under shellcheck -s sh", async () => {
    const r = await Bun.$`shellcheck -s sh ${INSTALL_SH}`.quiet().nothrow();
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });
});
