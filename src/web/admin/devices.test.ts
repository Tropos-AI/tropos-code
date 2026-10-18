import { afterEach, expect, test } from "bun:test";

import { DeviceStore, devicesPath } from "../devices";
import { CODE_TTL_MS, LoginCodes, loginCodesPath } from "../login-codes";
import type { DeviceView } from "./api";
import { createAdmin } from "./index";
import { makeKit, type Kit } from "./ops-testkit";

let kit: Kit | undefined;
afterEach(async () => {
  await kit?.cleanup();
  kit = undefined;
});

async function setup() {
  let changed = 0;
  kit = await makeKit();
  const ctx = { ...kit.ctx, gateway: { runCronNow: async () => {}, reload: async () => {}, devicesChanged: async () => void changed++ } };
  const devices = new DeviceStore({ path: devicesPath(kit.home), now: kit.ctx.now });
  return { admin: createAdmin(ctx), devices, home: kit.home, clock: kit.clock, changed: () => changed };
}

test("devices.list marks the caller's device as current, newest use first, and never shows a key", async () => {
  const { admin, devices, clock } = await setup();
  const a = await devices.create("Mac");
  clock.now += 1000;
  const b = await devices.create("Phone", "tailscale");
  const list = (await admin.handle("devices.list", undefined, { deviceId: a.id })) as DeviceView[];
  expect(list.map((d) => d.id)).toEqual([b.id, a.id]);
  expect(list.find((d) => d.id === a.id)!.current).toBe(true);
  expect(list.find((d) => d.id === b.id)).toMatchObject({ via: "tailscale", current: false });
  expect(JSON.stringify(list)).not.toContain(a.key);
  expect(JSON.stringify(list)).not.toContain("hash");
});

test("devices.list without a caller marks nothing current", async () => {
  const { admin, devices } = await setup();
  await devices.create("Mac");
  const list = (await admin.handle("devices.list", undefined)) as DeviceView[];
  expect(list.every((d) => !d.current)).toBe(true);
});

test("revoke and revokeAll remove devices and call gateway.devicesChanged", async () => {
  const { admin, devices, changed } = await setup();
  const a = await devices.create("Mac");
  await devices.create("Phone");
  await devices.create("Tablet");
  expect(await admin.handle("devices.revoke", { id: a.id })).toEqual({ removed: true });
  expect(await admin.handle("devices.revoke", { id: a.id })).toEqual({ removed: false });
  expect(await devices.verify(a.key)).toBeNull();
  expect(await admin.handle("devices.revokeAll", undefined)).toEqual({ removed: 2 });
  expect(await devices.list()).toEqual([]);
  expect(changed()).toBe(3);
});

test("devices.revoke needs an id", async () => {
  const { admin } = await setup();
  await expect(admin.handle("devices.revoke", {})).rejects.toThrow("Say which device");
});

test("login.issueCode returns 6 digits that redeem once, with an expiry", async () => {
  const { admin, home, clock } = await setup();
  const { code, expiresAt } = (await admin.handle("login.issueCode", undefined)) as { code: string; expiresAt: number };
  expect(code).toMatch(/^\d{6}$/);
  expect(expiresAt).toBe(clock.now + CODE_TTL_MS);
  const logins = new LoginCodes({ path: loginCodesPath(home), now: () => clock.now });
  expect(await logins.redeem(code)).toBe(true);
  expect(await logins.redeem(code)).toBe(false);
});
