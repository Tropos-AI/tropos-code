// src/doctor/checks/gateway-state.ts — gateway/state.json names a process that is still alive.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "../types";
import { finding, readStateFile } from "../util";

export const gatewayStateCheck: Check = {
  id: "gateway.state",
  area: "gateway",
  title: "Gateway state file is current",
  async run(env) {
    const state = await readStateFile(env.home);
    if (state === undefined) return [finding("gateway.state", "ok", "Gateway is not running (no state file)")];
    const path = join(env.home, "gateway", "state.json");
    if (state === null) {
      return [finding("gateway.state", "warn", "gateway/state.json is unreadable", { detail: "A running gateway rewrites it. Fix removes the file.", fixable: true, safe: true, data: { path } })];
    }
    if (env.runner.pidAlive(state.pid)) {
      return [finding("gateway.state", "ok", `Gateway is running (pid ${state.pid}${state.webPort ? `, web port ${state.webPort}` : ""})`)];
    }
    return [
      finding("gateway.state", "warn", `gateway/state.json is stale: pid ${state.pid} is not running`, {
        detail: "The gateway stopped without cleaning up. Fix removes the file.",
        fixable: true,
        safe: true,
        data: { path },
      }),
    ];
  },
  async fix(f) {
    const path = String(f.data?.path ?? "");
    if (!path.endsWith(join("gateway", "state.json"))) return { ok: false, message: "unexpected path" };
    await rm(path, { force: true });
    return { ok: true, message: `removed ${path}` };
  },
};
