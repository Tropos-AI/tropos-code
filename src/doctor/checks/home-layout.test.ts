import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { makeFixture, runOne, type Fixture } from "../testing";
import { homeLayoutCheck } from "./home-layout";

let fx: Fixture;
afterEach(() => fx?.close());

test("a current or empty home is ok", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, homeLayoutCheck)).findings[0]!.level).toBe("ok");
});

test("a legacy home is a safe fixable warning, and the fix moves it", async () => {
  fx = await makeFixture();
  await fx.write("memories/USER.md", "u");
  const r = await runOne(fx, homeLayoutCheck, { fix: true });
  const f = r.findings[0]!;
  expect(f).toMatchObject({ level: "warn", fixable: true, safe: true, fixed: true });
  expect(existsSync(`${fx.home}/workspace/USER.md`)).toBe(true);
  expect((await runOne(fx, homeLayoutCheck)).findings[0]!.level).toBe("ok");
});

test("a legacy home is only reported without --fix", async () => {
  fx = await makeFixture();
  await fx.write("skills/a/SKILL.md", "s");
  const f = (await runOne(fx, homeLayoutCheck)).findings[0]!;
  expect(f.message).toContain("skills");
  expect(existsSync(`${fx.home}/skills/a/SKILL.md`)).toBe(true);
});

test("both copies is a warning without a fix", async () => {
  fx = await makeFixture();
  await fx.write("memories/USER.md", "old");
  await fx.write("workspace/USER.md", "new");
  const fs = (await runOne(fx, homeLayoutCheck)).findings;
  const both = fs.find((f) => f.id === "home.layout.conflicts")!;
  expect(both.level).toBe("warn");
  expect(both.fixable).toBeUndefined();
  expect(both.detail).toContain("Keep the one you want");
});

test("notes that can't be placed are info", async () => {
  fx = await makeFixture();
  await fx.write("projects/zzz/notes/2026-10-15.md", "- x\n");
  const f = (await runOne(fx, homeLayoutCheck)).findings.find((x) => x.id === "home.layout.notes")!;
  expect(f.level).toBe("info");
});
