// src/doctor/checks/web-access.ts — the dashboard's fixed port: served, blocked by someone else, or free.
import { loadGatewayConfig } from "../../gateway/config";
import { portHolder, portInUseMessage } from "../../web/port";
import { DEFAULT_PORT } from "../../web/protocol";
import type { Check } from "../types";
import { finding, readStateFile } from "../util";

export const webAccessCheck: Check = {
  id: "gateway.web",
  area: "gateway",
  title: "Dashboard port",
  async run(env) {
    const state = await readStateFile(env.home);
    if (state && env.runner.pidAlive(state.pid)) {
      if (state.webProblem) return [finding("gateway.web", "warn", `The dashboard is off: ${state.webProblem}`)];
      if (state.webPort) return [finding("gateway.web", "ok", `The dashboard is served on port ${state.webPort}`)];
      return [finding("gateway.web", "info", "The gateway runs without the dashboard")];
    }
    const port = (await loadGatewayConfig(env.home).catch(() => undefined))?.webPort ?? DEFAULT_PORT;
    const holder = await portHolder(port, env.runner);
    if (holder) return [finding("gateway.web", "warn", portInUseMessage(port, holder))];
    return [finding("gateway.web", "ok", `Port ${port} is free for the dashboard`)];
  },
};
