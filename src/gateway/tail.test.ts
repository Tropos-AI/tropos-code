// src/gateway/tail.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { tailFile } from "./tail";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-tail");
});
afterEach(() => removeDir(dir));

describe("tailFile", () => {
  test("a missing file is undefined, an empty one is empty", async () => {
    expect(await tailFile(join(dir, "none"), 5)).toBeUndefined();
    await Bun.write(join(dir, "empty"), "");
    expect(await tailFile(join(dir, "empty"), 5)).toBe("");
  });
  test("returns the last lines, and everything when the file is shorter", async () => {
    await Bun.write(join(dir, "log"), "a\nb\nc\nd\n");
    expect(await tailFile(join(dir, "log"), 2)).toBe("c\nd\n");
    expect(await tailFile(join(dir, "log"), 10)).toBe("a\nb\nc\nd\n");
  });
  test("works across chunk boundaries on a big file", async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    await Bun.write(join(dir, "big"), `${lines.join("\n")}\n`);
    expect(await tailFile(join(dir, "big"), 3)).toBe("line 19997\nline 19998\nline 19999\n");
  });
});
