import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
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
