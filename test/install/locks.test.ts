// test/install/locks.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renameSync, statSync, symlinkSync, writeFileSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { InstallError } from "../../src/install/errors";
import { LOCK_EX, LOCK_SH, loadFlock } from "../../src/install/flock";
import { ensureLayout, installLockPath, resolveLayout, type Layout } from "../../src/install/layout";
import { acquireInstallLock, lockVersionShared, readLockInfo, tryLock, tryLockVersionExclusive } from "../../src/install/locks";
import { makeTmpDir, removeDir } from "../helpers/tmp";

let dir: string;
let l: Layout;
const children: Array<ReturnType<typeof Bun.spawn>> = [];
beforeEach(async () => {
  dir = await makeTmpDir();
  l = resolveLayout({ HOME: dir });
  await ensureLayout(l);
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await removeDir(dir);
});

async function holdInChild(path: string, mode: "sh" | "ex") {
  const child = Bun.spawn(["bun", join(import.meta.dir, "helpers/hold-lock.ts"), path, mode], { stdout: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value).trim()).toBe("locked");
  return child;
}

describe("tryLock", () => {
  test("exclusive excludes everything; shared excludes only exclusive", () => {
    const path = join(l.locks, "a.lock");
    const ex = tryLock(path, LOCK_EX)!;
    expect(tryLock(path, LOCK_EX)).toBeNull();
    expect(tryLock(path, LOCK_SH)).toBeNull();
    ex.release();
    const sh1 = tryLock(path, LOCK_SH)!;
    const sh2 = tryLock(path, LOCK_SH)!;
    expect(tryLock(path, LOCK_EX)).toBeNull();
    sh1.release();
    sh2.release();
    expect(tryLock(path, LOCK_EX)).not.toBeNull();
  });

  test("another process holding the lock blocks us; kill -9 releases it at once", async () => {
    const path = join(l.locks, "b.lock");
    const child = await holdInChild(path, "ex");
    expect(tryLock(path, LOCK_EX)).toBeNull();
    child.kill("SIGKILL");
    await child.exited;
    expect(tryLock(path, LOCK_EX)).not.toBeNull();
  });

  test("detects a lock file replaced between open and flock (inode check)", () => {
    const path = join(l.locks, "c.lock");
    writeFileSync(path, "");
    const real = loadFlock();
    let replaced = false;
    const flock = (fd: number, op: number) => {
      const rc = real(fd, op);
      if (!replaced) {
        replaced = true;
        writeFileSync(`${path}.new`, "");
        renameSync(`${path}.new`, path);
      }
      return rc;
    };
    const handle = tryLock(path, LOCK_EX, flock)!;
    expect(fstatSync(handle.fd).ino).toBe(statSync(path).ino);
  });

  test("a lock path that is a symlink is refused", () => {
    const path = join(l.locks, "d.lock");
    symlinkSync(join(dir, "elsewhere"), path);
    expect(() => tryLock(path, LOCK_EX)).toThrow(InstallError);
  });
});

describe("acquireInstallLock", () => {
  test("records who holds it", async () => {
    const h = (await acquireInstallLock(l, { wait: false, version: "1.2.3" }))!;
    expect(readLockInfo(installLockPath(l))).toMatchObject({ pid: process.pid, version: "1.2.3" });
    h.release();
  });

  test("a failed holder-info write still returns a releasable handle", async () => {
    const writeInfo = () => {
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    };
    const h = (await acquireInstallLock(l, { wait: false, version: "1.2.3", writeInfo }))!;
    expect(h).not.toBeNull();
    h.release();
    const again = await acquireInstallLock(l, { wait: false, version: "1.2.3" });
    expect(again).not.toBeNull();
    again!.release();
  });

  test("non-waiting returns null when busy", async () => {
    await holdInChild(installLockPath(l), "ex");
    expect(await acquireInstallLock(l, { wait: false, version: "1.2.3" })).toBeNull();
  });

  test("waiting gives up with busy after the timeout and names the holder", async () => {
    const h = (await acquireInstallLock(l, { wait: false, version: "0.9.0" }))!;
    let clock = 0;
    let told: unknown;
    const err = (await acquireInstallLock(l, {
      wait: true,
      version: "1.0.0",
      timeoutMs: 60_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      onWait: (holder) => void (told = holder),
    }).catch((e) => e)) as InstallError;
    expect(err.kind).toBe("busy");
    expect(err.message).toContain(`pid ${process.pid}, version 0.9.0`);
    expect(told).toMatchObject({ version: "0.9.0" });
    h.release();
  });
});

describe("version locks", () => {
  test("a session's shared lock blocks cleanup's exclusive lock", async () => {
    const shared = (await lockVersionShared(l, "1.0.0"))!;
    expect(tryLockVersionExclusive(l, "1.0.0")).toBeNull();
    shared.release();
    expect(tryLockVersionExclusive(l, "1.0.0")).not.toBeNull();
  });

  test("lockVersionShared waits briefly for cleanup, then gives up with null", async () => {
    const ex = tryLockVersionExclusive(l, "2.0.0")!;
    expect(await lockVersionShared(l, "2.0.0", { attempts: 3, pollMs: 1 })).toBeNull();
    ex.release();
  });
});
