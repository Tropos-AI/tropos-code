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

/** Tailscale's own wording when there is no such serve handler to remove (not a loose match: a real failure must not read as "off"). */
const alreadyOff = (e: TailscaleError): boolean => /handler does not exist|no serve config|serve config does not exist|is not serving/i.test(e.message);

/** True when the serve entry is gone (removed, or never there); false when Tailscale couldn't be reached; throws on a real failure. */
async function serveGone(runner: TailscaleRunner, port: number): Promise<boolean> {
  try {
    await disableServe(runner, port);
    return true;
  } catch (e) {
    if (!(e instanceof TailscaleError)) throw e;
    if (alreadyOff(e)) return true;
    if (!(await tailscaleStatus(runner)).running) return false;
    throw e;
  }
}

export async function disableRemoteAccess(home: string, runner: TailscaleRunner, now: () => number = Date.now): Promise<void> {
  const config = await loadGatewayConfig(home);
  const port = config.remoteAccess.httpsPort;
  const gone = config.remoteAccess.tailscale && port !== undefined ? await serveGone(runner, port) : true;
  // Tailscale wasn't reachable, so the serve entry may still publish the dashboard: record that, keep refusing its
  // name meanwhile, and let the next gateway start (or doctor --fix) finish the job.
  await saveGatewayConfig(home, { ...config, remoteAccess: gone ? { tailscale: false } : { ...config.remoteAccess, pendingDisable: true } });
  // Phones that only ever came in over the tailnet lose their login with it; a device also seen locally stays.
  const devices = new DeviceStore({ path: devicesPath(home), now });
  for (const d of await devices.list()) if (d.via === "tailscale") await devices.revoke(d.id);
}

/** Finishes a disable that couldn't reach Tailscale. True once the setting is fully off; never throws. */
export async function retryPendingDisable(home: string, runner: TailscaleRunner): Promise<boolean> {
  try {
    const config = await loadGatewayConfig(home);
    const { pendingDisable, httpsPort } = config.remoteAccess;
    if (!pendingDisable) return false;
    if (httpsPort !== undefined && !(await serveGone(runner, httpsPort))) return false;
    await saveGatewayConfig(home, { ...config, remoteAccess: { tailscale: false } });
    return true;
  } catch {
    return false;
  }
}
