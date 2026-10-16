// src/learning/counters.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { projectDir } from "../session/store";
import { loadCounters, saveCounters } from "./counters";

let home: string;
const cwd = "/work/app";

beforeEach(async () => {
  home = await makeTmpDir();
});

afterEach(async () => {
  await removeDir(home);
});

const ZERO = { turnsSinceMemory: 0, toolsSinceSkill: 0 };

test("missing or damaged learning.json reads as zeros; a save round-trips with mode 0600", async () => {
  expect(await loadCounters(home, cwd)).toEqual(ZERO);

  const path = join(projectDir(home, cwd), "learning.json");
  await mkdir(projectDir(home, cwd), { recursive: true });
  for (const bad of ["{not json", "[]", "null", '{"turnsSinceMemory":"3","toolsSinceSkill":1}', '{"turnsSinceMemory":-1,"toolsSinceSkill":1}', '{"turnsSinceMemory":1.5,"toolsSinceSkill":1}', '{"turnsSinceMemory":2}']) {
    await writeFile(path, bad);
    expect(await loadCounters(home, cwd)).toEqual(ZERO);
  }

  await saveCounters(home, cwd, { turnsSinceMemory: 3, toolsSinceSkill: 7 });
  expect(await loadCounters(home, cwd)).toEqual({ turnsSinceMemory: 3, toolsSinceSkill: 7 });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  // Atomic: no temp files left behind.
  expect(await readdir(projectDir(home, cwd))).toEqual(["learning.json"]);
  // Per project: another directory starts from zero.
  expect(await loadCounters(home, "/work/other")).toEqual(ZERO);
});

test("a save creates the project folder owner-only", async () => {
  await saveCounters(home, cwd, { turnsSinceMemory: 1, toolsSinceSkill: 0 });
  expect((await stat(projectDir(home, cwd))).mode & 0o777).toBe(0o700);
});
