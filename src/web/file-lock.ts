// src/web/file-lock.ts — exclusive cross-process lock (O_EXCL lockfile) around a read-modify-write of a state file.
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const STALE_MS = 10_000;
const RETRY_MS = 15;
const GIVE_UP_MS = 15_000;

/** Runs `fn` while holding `<path>.lock`. A lock older than 10 s belonged to a crashed process and is taken over. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      const h = await open(lock, "wx", 0o600);
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > STALE_MS) await rm(lock, { force: true });
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
    await rm(lock, { force: true });
  }
}
