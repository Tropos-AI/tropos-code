import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_TTL_MS, DeviceStore, cleanDeviceName, devicesPath } from "./devices";

let dir: string;
let path: string;
let t: number;
let seed: number;
let store: DeviceStore;

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out[i] = seed >>> 16;
  }
  return out;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tcode-devices-"));
  path = join(dir, "gateway", "devices.json");
  t = 1_000_000;
  seed = 7;
  store = new DeviceStore({ path, now: () => t, random });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("DeviceStore", () => {
  test("devicesPath is <home>/gateway/devices.json", () => {
    expect(devicesPath("/h")).toBe(join("/h", "gateway", "devices.json"));
  });

  test("create returns a 43-char key; only its sha256 is on disk, file is 0600", async () => {
    const { id, key } = await store.create("Safari on iPhone");
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(key);
    expect(raw).toContain(createHash("sha256").update(key).digest("hex"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "gateway"))).mode & 0o777).toBe(0o700);
    expect((await store.list())[0]).toMatchObject({ id, name: "Safari on iPhone", via: "local", createdAt: t, lastSeen: t });
    expect(Object.keys((await store.list())[0]!)).not.toContain("hash");
  });

  test("verify updates lastSeen; an unknown key is null", async () => {
    const { key, id } = await store.create("x");
    t += 5000;
    const d = await store.verify(key);
    expect(d).toMatchObject({ id, lastSeen: t });
    expect((await store.list())[0]!.lastSeen).toBe(t);
    expect(await store.verify("A".repeat(43))).toBeNull();
    expect(await store.verify("")).toBeNull();
    expect(await store.verify("short")).toBeNull();
  });

  test("a key unused for a year expires and is dropped from the file", async () => {
    const { key } = await store.create("x");
    t += DEVICE_TTL_MS + 1;
    expect(await store.verify(key)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8")).devices).toEqual([]);
  });

  test("using a key renews its year", async () => {
    const { key } = await store.create("x");
    t += DEVICE_TTL_MS - 1;
    expect(await store.verify(key)).not.toBeNull();
    t += DEVICE_TTL_MS - 1;
    expect(await store.verify(key)).not.toBeNull();
  });

  test("via: tailscale-only until it connects locally once", async () => {
    const { key, id } = await store.create("phone", "tailscale");
    await store.verify(key, "tailscale");
    expect((await store.list()).find((d) => d.id === id)!.via).toBe("tailscale");
    await store.verify(key, "local");
    await store.verify(key, "tailscale");
    expect((await store.list()).find((d) => d.id === id)!.via).toBe("local");
  });

  test("revoke and revokeAll", async () => {
    const a = await store.create("a");
    const b = await store.create("b");
    const c = await store.create("c");
    expect(await store.revoke(a.id)).toBe(true);
    expect(await store.revoke(a.id)).toBe(false);
    expect(await store.verify(a.key)).toBeNull();
    expect(await store.verify(b.key)).not.toBeNull();
    expect(await store.revokeAll()).toBe(2);
    expect(await store.verify(b.key)).toBeNull();
    expect(await store.verify(c.key)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await store.revokeAll()).toBe(0);
  });

  test("a second instance sees devices created by the first (CLI and gateway are separate processes)", async () => {
    const { key } = await store.create("x");
    const other = new DeviceStore({ path, now: () => t, random });
    expect(await other.verify(key)).not.toBeNull();
  });

  test("a damaged file reads as no devices and is rewritten on the next create", async () => {
    await store.create("old");
    await writeFile(path, "nope");
    expect(await store.list()).toEqual([]);
    const { key } = await store.create("new");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    expect((await store.verify(key))!.name).toBe("new");
    expect(await store.list()).toHaveLength(1);
  });

  test("concurrent creates all land", async () => {
    await Promise.all([store.create("a"), store.create("b"), store.create("c")]);
    expect((await store.list()).map((d) => d.name).sort()).toEqual(["a", "b", "c"]);
  });
});

test("cleanDeviceName strips control characters and caps at 60", () => {
  expect(cleanDeviceName("Chrome\u0000 on\nmacOS")).toBe("Chrome on macOS");
  expect(cleanDeviceName("")).toBe("Browser");
  expect(cleanDeviceName(" \n\t ")).toBe("Browser");
  expect(cleanDeviceName("x".repeat(100)).length).toBe(60);
});
