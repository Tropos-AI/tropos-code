// src/onboard/phone.ts — phone access (Tailscale) as setup shows and turns it on. The serve/save work is the same
// code the dashboard's remote.enable uses, so both agree on ports and notes.
import { loadGatewayConfig } from "../gateway/config";
import { enableRemoteAccess } from "../remote/access";
import { TailscaleError } from "../remote/tailscale";
import { remoteUrl } from "../web/links";
import type { PhoneStatusView } from "../web/admin/api";
import { TAILSCALE_DOWNLOAD_URL } from "./copy";
import type { OnboardDeps } from "./engine";
import { OnboardError } from "./errors";

export async function phoneStatus(deps: OnboardDeps): Promise<PhoneStatusView> {
  const config = await loadGatewayConfig(deps.home);
  const ts = await deps.tailscale.status();
  const url = remoteUrl(config.remoteAccess);
  return {
    installed: ts.installed,
    running: ts.running,
    ...(ts.dnsName ? { dnsName: ts.dnsName } : {}),
    enabled: url !== null,
    ...(url ? { url } : {}),
  };
}

export async function enablePhoneAccess(deps: OnboardDeps): Promise<{ url: string; httpsPort: number; code: string; note?: string }> {
  const ts = await deps.tailscale.status();
  if (!ts.installed) throw new OnboardError(`Tailscale isn't installed on this computer. Install it from ${TAILSCALE_DOWNLOAD_URL}, sign in, then try again.`);
  if (!ts.running) throw new OnboardError("Tailscale isn't signed in on this computer yet. Open Tailscale, sign in, then try again.");
  let result;
  try {
    result = await enableRemoteAccess(deps.home, deps.runner);
  } catch (err) {
    throw err instanceof TailscaleError ? new OnboardError(err.message) : err;
  }
  // The running gateway only allows the new address after a restart.
  if ((await deps.service.status().catch(() => null))?.running) await deps.service.restart();
  return { url: result.url, httpsPort: result.httpsPort, code: await deps.login.code(), ...(result.note ? { note: result.note } : {}) };
}
