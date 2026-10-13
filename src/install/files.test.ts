// src/install/files.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { fsyncDir, sha256File, writeFileAtomic } from "./files";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

describe("files", () => {
  test("sha256File", async () => {
    await writeFile(join(dir, "f"), "hello");
    expect(await sha256File(join(dir, "f"))).toEqual({ sha256: new Bun.CryptoHasher("sha256").update("hello").digest("hex"), size: 5 });
  });

  test("writeFileAtomic replaces content, sets the mode and leaves no temp files", async () => {
    const path = join(dir, "state.json");
    await writeFileAtomic(path, "one");
    await writeFileAtomic(path, "two", 0o600);
    expect(await readFile(path, "utf8")).toBe("two");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  test("fsyncDir works on a directory", async () => {
    await fsyncDir(dir);
  });
});
