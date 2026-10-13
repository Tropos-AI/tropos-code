// src/install/decompress.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectedOf, zstdCorpus } from "../../test/install/helpers/zstd-corpus";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { decompressZstdFile } from "./decompress";
import { InstallError } from "./errors";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
});
afterAll(() => removeDir(dir));

describe("decompressZstdFile", () => {
  for (const c of zstdCorpus()) {
    test(`${c.valid ? "accepts" : "rejects"} ${c.name}`, async () => {
      const src = join(dir, `${c.name}.zst`);
      const dest = join(dir, `${c.name}.out`);
      await writeFile(src, c.zst);
      const expected = expectedOf(c);
      const run = decompressZstdFile(src, dest, expected);
      if (c.valid) {
        await run;
        expect((await stat(dest)).size).toBe(expected.size);
      } else {
        const err = await run.then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(InstallError);
        expect((err as InstallError).kind).toBe("integrity");
        // Never more than the promised size on disk, whatever the input expands to.
        const written = await stat(dest).then((s) => s.size, () => 0);
        expect(written).toBeLessThanOrEqual(expected.size);
      }
    });
  }

  test("refuses to overwrite an existing destination", async () => {
    const c = zstdCorpus()[0]!;
    const src = join(dir, "again.zst");
    const dest = join(dir, "again.out");
    await writeFile(src, c.zst);
    await writeFile(dest, "existing");
    await expect(decompressZstdFile(src, dest, expectedOf(c))).rejects.toThrow();
  });
});

describe("decompressZstdFile filesystem errors", () => {
  test("an existing destination is a local error", async () => {
    const c = zstdCorpus()[0]!;
    const src = join(dir, "ex.zst");
    const dest = join(dir, "ex.out");
    await writeFile(src, c.zst);
    await writeFile(dest, "existing");
    const err = await decompressZstdFile(src, dest, expectedOf(c)).then(() => null, (e: unknown) => e);
    expect((err as InstallError).kind).toBe("local");
  });

  test("a missing source is a local error", async () => {
    const c = zstdCorpus()[0]!;
    const err = await decompressZstdFile(join(dir, "nope.zst"), join(dir, "nope.out"), expectedOf(c)).then(() => null, (e: unknown) => e);
    expect((err as InstallError).kind).toBe("local");
  });

  test.skipIf(process.getuid?.() === 0)("an unwritable destination directory is a local error", async () => {
    const c = zstdCorpus()[0]!;
    const ro = join(dir, "ro");
    await mkdir(ro, { mode: 0o500 });
    const src = join(dir, "ro.zst");
    await writeFile(src, c.zst);
    const err = await decompressZstdFile(src, join(ro, "out"), expectedOf(c)).then(() => null, (e: unknown) => e);
    expect((err as InstallError).kind).toBe("local");
  });
});
