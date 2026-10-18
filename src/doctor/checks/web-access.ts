// src/doctor/checks/web-access.ts — the dashboard's fixed port (served, blocked by someone else, or free) and the
// token file the old login left behind.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadGatewayConfig } from "../../gateway/config";
import { retryPendingDisable } from "../../remote/access";
import { serveFunnelled, tailscaleStatus } from "../../remote/tailscale";
import { remoteUrl } from "../../web/links";
import { portHolder, portInUseMessage } from "../../web/port";
import { DEFAULT_PORT } from "../../web/protocol";
import type { Check, DoctorEnv, Finding } from "../types";
import { finding, readStateFile } from "../util";

const oldTokenPath = (home: string) => join(home, "gateway", "token");

async function portFinding(env: DoctorEnv): Promise<Finding> {
  const state = await readStateFile(env.home);
  if (state && env.runner.pidAlive(state.pid)) {
    if (state.webProblem) return finding("gateway.web", "warn", `The dashboard is off: ${state.webProblem}`);
    if (state.webPort) return finding("gateway.web", "ok", `The dashboard is served on port ${state.webPort}`);
    return finding("gateway.web", "info", "The gateway runs without the dashboard");
  }
  const port = (await loadGatewayConfig(env.home).catch(() => undefined))?.webPort ?? DEFAULT_PORT;
  const holder = await portHolder(port, env.runner);
  if (holder) return finding("gateway.web", "warn", portInUseMessage(port, holder));
  return finding("gateway.web", "ok", `Port ${port} is free for the dashboard`);
}

async function remoteFinding(env: DoctorEnv): Promise<Finding | null> {
  const config = await loadGatewayConfig(env.home).catch(() => undefined);
  if (config?.remoteAccess.pendingDisable) {
    return finding("gateway.web.remote.pending", "warn", "Phone access was turned off, but the Tailscale serve entry may still be there", { detail: "Tailscale wasn't reachable when it was turned off. Fix removes the entry now (Tailscale must be running); the gateway also retries at start.", fixable: true });
  }
  const url = config ? remoteUrl(config.remoteAccess) : null;
  if (!url || !config) return null;
  const ts = await tailscaleStatus(env.runner);
  if (!ts.running) return finding("gateway.web.remote", "warn", "Phone access is on but Tailscale isn't running", { detail: ts.installed ? "Open Tailscale and sign in; the phone address works again then." : "Tailscale isn't installed. Install it from https://tailscale.com/download, or turn phone access off in Settings." });
  const port = config.remoteAccess.httpsPort;
  if (port !== undefined && (await serveFunnelled(env.runner, port))) {
    return finding("gateway.web.remote", "warn", `Port ${port} on your tailnet name is open to the whole internet (Tailscale Funnel)`, { detail: `Turn Funnel off for it: tailscale funnel --https=${port} off. Phone access refuses to turn on while Funnel is on.` });
  }
  return finding("gateway.web.remote", "ok", `Phone access is on at ${url}`);
}

export const webAccessCheck: Check = {
  id: "gateway.web",
  area: "gateway",
  title: "Dashboard port",
  async run(env) {
    const out = [await portFinding(env)];
    const remote = await remoteFinding(env);
    if (remote) out.push(remote);
    // Browsers log in with device keys now; the old link's key opens nothing, but it is still a secret on disk.
    if (existsSync(oldTokenPath(env.home))) {
      out.push(finding("gateway.web.oldToken", "warn", "The old dashboard token file is still there", { detail: "Nothing accepts it any more. Fix deletes gateway/token.", fixable: true, safe: true }));
    }
    return out;
  },
  async fix(f, env) {
    if (f.id === "gateway.web.remote.pending") {
      return (await retryPendingDisable(env.home, env.runner))
        ? { ok: true, message: "removed the Tailscale serve entry; phone access is off" }
        : { ok: false, message: "Tailscale still can't be reached; open it and run the fix again" };
    }
    if (f.id !== "gateway.web.oldToken") return { ok: false, message: "nothing to fix" };
    const path = oldTokenPath(env.home);
    await rm(path, { force: true });
    return { ok: true, message: `removed ${path}` };
  },
};
