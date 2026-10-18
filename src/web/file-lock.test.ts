import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { withFileLock } from "./file-lock";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await makeTmpDir("file-lock");
  path = join(dir, "state.json");
});
afterEach(() => removeDir(dir));

test("the lock holds a token while held and is gone after", async () => {
  await withFileLock(path, async () => {
    expect((await readFile(`${path}.lock`, "utf8")).length).toBeGreaterThanOrEqual(16);
  });
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a stale lock from a crashed process is taken over", async () => {
  await writeFile(`${path}.lock`, "dead-process-token");
  const old = new Date(Date.now() - 60_000);
  await utimes(`${path}.lock`, old, old);
  expect(await withFileLock(path, async () => "ran")).toBe("ran");
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("release leaves a lock that another process took over while this one ran long", async () => {
  await withFileLock(path, async () => {
    // Taken over as stale by someone else, who now holds it under its own token.
    await writeFile(`${path}.lock`, "the-new-owner");
  });
  expect(await readFile(`${path}.lock`, "utf8")).toBe("the-new-owner");
});

test("a fresh lock held by someone else is waited for, not removed", async () => {
  await writeFile(`${path}.lock`, "live-owner");
  const waiting = withFileLock(path, async () => "got it");
  await Bun.sleep(100);
  expect(await readFile(`${path}.lock`, "utf8")).toBe("live-owner");
  await rm(`${path}.lock`);
  expect(await waiting).toBe("got it");
});
