// test/install/install-local.test.ts
// scripts/install-local.sh: never replaces a managed (released) version, and never writes over a running binary.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../helpers/tmp";

const SCRIPT = join(import.meta.dir, "../../scripts/install-local.sh");
const VERSION = ((await Bun.file(join(import.meta.dir, "../../package.json")).json()) as { version: string }).version;

let home: string;
let bin: string;
let versions: string;
beforeEach(async () => {
  home = await makeTmpDir();
  bin = join(home, "built-tropos");
  await writeFile(bin, "#!/bin/sh\necho new build\n");
  await chmod(bin, 0o755);
  versions = join(home, ".local", "share", "tropos", "versions");
  await mkdir(versions, { recursive: true });
});
afterEach(() => removeDir(home));

const run = () => Bun.spawn(["sh", SCRIPT, bin], { env: { HOME: home, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });

describe("scripts/install-local.sh", () => {
  test("refuses to replace a version that has a stored manifest (a managed release)", async () => {
    const dest = join(versions, VERSION);
    await writeFile(dest, "released binary");
    const manifests = join(home, ".local", "share", "tropos", "manifests", VERSION);
    await mkdir(manifests, { recursive: true });
    await writeFile(join(manifests, "manifest.json"), "{}");
    const p = run();
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain("managed by the updater");
    expect(await readFile(dest, "utf8")).toBe("released binary");
  });

  test("replaces an existing local build by rename, so a running copy keeps its file", async () => {
    const dest = join(versions, VERSION);
    await writeFile(dest, "old local build");
    const before = (await stat(dest)).ino;
    const p = run();
    expect(await p.exited).toBe(0);
    expect(await readFile(dest, "utf8")).toBe("#!/bin/sh\necho new build\n");
    expect((await stat(dest)).ino).not.toBe(before);
    expect((await readdir(versions)).sort()).toEqual([VERSION]);
  });
});
