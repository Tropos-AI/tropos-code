// src/install/engine.ts
import type { FlockFn } from "./flock";
import { checkSafeDir, ensureLayout, type DirOwner, type Layout } from "./layout";
import { acquireInstallLock, type LockInfo } from "./locks";
import type { Platform } from "./platform";
import { recover, type RecoveryReport } from "./recovery";
import type { RemoteDeps } from "./remote";
import { emptyState, readState, writeState, type InstallState } from "./state";
import type { HealthCheck, VerifyContext } from "./verify";

/** Named points where tests kill the process to prove crash consistency (spec §13 layer 4). Not reachable from the CLI. */
export type CrashPoint = "after-download" | "after-rename" | "after-pending" | "after-swap" | "after-state" | "mid-cleanup";

export interface EngineDeps extends RemoteDeps {
  layout: Layout;
  platform: Platform;
  health: HealthCheck;
  /** The running binary's version; recorded in the install lock for "who holds it" messages. */
  selfVersion: string;
  user?: DirOwner;
  flock?: FlockFn;
  lockTimeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  crash?: (point: CrashPoint) => void;
}

export function verifyContext(d: EngineDeps): VerifyContext {
  return { layout: d.layout, platform: d.platform, trusted: d.trusted, health: d.health, user: d.user };
}

export class EngineSession {
  readonly ctx: VerifyContext;

  constructor(
    readonly deps: EngineDeps,
    public state: InstallState,
  ) {
    this.ctx = verifyContext(deps);
  }

  async save(patch: Partial<InstallState>): Promise<void> {
    this.state = await writeState(this.deps.layout, { ...this.state, ...patch });
  }

  crash(point: CrashPoint): void {
    this.deps.crash?.(point);
  }

  log(line: string): void {
    this.deps.log?.(line);
  }

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export interface LockedRun<T> {
  value: T;
  recovery: RecoveryReport;
}

/** Every engine operation: safe directories, install lock, state, recovery — then `fn` (spec §10.3 step 1). */
export async function withInstallLock<T>(
  deps: EngineDeps,
  opts: { wait: boolean; onWait?: (holder: LockInfo | null) => void },
  fn: (s: EngineSession, recovery: RecoveryReport) => Promise<T>,
): Promise<LockedRun<T> | null> {
  await ensureLayout(deps.layout);
  await checkSafeDir(deps.layout.data, deps.user);
  await checkSafeDir(deps.layout.state, deps.user);
  const lock = await acquireInstallLock(deps.layout, {
    wait: opts.wait,
    version: deps.selfVersion,
    timeoutMs: deps.lockTimeoutMs,
    flock: deps.flock,
    sleep: deps.sleep,
    onWait: opts.onWait,
  });
  if (!lock) return null;
  try {
    const read = await readState(deps.layout);
    const session = new EngineSession(deps, read.kind === "ok" ? read.state : emptyState());
    const recovery = await recover(session, read);
    return { value: await fn(session, recovery), recovery };
  } finally {
    lock.release();
  }
}
