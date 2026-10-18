// src/web/file-lock.ts — exclusive cross-process lock (O_EXCL lockfile) around a read-modify-write of a state file.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const STALE_MS = 10_000;
const RETRY_MS = 15;
const GIVE_UP_MS = 15_000;

const readToken = async (lock: string): Promise<string | null> => {
  try {
    return await readFile(lock, "utf8");
  } catch {
    return null;
  }
};

/**
 * Runs `fn` while holding `<path>.lock`. A lock older than 10 s belonged to a crashed process and is taken over.
 * The lock file holds a random token: only its owner removes it, and a stale one is removed only if it is still the
 * very file judged stale, so a slow process can't delete the lock a faster one has just taken over.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const token = randomBytes(16).toString("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      const h = await open(lock, "wx", 0o600);
      try {
        await h.writeFile(token);
      } finally {
        await h.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const seen = await readToken(lock);
        if (Date.now() - (await stat(lock)).mtimeMs > STALE_MS && (await readToken(lock)) === seen) await rm(lock, { force: true });
      } catch {
        // released between the two calls: retry straight away
      }
      if (Date.now() - start > GIVE_UP_MS) throw new Error(`could not lock ${path}`);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    // Ours only: if the lock was taken over while fn ran (it ran longer than the stale limit), leave the new owner's.
    if ((await readToken(lock)) === token) await rm(lock, { force: true });
  }
}
