// src/web/devices.ts — browsers that logged in to the dashboard. Only the sha256 of each device key is stored.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "./file-lock";

export const DEVICE_TTL_MS = 365 * 24 * 3_600_000;
const NAME_MAX = 60;

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
  via: "local" | "tailscale";
}
interface Stored extends Device {
  hash: string;
}

export interface DeviceStoreOptions {
  path: string;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
}

export const devicesPath = (home: string): string => join(home, "gateway", "devices.json");

/** A label the owner will recognise in a list: no control characters, one line, at most 60 characters. */
export function cleanDeviceName(raw: string): string {
  const name = raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
  return name || "Browser";
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class DeviceStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Uint8Array;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: DeviceStoreOptions) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((n) => new Uint8Array(randomBytes(n)));
  }

  /** The key is shown once, to the browser that asked; it cannot be recovered from the file. */
  create(name: string, via: Device["via"] = "local"): Promise<{ id: string; key: string }> {
    return this.run((devices) => {
      const key = Buffer.from(this.random(32)).toString("base64url");
      const id = Buffer.from(this.random(8)).toString("hex");
      const now = this.now();
      devices.push({ id, name: cleanDeviceName(name), hash: sha256(key), createdAt: now, lastSeen: now, via });
      return { id, key };
    });
  }

  /** `via` is where this request came from; a device that ever came through loopback stays "local". */
  verify(key: string, via?: Device["via"]): Promise<Device | null> {
    return this.run((devices) => {
      const given = Buffer.from(sha256(key), "hex");
      // Every entry is compared, without stopping at the first match.
      let found: Stored | undefined;
      for (const d of devices) {
        if (timingSafeEqual(given, Buffer.from(d.hash, "hex")) && !found) found = d;
      }
      if (!found) return null;
      found.lastSeen = this.now();
      if (via === "local") found.via = "local";
      return publicOf(found);
    });
  }

  list(): Promise<Device[]> {
    return this.run((devices) => devices.map(publicOf));
  }

  revoke(id: string): Promise<boolean> {
    return this.run((devices) => {
      const at = devices.findIndex((d) => d.id === id);
      if (at < 0) return false;
      devices.splice(at, 1);
      return true;
    });
  }

  revokeAll(): Promise<number> {
    return this.run((devices) => devices.splice(0).length);
  }

  /** Serialises operations; re-reads the file first, drops expired devices, writes back when anything changed. */
  private run<T>(op: (devices: Stored[]) => T): Promise<T> {
    const next = this.queue.then(() => withFileLock(this.path, async () => {
      const devices = await this.load();
      const cutoff = this.now() - DEVICE_TTL_MS;
      const live = devices.filter((d) => d.lastSeen >= cutoff);
      const before = JSON.stringify(live);
      const result = op(live);
      if (live.length !== devices.length || JSON.stringify(live) !== before) await this.save(live);
      return result;
    }));
    this.queue = next.catch(() => {});
    return next;
  }

  private async load(): Promise<Stored[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return [];
    }
    const list = typeof raw === "object" && raw !== null ? (raw as { devices?: unknown }).devices : undefined;
    if (!Array.isArray(list)) return [];
    const out: Stored[] = [];
    for (const d of list) {
      if (typeof d !== "object" || d === null) continue;
      const r = d as Record<string, unknown>;
      if (isStr(r.id) && isStr(r.name) && isStr(r.hash) && /^[0-9a-f]{64}$/.test(r.hash) && isNum(r.createdAt) && isNum(r.lastSeen)) {
        out.push({ id: r.id, name: r.name, hash: r.hash, createdAt: r.createdAt, lastSeen: r.lastSeen, via: r.via === "tailscale" ? "tailscale" : "local" });
      }
    }
    return out;
  }

  /** Atomic: private temp file, then rename over the target. */
  private async save(devices: Stored[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}

function publicOf({ id, name, createdAt, lastSeen, via }: Stored): Device {
  return { id, name, createdAt, lastSeen, via };
}
