// src/install/check.ts — "is there a newer release?" without installing: what `tcode update` asks first, as its own call
// (the web admin API uses it). It records only when the check happened; nextCheck stays the background updater's own.
import type { Channel } from "./channels";
import { resolveChannel, type Resolution } from "./channels";
import type { FlockFn } from "./flock";
import type { Layout } from "./layout";
import { acquireInstallLock } from "./locks";
import type { RemoteDeps } from "./remote";
import { readState, writeState } from "./state";
import { compareVersions } from "./version";

export interface CheckDeps extends RemoteDeps {
  layout: Layout;
  selfVersion: string;
  flock?: FlockFn;
  now?: () => Date;
}

export interface CheckResult {
  channel: Channel;
  latest: string;
  source: Resolution["source"];
  checkedAt: string;
  /** Newer than `current`, which is the version the caller runs. */
  available: boolean;
}

/** Asks the channel for its newest version and notes the time in the install state (skipped quietly when the state or lock is not available). */
export async function checkForUpdate(deps: CheckDeps, channel: Channel, current: string): Promise<CheckResult> {
  const resolved = await resolveChannel(channel, deps);
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  try {
    const lock = await acquireInstallLock(deps.layout, { wait: false, version: deps.selfVersion, flock: deps.flock });
    if (lock) {
      try {
        const read = await readState(deps.layout);
        if (read.kind === "ok") await writeState(deps.layout, { ...read.state, autoUpdate: { ...read.state.autoUpdate, lastCheck: checkedAt } });
      } finally {
        lock.release();
      }
    }
  } catch {
    // Recording is a courtesy; the answer is still good.
  }
  return { channel, latest: resolved.version, source: resolved.source, checkedAt, available: compareVersions(resolved.version, current) > 0 };
}
