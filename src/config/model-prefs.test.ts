// src/config/model-prefs.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { MAX_RECENT, ModelPrefs } from "./model-prefs";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

test("starts empty; recent is newest first, de-duplicated and capped", async () => {
  const prefs = new ModelPrefs(home);
  expect(await prefs.get()).toEqual({ recent: [], favorites: [] });
  for (let i = 0; i < MAX_RECENT + 2; i++) await prefs.recordUse(`m${i}`);
  await prefs.recordUse("m5");
  const { recent } = await prefs.get();
  expect(recent[0]).toBe("m5");
  expect(recent).toHaveLength(MAX_RECENT);
  expect(new Set(recent).size).toBe(MAX_RECENT);
});

test("favorites toggle, and parallel updates keep each other", async () => {
  const prefs = new ModelPrefs(home);
  expect(await prefs.toggleFavorite("a")).toBe(true);
  await Promise.all([prefs.toggleFavorite("b"), prefs.recordUse("c")]);
  expect(await prefs.get()).toEqual({ recent: ["c"], favorites: ["b", "a"] });
  expect(await prefs.toggleFavorite("a")).toBe(false);
  expect((await prefs.get()).favorites).toEqual(["b"]);
});

test("a damaged or foreign file reads as empty", async () => {
  const prefs = new ModelPrefs(home);
  await writeFile(join(home, "models.json"), "{not json");
  expect(await prefs.get()).toEqual({ recent: [], favorites: [] });
  await writeFile(join(home, "models.json"), JSON.stringify({ recent: 3 }));
  expect(await prefs.get()).toEqual({ recent: [], favorites: [] });
});
