// src/web/admin/devices.ts — `devices.*` and `login.issueCode`: who is logged in to the dashboard, and a code for one more.
import { DeviceStore, devicesPath } from "../devices";
import { CODE_TTL_MS, LoginCodes, loginCodesPath } from "../login-codes";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

export interface DevicesDeps {
  devices: DeviceStore;
  logins: LoginCodes;
}

export function devicesHandlers(ctx: AdminContext, deps: Partial<DevicesDeps> = {}): AdminHandlers {
  const devices = () => deps.devices ?? new DeviceStore({ path: devicesPath(ctx.home), now: ctx.now });
  const logins = () => deps.logins ?? new LoginCodes({ path: loginCodesPath(ctx.home), now: ctx.now });
  // Open dashboard tabs of a revoked device are closed by the gateway; a plain `tcode web` has none to tell.
  const changed = () => ctx.gateway?.devicesChanged().catch(() => {});
  return {
    "devices.list": async (_p, caller) => {
      const list = await devices().list();
      return list.sort((a, b) => b.lastSeen - a.lastSeen).map((d) => ({ ...d, current: d.id === caller?.deviceId }));
    },
    "devices.revoke": async (p) => {
      if (typeof p?.id !== "string" || !p.id) throw new AdminError("Say which device to log out.");
      const removed = await devices().revoke(p.id);
      await changed();
      return { removed };
    },
    "devices.revokeAll": async () => {
      const removed = await devices().revokeAll();
      await changed();
      return { removed };
    },
    "login.issueCode": async () => {
      const code = await logins().issueCode();
      return { code, expiresAt: ctx.now() + CODE_TTL_MS };
    },
  };
}
