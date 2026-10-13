// src/install/locks.ts
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { InstallError, fromFsError } from "./errors";
import { LOCK_EX, LOCK_NB, LOCK_SH, LOCK_UN, loadFlock, type FlockFn } from "./flock";
import { installLockPath, versionLockPath, type Layout } from "./layout";

export interface LockHandle {
  readonly path: string;
  readonly fd: number;
  release(): void;
}

/** Informational only: who holds the install lock. Correctness never depends on it (spec §10.1). */
export interface LockInfo {
  pid: number;
  token: string;
  version: string;
  acquiredAt: string;
}

const OPEN_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;

/**
 * One non-blocking attempt. After flock succeeds, the locked file must still be the file at `path`
 * (same inode); otherwise it was replaced in between and we try again. Lock files are never deleted.
 */
export function tryLock(path: string, mode: typeof LOCK_SH | typeof LOCK_EX, flock: FlockFn = loadFlock()): LockHandle | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, OPEN_FLAGS, 0o600);
    } catch (e) {
      throw fromFsError(e, `opening the lock file ${path}`);
    }
    if (flock(fd, mode | LOCK_NB) !== 0) {
      closeSync(fd);
      return null;
    }
    let same = false;
    try {
      same = fstatSync(fd).ino === statSync(path).ino;
    } catch {
      same = false;
    }
    if (same) {
      let released = false;
      return {
        path,
        fd,
        release() {
          if (released) return;
          released = true;
          flock(fd, LOCK_UN);
          closeSync(fd);
        },
      };
    }
    flock(fd, LOCK_UN);
    closeSync(fd);
  }
  throw new InstallError("local", `the lock file ${path} keeps being replaced`);
}

export function readLockInfo(path: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return typeof info.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

export interface AcquireOptions {
  wait: boolean;
  version: string;
  timeoutMs?: number;
  pollMs?: number;
  flock?: FlockFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (holder: LockInfo | null) => void;
  writeInfo?: (fd: number, json: string) => void;
}

function defaultWriteInfo(fd: number, json: string): void {
  ftruncateSync(fd, 0);
  writeSync(fd, json, 0);
}

/** The install lock (spec §10.1): foreground callers wait up to 60 s, then `busy`; background callers don't wait. */
export async function acquireInstallLock(l: Layout, opts: AcquireOptions): Promise<LockHandle | null> {
  const path = installLockPath(l);
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 60_000);
  let told = false;
  for (;;) {
    const handle = tryLock(path, LOCK_EX, opts.flock);
    if (handle) {
      const info: LockInfo = { pid: process.pid, token: randomUUID(), version: opts.version, acquiredAt: new Date().toISOString() };
      try {
        (opts.writeInfo ?? defaultWriteInfo)(handle.fd, JSON.stringify(info));
      } catch {
        // The holder info is informational only (spec 10.1); a failed write must not strand the lock.
      }
      return handle;
    }
    if (!opts.wait) return null;
    if (!told) {
      opts.onWait?.(readLockInfo(path));
      told = true;
    }
    if (now() >= deadline) {
      const holder = readLockInfo(path);
      const who = holder ? ` (pid ${holder.pid}, version ${holder.version}, since ${holder.acquiredAt})` : "";
      throw new InstallError("busy", `another Tropos install or update is still running${who}; try again when it has finished`);
    }
    await sleep(opts.pollMs ?? 250);
  }
}

/** Cleanup and damaged-binary replacement: succeeds only when no process runs version `v`. */
export function tryLockVersionExclusive(l: Layout, v: string, flock?: FlockFn): LockHandle | null {
  return tryLock(versionLockPath(l, v), LOCK_EX, flock);
}

/** Sessions: a shared lock on their own version. Waits briefly while cleanup holds the exclusive lock. */
export async function lockVersionShared(l: Layout, v: string, opts: { attempts?: number; pollMs?: number; flock?: FlockFn } = {}): Promise<LockHandle | null> {
  const attempts = opts.attempts ?? 40;
  for (let i = 0; i < attempts; i++) {
    const handle = tryLock(versionLockPath(l, v), LOCK_SH, opts.flock);
    if (handle) return handle;
    await Bun.sleep(opts.pollMs ?? 50);
  }
  return null;
}
