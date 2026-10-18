// src/web/admin/remote.ts — `remote.*`: phone access through `tailscale serve`.
import { loadGatewayConfig } from "../../gateway/config";
import { disableRemoteAccess, enableRemoteAccess } from "../../remote/access";
import { TailscaleError, tailscaleStatus, type TailscaleRunner } from "../../remote/tailscale";
import { defaultRunner } from "../../doctor/runner";
import { remoteUrl } from "../links";
import type { RemoteView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

export function remoteHandlers(ctx: AdminContext, deps: Partial<{ runner: TailscaleRunner }> = {}): AdminHandlers {
  const runner = (): TailscaleRunner => deps.runner ?? defaultRunner();

  async function view(note?: string): Promise<RemoteView> {
    const config = await loadGatewayConfig(ctx.home);
    const tailscale = await tailscaleStatus(runner());
    const url = remoteUrl(config.remoteAccess);
    const guidance = !tailscale.installed
      ? "Phone access needs Tailscale. Install it from https://tailscale.com/download, sign in on this computer and on your phone, then turn this on."
      : !tailscale.running
        ? "Tailscale is installed but isn't running or isn't signed in. Open it and sign in, then try again."
        : undefined;
    return { enabled: config.remoteAccess.tailscale, tailscale, ...(url ? { url } : {}), ...((note ?? guidance) ? { note: note ?? guidance } : {}) };
  }
  // A Tailscale failure is worded for the owner already.
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw e instanceof TailscaleError ? new AdminError(e.message) : e;
    }
  };

  return {
    "remote.status": async () => view(),
    "remote.enable": async () => {
      const { note } = await wrap(() => enableRemoteAccess(ctx.home, runner()));
      await ctx.gateway?.reload();
      return view(note);
    },
    "remote.disable": async () => {
      await wrap(() => disableRemoteAccess(ctx.home, runner(), ctx.now));
      await ctx.gateway?.reload();
      await ctx.gateway?.devicesChanged().catch(() => {});
      return view();
    },
  };
}
