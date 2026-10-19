// src/gateway/dashboard-link.ts — the dashboard address the agent tells the owner, optionally at a route.
import { localDashboardUrl } from "../web/links";
import { DEFAULT_PORT } from "../web/protocol";
import type { GatewayConfig } from "./config";

/** `http://127.0.0.1:<port>/`, plus `#/<route>` when given. */
export function dashboardLink(config: Pick<GatewayConfig, "webPort">, route?: string): string {
  const base = localDashboardUrl(config.webPort ?? DEFAULT_PORT);
  return route ? `${base}#/${route}` : base;
}
