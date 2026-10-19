// src/cli/after-update.ts — once `tcode update` put a newer version in place, the background service runs it: the owner
// shouldn't have to know a restart is needed.
import { requestGatewayReload } from "../gateway/reload-signal";
import { troposHome } from "../paths";
import { serviceManager, type ServiceManager } from "../service";

export interface AfterUpdateDeps {
  service: Pick<ServiceManager, "status" | "restart">;
  /** SIGUSR2 to a running gateway, which then looks for the new version; false when none runs. */
  signalGateway(): Promise<boolean>;
}

export async function afterUpdate(version: string, opts: { background: boolean }, deps: AfterUpdateDeps): Promise<string | undefined> {
  // Nobody asked for this one: never cut a running turn off. The gateway restarts itself once it is idle.
  if (opts.background) return (await deps.signalGateway()) ? `asked the running gateway to move to ${version} once it is idle` : undefined;
  const status = await deps.service.status().catch(() => null);
  if (status?.installed && status.running) {
    await deps.service.restart();
    return `Restarted the background service; it runs ${version} now.`;
  }
  if (status?.installed) return `The background service is stopped; it runs ${version} when it starts (tcode gateway start).`;
  // A gateway started in a terminal prints its own one-line notice; it has no service to start it again.
  if (await deps.signalGateway()) return "The gateway running in a terminal keeps its version until you restart it.";
  return undefined;
}

/** The real service manager and gateway for `tcode update`. */
export function productionAfterUpdate(env: NodeJS.ProcessEnv): (version: string, opts: { background: boolean }) => Promise<string | undefined> {
  return (version, opts) => afterUpdate(version, opts, { service: serviceManager(), signalGateway: () => requestGatewayReload(troposHome(env)) });
}
