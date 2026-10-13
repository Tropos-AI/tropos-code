// src/install/platform.test.ts
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { InstallError } from "./errors";
import { PLATFORMS, detectPlatform, isPlatform, platformFromProbe, probeHost } from "./platform";

const probe = (os: string, machine: string, extra: Partial<{ rosetta: boolean; musl: boolean }> = {}) => ({ os, machine, rosetta: false, musl: false, ...extra });

describe("platformFromProbe", () => {
  test.each([
    [probe("Darwin", "arm64"), "darwin-arm64"],
    [probe("Darwin", "x86_64"), "darwin-x64"],
    [probe("Darwin", "x86_64", { rosetta: true }), "darwin-arm64"],
    [probe("Linux", "x86_64"), "linux-x64"],
    [probe("Linux", "amd64"), "linux-x64"],
    [probe("Linux", "aarch64"), "linux-arm64"],
    [probe("Linux", "arm64"), "linux-arm64"],
    [probe("Linux", "x86_64", { musl: true }), "linux-x64-musl"],
    [probe("Linux", "aarch64", { musl: true }), "linux-arm64-musl"],
  ])("%j → %s", (p, expected) => expect(platformFromProbe(p)).toBe(expected as never));

  test.each([probe("FreeBSD", "amd64"), probe("MINGW64_NT-10.0", "x86_64"), probe("Linux", "i686"), probe("Linux", "armv7l")])("rejects %j", (p) => {
    expect(() => platformFromProbe(p)).toThrow(InstallError);
  });

  test("Rosetta only matters on Darwin x64; musl only on Linux", () => {
    expect(platformFromProbe(probe("Darwin", "arm64", { rosetta: true }))).toBe("darwin-arm64");
    expect(platformFromProbe(probe("Darwin", "arm64", { musl: true }))).toBe("darwin-arm64");
  });
});

describe("probeHost", () => {
  test("maps node names to uname names and reads Rosetta", () => {
    const ran: string[][] = [];
    const p = probeHost({ platform: "darwin", arch: "x64", run: (cmd) => (ran.push(cmd), "1\n") });
    expect(p).toEqual({ os: "Darwin", machine: "x86_64", rosetta: true, musl: false });
    expect(ran).toEqual([["sysctl", "-n", "sysctl.proc_translated"]]);
  });

  test("detects musl from the loader in libDir or from ldd", async () => {
    const dir = await makeTmpDir();
    try {
      await mkdir(join(dir, "lib"));
      await writeFile(join(dir, "lib", "ld-musl-x86_64.so.1"), "");
      expect(probeHost({ platform: "linux", arch: "x64", libDir: join(dir, "lib"), run: () => null }).musl).toBe(true);
      expect(probeHost({ platform: "linux", arch: "x64", libDir: join(dir, "none"), run: () => "musl libc (x86_64)" }).musl).toBe(true);
      expect(probeHost({ platform: "linux", arch: "x64", libDir: join(dir, "none"), run: () => "GNU C Library" }).musl).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });

  test("this machine maps to a supported platform", () => {
    expect(PLATFORMS).toContain(detectPlatform());
    expect(isPlatform("linux-x64")).toBe(true);
    expect(isPlatform("win32-x64")).toBe(false);
  });
});
