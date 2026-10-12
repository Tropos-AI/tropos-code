import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { commonPrefix, completeCommand, completeFile } from "./complete";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "src", "components"), { recursive: true });
  await mkdir(join(dir, "src", "config"));
  await writeFile(join(dir, "src", "main.ts"), "");
  await mkdir(join(dir, "node_modules"));
});
afterAll(() => removeDir(dir));

test("file completion lists matches with / on directories", async () => {
  expect(await completeFile("@src/c", dir)).toEqual(["@src/components/", "@src/config/"]);
  expect(await completeFile("@src/m", dir)).toEqual(["@src/main.ts"]);
  expect(await completeFile("@n", dir)).toEqual([]);
});

test("command completion", () => {
  expect(completeCommand("/he")).toEqual(["/help"]);
  expect(completeCommand("/e")).toEqual(["/effort", "/exit"]);
});

test("common prefix", () => {
  expect(commonPrefix(["@src/components/", "@src/config/"])).toBe("@src/co");
  expect(commonPrefix([])).toBe("");
});

describe("completion stays inside cwd", () => {
  let outside: string;
  beforeAll(async () => {
    outside = await makeTmpDir();
    await writeFile(join(outside, "secret.txt"), "");
    await symlink(outside, join(dir, "escape"));
  });
  afterAll(() => removeDir(outside));

  test("paths that climb out of cwd list nothing", async () => {
    expect(await completeFile("@../", dir)).toEqual([]);
    expect(await completeFile("@src/../../", dir)).toEqual([]);
    expect(await completeFile("@/", dir)).toEqual([]);
  });

  test("a symlinked directory that points outside cwd lists nothing", async () => {
    expect(await completeFile("@escape/", dir)).toEqual([]);
    expect(await completeFile("@escape/s", dir)).toEqual([]);
  });
});
