import { afterEach, beforeEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { readOnboardingFlags } from "../onboard/flags";
import { SuggestionStore } from "./store";

let home: string;
let store: SuggestionStore;
beforeEach(async () => {
  home = await makeTmpDir("suggest-store-");
  store = new SuggestionStore(home);
});
afterEach(() => removeDir(home));

test("starts empty and records outcomes with their time", async () => {
  expect(await store.read()).toEqual({ declined: {}, mentioned: {}, tests: {} });
  await store.mark("routine", "mentioned", 5);
  await store.mark("cron-failing:j1", "declined", 6);
  const s = await store.read();
  expect(s.mentioned).toEqual({ routine: 5 });
  expect(s.declined).toEqual({ "cron-failing:j1": 6 });
});

test("accepted counts as declined for listing", async () => {
  await store.mark("routine", "accepted", 7);
  expect((await store.read()).declined).toEqual({ routine: 7 });
});

test("the file is private", async () => {
  await store.mark("routine", "mentioned");
  expect(statSync(`${home}/learning/suggestions.json`).mode & 0o777).toBe(0o600);
});

test("marking a setup signal records it in the onboarding reminded list", async () => {
  await store.mark("setup:telegram", "mentioned");
  expect((await readOnboardingFlags(home)).reminded).toContain("telegram");
  await store.mark("setup:phone", "declined");
  expect((await readOnboardingFlags(home)).reminded).toEqual(["telegram", "phone"]);
});

test("a test result is kept per project", async () => {
  await store.recordTest("app", "bun test", false, 9);
  await store.recordTest("app", "bun test", true, 10);
  expect((await store.read()).tests.app).toEqual({ ok: true, at: 10, command: "bun test" });
});

test("a damaged file reads as empty", async () => {
  await store.mark("routine", "mentioned");
  await Bun.write(`${home}/learning/suggestions.json`, "{nope");
  expect(await store.read()).toEqual({ declined: {}, mentioned: {}, tests: {} });
});

test("concurrent marks all land", async () => {
  await Promise.all([store.mark("a", "mentioned"), store.mark("b", "mentioned"), store.recordTest("p", "c", true)]);
  const s = await store.read();
  expect(Object.keys(s.mentioned).sort()).toEqual(["a", "b"]);
  expect(s.tests.p).toBeDefined();
});
