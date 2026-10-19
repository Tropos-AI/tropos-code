// src/gateway/instance-lock.ts — one gateway per Tropos home: a lockfile held for the gateway's whole life. Two
// gateways would poll the same bot (Telegram answers only one), write the same state.json and run each job twice.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { gatewayDir } from "./config";

export const gatewayLockPath = (home: string): string => join(gatewayDir(home), "gateway.lock");

export type GatewayLock = { ok: true; release(): Promise<void> } | { ok: false; pid: number };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function holder(path: string): Promise<{ pid: number; token: string } | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; token?: unknown };
    return typeof raw.pid === "number" && Number.isInteger(raw.pid) && typeof raw.token === "string" ? { pid: raw.pid, token: raw.token } : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock (O_EXCL), or says which live process holds it. A lock whose process is gone (a crash, a kill -9) is
 * taken over; one that can't be read is too, since a gateway always writes it whole. Only the owner's release removes it.
 */
export async function acquireGatewayLock(home: string, isAlive: (pid: number) => boolean = alive): Promise<GatewayLock> {
  const path = gatewayLockPath(home);
  await mkdir(gatewayDir(home), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const h = await open(path, "wx", 0o600);
      try {
        await h.writeFile(JSON.stringify({ pid: process.pid, token }));
      } finally {
        await h.close();
      }
      return {
        ok: true,
        release: async () => {
          if ((await holder(path))?.token === token) await rm(path, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let held = await holder(path);
      if (!held) {
        // Another gateway may be between creating the file and writing it: look once more before calling it stale.
        await new Promise((r) => setTimeout(r, 100));
        held = await holder(path);
      }
      if (held && isAlive(held.pid)) return { ok: false, pid: held.pid };
      // Stale: remove it only if it is still the file judged stale, then try again.
      if ((await holder(path))?.token === held?.token) await rm(path, { force: true });
    }
  }
  const held = await holder(path);
  return { ok: false, pid: held?.pid ?? 0 };
}
