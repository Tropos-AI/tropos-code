// src/install/session.ts
import { existsSync } from "node:fs";
import { announcement, markAnnounced, shouldCheck, spawnBackgroundUpdate } from "./autoupdate";
import { nativeVersionOf, resolveLayout } from "./layout";
import { lockVersionShared } from "./locks";
import { readState } from "./state";
import { isManaged } from "./verify";

export interface NativeSessionDeps {
  env: NodeJS.ProcessEnv;
  execPath: string;
  print: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  autoUpdates: boolean;
  version: string;
  now?: () => Date;
  spawn?: typeof Bun.spawn;
}

export type NativeSessionStart =
  | { kind: "not-native" }
  | { kind: "reexec"; via: string }
  | { kind: "native"; version: string; holdsLock: boolean; announcement: string | null; updateSpawned: boolean };

/**
 * Spec §10.1 and §11: hold a shared lock on our own version for the whole session; if our binary vanished
 * before we locked it, run again through ~/.local/bin/tropos; announce a finished update; maybe start one.
 */
export async function startNativeSession(d: NativeSessionDeps): Promise<NativeSessionStart> {
  const layout = resolveLayout(d.env);
  const version = nativeVersionOf(layout, d.execPath);
  if (version === null) return { kind: "not-native" };
  // The loop guard is for this process only; descendants (Bash-tool commands, nested tropos) must not inherit it.
  const reexeced = Boolean(d.env.TROPOS_REEXEC);
  delete d.env.TROPOS_REEXEC;
  delete process.env.TROPOS_REEXEC;
  const lock = await lockVersionShared(layout, version).catch(() => null);
  if (!existsSync(d.execPath) && !reexeced) {
    lock?.release();
    return { kind: "reexec", via: layout.binLink };
  }
  const read = await readState(layout).catch(() => ({ kind: "missing" as const }));
  const state = read.kind === "ok" ? read.state : null;
  const interactive = !d.print && d.stdinTTY && d.stdoutTTY;
  const message = interactive && state ? announcement(state) : null;
  if (message) await markAnnounced({ layout, selfVersion: d.version }).catch(() => {});
  const decision = shouldCheck({ env: d.env, native: true, print: d.print, stdinTTY: d.stdinTTY, stdoutTTY: d.stdoutTTY, autoUpdates: d.autoUpdates, state, now: d.now?.() ?? new Date() });
  // An unmanaged local build never starts background updates (they would replace it with a release).
  const updateSpawned = decision.check && (await isManaged(layout, version)) ? spawnBackgroundUpdate(d.execPath, layout, d.env, d.spawn) : false;
  return { kind: "native", version, holdsLock: lock !== null, announcement: message, updateSpawned };
}
