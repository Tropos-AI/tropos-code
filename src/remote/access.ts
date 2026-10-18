// src/remote/access.ts — phone access on/off: `tailscale serve`, gateway.json and the devices that came in over it.
// The admin methods and the setup wizard share this; the caller reloads the gateway and tells it about the devices.
import { dashboardPort } from "../web/links";
import { DeviceStore, devicesPath } from "../web/devices";
import { loadGatewayConfig, saveGatewayConfig } from "../gateway/config";
import { TailscaleError, disableServe, enableServe, tailscaleStatus, type TailscaleRunner } from "./tailscale";

export async function enableRemoteAccess(home: string, runner: TailscaleRunner): Promise<{ url: string; httpsPort: number; note?: string }> {
  const config = await loadGatewayConfig(home);
  const { url, httpsPort } = await enableServe(runner, dashboardPort(config));
  const hostname = new URL(url).hostname;
  await saveGatewayConfig(home, { ...config, remoteAccess: { tailscale: true, httpsPort, hostname } });
  return { url, httpsPort, ...(httpsPort !== 443 ? { note: `443 was already in use on your tailnet name, so the dashboard is on ${httpsPort}.` } : {}) };
}

/** Whether `tailscale serve ... off` failed only because there was nothing to turn off. */
const alreadyOff = (e: TailscaleError): boolean => /not found|not serving|no serve|nothing|no config/i.test(e.message);

export async function disableRemoteAccess(home: string, runner: TailscaleRunner, now: () => number = Date.now): Promise<void> {
  const config = await loadGatewayConfig(home);
  const port = config.remoteAccess.httpsPort;
  if (config.remoteAccess.tailscale && port !== undefined) {
    try {
      await disableServe(runner, port);
    } catch (e) {
      // Serve already gone, or Tailscale itself not running (so nothing is being served): the setting still goes off.
      if (!(e instanceof TailscaleError) || !(alreadyOff(e) || !(await tailscaleStatus(runner)).running)) throw e;
    }
  }
  await saveGatewayConfig(home, { ...config, remoteAccess: { tailscale: false } });
  // Phones that only ever came in over the tailnet lose their login with it; a device also seen locally stays.
  const devices = new DeviceStore({ path: devicesPath(home), now });
  for (const d of await devices.list()) if (d.via === "tailscale") await devices.revoke(d.id);
}
