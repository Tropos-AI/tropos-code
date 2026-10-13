// src/install/cleanup.ts
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EngineSession } from "./engine";
import { describeError } from "./errors";
import { manifestDir, versionPath } from "./layout";
import { tryLockVersionExclusive } from "./locks";
import { checkVerified, listManagedVersions } from "./verify";
import { isVersion } from "./version";

export const KEEP_NEWEST = 3;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_RE = /^\.corrupt-(.+)-(\d+)$/;

/**
 * Spec §10.5. Deletes only managed versions outside the keep set, and only while holding their exclusive
 * version lock, which no running session shares. Unmanaged files and `.unmanaged-*` are never touched.
 */
export async function cleanup(s: EngineSession): Promise<string[]> {
  const l = s.deps.layout;
  const now = s.now().getTime();
  const removed: string[] = [];
  const st = s.state;

  const managed = await listManagedVersions(l);
  const verified: string[] = [];
  for (const v of managed) if ((await checkVerified(s.ctx, v)).ok) verified.push(v);
  const keep = new Set([st.current, st.previous, st.pending?.from ?? null, st.pending?.to ?? null, ...verified.slice(0, KEEP_NEWEST)].filter((v): v is string => v !== null));

  // Each entry is handled on its own: one that cannot be removed is logged and skipped, never aborting the rest.
  const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      s.log(`cleanup: could not remove ${what}: ${describeError(e)}`);
    }
  };

  for (const v of managed) {
    if (keep.has(v)) continue;
    await attempt(v, async () => {
      const lock = tryLockVersionExclusive(l, v, s.deps.flock);
      if (!lock) {
        s.log(`kept ${v}: a running session uses it`);
        return;
      }
      try {
        s.crash("mid-cleanup");
        await rm(versionPath(l, v), { force: true });
        await rm(manifestDir(l, v), { recursive: true, force: true });
        removed.push(v);
      } finally {
        lock.release();
      }
    });
  }

  for (const name of await readdir(l.versions)) {
    const m = QUARANTINE_RE.exec(name);
    if (!m || !isVersion(m[1]) || now - Number(m[2]) < QUARANTINE_MAX_AGE_MS) continue;
    await attempt(name, async () => {
      const lock = tryLockVersionExclusive(l, m[1]!, s.deps.flock);
      if (!lock) return;
      try {
        await rm(join(l.versions, name), { force: true });
        removed.push(name);
      } finally {
        lock.release();
      }
    });
  }

  for (const name of await readdir(l.staging)) {
    const path = join(l.staging, name);
    await attempt(`staging/${name}`, async () => {
      const info = await lstat(path).catch(() => null);
      if (info && now - info.mtimeMs > STAGING_MAX_AGE_MS) {
        await rm(path, { recursive: true, force: true });
        removed.push(`staging/${name}`);
      }
    });
  }
  return removed;
}
