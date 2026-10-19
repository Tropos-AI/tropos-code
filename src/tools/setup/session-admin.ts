// src/tools/setup/session-admin.ts — the admin a session outside the gateway process (the terminal) uses for setup:
// the same handlers as the dashboard, with "tell the gateway" done by the reload signal.
import { requestGatewayReload } from "../../gateway/reload-signal";
import { VERSION } from "../../version";
import { createAdmin, type Admin } from "../../web/admin";
import { AdminError } from "../../web/admin/context";

export function sessionAdmin(home: string, env: NodeJS.ProcessEnv, userHome: string): Admin {
  const signal = async (): Promise<void> => void (await requestGatewayReload(home));
  return createAdmin({
    home,
    userHome,
    env,
    version: VERSION,
    execPath: process.execPath,
    scriptPath: process.argv[1],
    cwd: process.cwd(),
    now: Date.now,
    fetch,
    gateway: {
      runCronNow: async () => {
        throw new AdminError("Running a job now needs the gateway: start it with tcode gateway.");
      },
      reload: signal,
      // The gateway's reload re-reads the device list too (its reaper rechecks open tabs).
      devicesChanged: signal,
    },
  });
}
