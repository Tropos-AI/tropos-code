// src/service/index.ts — the service manager for this machine: launchd on macOS, a systemd user unit on Linux.
import { homedir } from "node:os";
import { ServiceError } from "./errors";
import { launchdManager } from "./launchd";
import { systemdManager } from "./systemd";
import type { ServiceDeps, ServiceManager } from "./types";

export type { ServiceDeps, ServiceManager, ServiceRunner, ServiceSpec, ServiceStatus } from "./types";
export { ServiceError } from "./errors";
export { programArguments, serviceEnv } from "./spec";

export interface ServiceOptions {
  platform?: NodeJS.Platform;
  userHome?: string;
  uid?: number;
  user?: string;
  /** Runs `launchctl`, `systemctl` and `loginctl`; tests pass a fake so nothing real runs. */
  run?: ServiceDeps["run"];
  sleep?: ServiceDeps["sleep"];
}

const UNSUPPORTED = "Running the gateway in the background isn't supported on this system. Start it with `tcode gateway` instead.";

export function serviceManager(opts: ServiceOptions = {}): ServiceManager {
  const platform = opts.platform ?? process.platform;
  const deps: ServiceDeps = { platform, userHome: opts.userHome ?? homedir(), uid: opts.uid ?? process.getuid?.() ?? 0, user: opts.user, run: opts.run, sleep: opts.sleep };
  if (platform === "darwin") return launchdManager(deps);
  if (platform === "linux") return systemdManager(deps);
  const none = async (): Promise<never> => {
    throw new ServiceError(UNSUPPORTED);
  };
  return {
    manager: "none",
    install: none,
    uninstall: async () => ({ removed: false }),
    start: none,
    stop: none,
    restart: none,
    status: async () => ({ manager: "none", installed: false, running: false }),
  };
}
