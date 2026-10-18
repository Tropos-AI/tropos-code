// src/doctor/checks/web-access.ts — the dashboard's fixed port (served, blocked by someone else, or free) and the
// token file the old login left behind.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadGatewayConfig } from "../../gateway/config";
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

export const webAccessCheck: Check = {
  id: "gateway.web",
  area: "gateway",
  title: "Dashboard port",
  async run(env) {
    const out = [await portFinding(env)];
    // Browsers log in with device keys now; the old link's key opens nothing, but it is still a secret on disk.
    if (existsSync(oldTokenPath(env.home))) {
      out.push(finding("gateway.web.oldToken", "warn", "The old dashboard token file is still there", { detail: "Nothing accepts it any more. Fix deletes gateway/token.", fixable: true, safe: true }));
    }
    return out;
  },
  async fix(f, env) {
    if (f.id !== "gateway.web.oldToken") return { ok: false, message: "nothing to fix" };
    const path = oldTokenPath(env.home);
    await rm(path, { force: true });
    return { ok: true, message: `removed ${path}` };
  },
};
