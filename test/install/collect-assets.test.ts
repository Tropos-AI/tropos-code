// test/install/collect-assets.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORMS } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";

const SCRIPT = join(import.meta.dir, "../../scripts/release/collect-assets.sh");
let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "dist"));
  for (const p of PLATFORMS) await writeFile(join(dir, "dist", `tropos-1.2.3-${p}`), `bin ${p}`);
  await writeFile(join(dir, "install.sh"), "#!/bin/sh\n");
});
afterEach(() => removeDir(dir));

describe("collect-assets.sh", () => {
  test("renames to release asset names and writes SHA256SUMS", async () => {
    await Bun.$`sh ${SCRIPT} ${join(dir, "dist")} 1.2.3 ${join(dir, "out")}`.cwd(dir).quiet();
    const names = (await readdir(join(dir, "out"))).sort();
    expect(names).toEqual(["SHA256SUMS", "install.sh", ...PLATFORMS.map((p) => `tropos-${p}`)].sort());
    const sums = await readFile(join(dir, "out", "SHA256SUMS"), "utf8");
    const lines = sums.trim().split("\n");
    expect(lines.length).toBe(7);
    const listed = lines.map((l) => l.split(/ +/)[1]);
    expect(listed).toEqual([...listed].sort());
    await Bun.$`sha256sum -c SHA256SUMS || shasum -a 256 -c SHA256SUMS`.cwd(join(dir, "out")).quiet();
  });

  test("fails when a platform binary is missing", async () => {
    await Bun.$`rm ${join(dir, "dist", "tropos-1.2.3-linux-arm64-musl")}`;
    const r = await Bun.$`sh ${SCRIPT} ${join(dir, "dist")} 1.2.3 ${join(dir, "out")}`.cwd(dir).quiet().nothrow();
    expect(r.exitCode).toBe(1);
  });

  test("fails when install.sh is missing", async () => {
    await Bun.$`rm ${join(dir, "install.sh")}`;
    const r = await Bun.$`sh ${SCRIPT} ${join(dir, "dist")} 1.2.3 ${join(dir, "out")}`.cwd(dir).quiet().nothrow();
    expect(r.exitCode).toBe(1);
  });
});
