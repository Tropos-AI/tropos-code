// src/install/autoupdate.ts
import { closeSync, openSync, renameSync, statSync } from "node:fs";
import type { Channel } from "./channels";
import type { EngineDeps } from "./engine";
import { minimalEnv } from "./env";
import { describeError } from "./errors";
import { updateChannel } from "./installer";
import type { Layout } from "./layout";
import { acquireInstallLock } from "./locks";
import { readState, writeState, type InstallState } from "./state";
import { isManaged } from "./verify";

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAX_INTERVAL_MS = 48 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;

export interface AutoUpdateInputs {
  env: NodeJS.ProcessEnv;
  native: boolean;
  print: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  autoUpdates: boolean;
  state: InstallState | null;
  now: Date;
  /** The gateway asking: it runs for days without a terminal, so the terminal rule doesn't apply to it. */
  gateway?: boolean;
}

export type CheckDecision = { check: true } | { check: false; reason: string };

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** Whether a background check is due. A nextCheck more than 48 h ahead means the clock moved back; it counts as due. */
export function shouldCheck(i: AutoUpdateInputs): CheckDecision {
  if (!i.native) return { check: false, reason: "not-native" };
  if (i.print) return { check: false, reason: "print-mode" };
  if (!i.gateway && (!i.stdinTTY || !i.stdoutTTY)) return { check: false, reason: "not-a-terminal" };
  if (truthy(i.env.CI)) return { check: false, reason: "ci" };
  if (truthy(i.env.TROPOS_DISABLE_AUTOUPDATER)) return { check: false, reason: "disabled-by-env" };
  if (!i.autoUpdates) return { check: false, reason: "disabled-by-setting" };
  const next = i.state?.autoUpdate.nextCheck ? Date.parse(i.state.autoUpdate.nextCheck) : 0;
  const ahead = next - i.now.getTime();
  if (ahead > 0 && ahead <= MAX_INTERVAL_MS) return { check: false, reason: "not-due" };
  return { check: true };
}

export function nextCheckAfter(now: Date, failures: number): Date {
  return new Date(now.getTime() + Math.min(CHECK_INTERVAL_MS * 2 ** failures, MAX_INTERVAL_MS));
}

/** "Updated to X", once, and only while X is what is installed: a later manual install makes an older notice stale. */
export function announcement(state: InstallState): string | null {
  const a = state.autoUpdate;
  return a.lastUpdated && !a.announced && a.lastUpdated === state.current ? `Updated to ${a.lastUpdated}` : null;
}

/** Detached `tcode update --background` with the minimal environment; output appended to update.log. */
export function spawnBackgroundUpdate(execPath: string, layout: Layout, env: NodeJS.ProcessEnv, spawn: typeof Bun.spawn = Bun.spawn): boolean {
  try {
    try {
      if (statSync(layout.log).size > MAX_LOG_BYTES) renameSync(layout.log, `${layout.log}.1`);
    } catch {
      // no log yet
    }
    const fd = openSync(layout.log, "a", 0o600);
    try {
      const proc = spawn([execPath, "update", "--background"], { env: minimalEnv(env), stdin: "ignore", stdout: fd, stderr: fd, detached: true } as Parameters<typeof Bun.spawn>[1]);
      proc.unref();
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export interface GatewayUpdateDeps {
  env: NodeJS.ProcessEnv;
  execPath: string;
  layout: Layout;
  /** The owner's setting, read again at every check so the dashboard's switch applies at once. */
  autoUpdates: boolean;
  /** The version the gateway runs. */
  version: string;
  now?: () => Date;
  spawn?: typeof Bun.spawn;
}

/**
 * The gateway's own check: an owner who only uses Telegram never opens a terminal, which is where checks start
 * otherwise. Same rules (setting, env, schedule); an unmanaged local build never updates. True when one was started.
 */
export async function startDueGatewayUpdate(d: GatewayUpdateDeps): Promise<boolean> {
  const read = await readState(d.layout).catch(() => ({ kind: "missing" as const }));
  const state = read.kind === "ok" ? read.state : null;
  const decision = shouldCheck({ env: d.env, native: true, print: false, stdinTTY: false, stdoutTTY: false, gateway: true, autoUpdates: d.autoUpdates, state, now: d.now?.() ?? new Date() });
  if (!decision.check || !(await isManaged(d.layout, d.version))) return false;
  return spawnBackgroundUpdate(d.execPath, d.layout, d.env, d.spawn);
}

async function recordCheck(deps: EngineDeps, now: Date, ok: boolean, updatedTo: string | null): Promise<void> {
  const lock = await acquireInstallLock(deps.layout, { wait: false, version: deps.selfVersion, flock: deps.flock });
  if (!lock) return;
  try {
    const read = await readState(deps.layout);
    if (read.kind !== "ok") return;
    const prev = read.state.autoUpdate;
    const failures = ok ? 0 : Math.min(prev.failures + 1, 8);
    await writeState(deps.layout, {
      ...read.state,
      autoUpdate: {
        lastCheck: now.toISOString(),
        failures,
        nextCheck: nextCheckAfter(now, failures).toISOString(),
        lastUpdated: updatedTo ?? prev.lastUpdated,
        announced: updatedTo ? false : prev.announced,
      },
    });
  } finally {
    lock.release();
  }
}

/**
 * `tcode update --background`: never waits for the lock, only moves forward, records the check. Always
 * resolves, with the version it moved to (null when nothing changed).
 */
export async function runBackgroundUpdate(deps: EngineDeps, channel: Channel): Promise<string | null> {
  try {
    return await backgroundUpdate(deps, channel);
  } catch {
    // the detached updater must never crash
    return null;
  }
}

async function backgroundUpdate(deps: EngineDeps, channel: Channel): Promise<string | null> {
  const log = (line: string): void => {
    try {
      deps.log?.(line);
    } catch {
      // a broken log sink must not crash a background run
    }
  };
  let now: Date;
  try {
    now = deps.now?.() ?? new Date();
  } catch {
    now = new Date();
  }
  let ok = true;
  let updatedTo: string | null = null;
  try {
    // A local build the user installed is theirs to replace: no background update ever touches it.
    if (deps.runningVersion !== undefined && !(await isManaged(deps.layout, deps.runningVersion))) {
      log(`running ${deps.runningVersion}, an unmanaged local build; background updates are off for it`);
      return null;
    }
    // Recovery logs its actions through deps.log; a fatal recovery stops the run before anything is installed.
    const run = await updateChannel(deps, channel, { wait: false, background: true });
    if (!run) {
      log("another Tropos install is running; skipping this check");
      return null;
    }
    if (run.value.kind === "updated" && run.value.outcome.changed) updatedTo = run.value.outcome.version;
    log(`background check: ${run.value.kind}`);
  } catch (e) {
    ok = false;
    log(`background update failed: ${describeError(e)}`);
  }
  try {
    await recordCheck(deps, now, ok, updatedTo);
  } catch (e) {
    log(`could not record the update check: ${describeError(e)}`);
  }
  return updatedTo;
}

export async function markAnnounced(deps: Pick<EngineDeps, "layout" | "selfVersion" | "flock">): Promise<void> {
  const lock = await acquireInstallLock(deps.layout, { wait: false, version: deps.selfVersion, flock: deps.flock });
  if (!lock) return;
  try {
    const read = await readState(deps.layout);
    if (read.kind === "ok" && !read.state.autoUpdate.announced) {
      await writeState(deps.layout, { ...read.state, autoUpdate: { ...read.state.autoUpdate, announced: true } });
    }
  } finally {
    lock.release();
  }
}
