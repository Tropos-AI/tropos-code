import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { readSkillUsage, recordSkillUse, usagePath } from "./skill-usage";

let home: string;

beforeEach(async () => {
  home = await makeTmpDir();
});

afterEach(async () => {
  await removeDir(home);
});

test("no file reads as no usage", async () => {
  expect({ ...(await readSkillUsage(home)) }).toEqual({});
});

test("recordSkillUse counts uses and keeps the last time, owner-only", async () => {
  await recordSkillUse(home, "deploy", new Date("2026-10-01T00:00:00Z"));
  await recordSkillUse(home, "deploy", new Date("2026-10-02T00:00:00Z"));
  await recordSkillUse(home, "review", new Date("2026-10-03T00:00:00Z"));
  expect({ ...(await readSkillUsage(home)) }).toEqual({
    deploy: { uses: 2, lastUsed: "2026-10-02T00:00:00.000Z" },
    review: { uses: 1, lastUsed: "2026-10-03T00:00:00.000Z" },
  });
  expect(usagePath(home)).toBe(join(home, "workspace", "skills", ".usage.json"));
  expect((await stat(usagePath(home))).mode & 0o777).toBe(0o600);
});

test("parallel uses are all counted", async () => {
  await Promise.all(Array.from({ length: 5 }, () => recordSkillUse(home, "x")));
  expect((await readSkillUsage(home)).x?.uses).toBe(5);
});

test("corrupt files and bad records are tolerated", async () => {
  await mkdir(join(home, "workspace", "skills"), { recursive: true });
  await writeFile(usagePath(home), "{not json");
  expect({ ...(await readSkillUsage(home)) }).toEqual({});
  await writeFile(usagePath(home), "[1,2]");
  expect({ ...(await readSkillUsage(home)) }).toEqual({});
  await writeFile(usagePath(home), JSON.stringify({ ok: { uses: 1, lastUsed: "t" }, bad: { uses: "x" }, nul: null, inf: { uses: null, lastUsed: "t" } }));
  expect({ ...(await readSkillUsage(home)) }).toEqual({ ok: { uses: 1, lastUsed: "t" } });
  await recordSkillUse(home, "__proto__", new Date("2026-10-01T00:00:00Z"));
  const usage = await readSkillUsage(home);
  expect(usage["__proto__"]).toEqual({ uses: 1, lastUsed: "2026-10-01T00:00:00.000Z" });
  expect(JSON.parse(await readFile(usagePath(home), "utf8")).ok).toEqual({ uses: 1, lastUsed: "t" });
});

test("a failed write rejects but later writes still work", async () => {
  await mkdir(usagePath(home), { recursive: true });
  await expect(recordSkillUse(home, "x")).rejects.toThrow();
  await rm(usagePath(home), { recursive: true });
  await recordSkillUse(home, "x");
  expect((await readSkillUsage(home)).x?.uses).toBe(1);
});

test("an un-migrated home keeps counting in ~/.tropos/skills until the migration moves it", async () => {
  await mkdir(join(home, "skills"), { recursive: true });
  await recordSkillUse(home, "deploy", new Date("2026-10-01T00:00:00Z"));
  expect(usagePath(home)).toBe(join(home, "skills", ".usage.json"));
  expect((await readSkillUsage(home)).deploy?.uses).toBe(1);
});
