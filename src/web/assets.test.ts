// src/web/assets.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { assetsFromDir, contentType, loadAssets } from "./assets";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

test("every file under the build folder, by URL path", async () => {
  await mkdir(join(dir, "assets", "fonts"), { recursive: true });
  await writeFile(join(dir, "index.html"), "x");
  await writeFile(join(dir, "assets", "fonts", "tektur.woff2"), "x");
  const map = assetsFromDir(dir);
  expect([...map.keys()].sort()).toEqual(["/assets/fonts/tektur.woff2", "/index.html"]);
  expect(map.get("/index.html")).toBe(join(dir, "index.html"));
  expect(assetsFromDir(join(dir, "missing")).size).toBe(0);
});

test("from source (no embedded module) the files come from the fallback folder", async () => {
  await writeFile(join(dir, "index.html"), "x");
  const map = await loadAssets(dir);
  expect(map.has("/index.html")).toBe(true);
});

test("content types", () => {
  expect(contentType("/a.js")).toBe("text/javascript; charset=utf-8");
  expect(contentType("/a.WOFF2")).toBe("font/woff2");
  expect(contentType("/a.bin")).toBe("application/octet-stream");
});
