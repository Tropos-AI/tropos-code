// src/web/admin/status.ts — `status.get`: one cheap snapshot of the install for the dashboard. No network calls.
import { join } from "node:path";
import { readSettingsFile } from "../../config/settings";
import { runDoctor } from "../../doctor/engine";
import { countJobs, updateReadyVersion } from "../../doctor/status-data";
import { readStateFile } from "../../doctor/util";
import { pidAlive } from "../../doctor/util";
import { loadGatewayConfig, telegramToken } from "../../gateway/config";
import { FilePairing } from "../../gateway/pairing";
import { defaultProjectId, listProjects } from "../../gateway/projects";
import { readOnboardingFlags } from "../../onboard/flags";
import { ProviderRouter } from "../../providers/router";
import type { StatusSnapshot } from "./api";
import type { AdminContext, AdminHandlers } from "./context";
import { serviceFor, doctorOptionsFor, type HostDeps } from "./util";

export interface StatusDeps extends HostDeps {
  pidAlive: (pid: number) => boolean;
}

export function statusHandlers(ctx: AdminContext, deps: Partial<StatusDeps> = {}): AdminHandlers {
  const alive = deps.pidAlive ?? deps.runner?.pidAlive ?? pidAlive;
  return {
    "status.get": async () => {
      const settings = await readSettingsFile(join(ctx.home, "settings.json")).catch(() => null);
      const service = await serviceFor(ctx, deps)
        .status()
        .then((s) => ({ manager: s.manager, installed: s.installed, running: s.running, ...(s.pid !== undefined ? { pid: s.pid } : {}) }))
        .catch(() => ({ manager: "none" as const, installed: false, running: false }));

      const state = await readStateFile(ctx.home);
      const running = state ? alive(state.pid) : false;
      const gwConfig = await loadGatewayConfig(ctx.home).catch(() => null);

      const router = new ProviderRouter({ home: ctx.home, env: ctx.env, settings: settings?.providers ?? {} });
      const providers = (await router.status().catch(() => [])).map((p) => ({ id: p.info.id, name: p.info.name, connected: p.key !== null }));

      const report = await runDoctor({ ...doctorOptionsFor(ctx, { ...deps, runner: { pidAlive: alive, ...deps.runner } }) });
      const docker = report.findings.find((f) => f.id === "docker.daemon");

      const projects = await listProjects(ctx.home).catch(() => []);
      const paired = await new FilePairing({ path: join(ctx.home, "gateway", "pairing.json"), now: ctx.now }).list().catch(() => []);
      const flags = await readOnboardingFlags(ctx.home);
      const updateAvailable = await updateReadyVersion(ctx.env, ctx.userHome, ctx.version).catch(() => null);

      const snapshot: StatusSnapshot = {
        version: ctx.version,
        channel: settings?.autoUpdatesChannel ?? "latest",
        ...(updateAvailable ? { updateAvailable } : {}),
        service,
        gateway: {
          running,
          ...(running && state ? { pid: state.pid, startedAt: state.startedAt, ...(state.webPort ? { webPort: state.webPort } : {}) } : {}),
          telegram: gwConfig ? Boolean(telegramToken(gwConfig, ctx.env)) : false,
        },
        providers,
        docker: !docker ? { ok: false, problem: "Docker was not checked." } : docker.level === "ok" ? { ok: true } : { ok: false, problem: docker.message },
        projects: { count: projects.length, defaultId: await defaultProjectId(ctx.home).catch(() => "default") },
        pairedSenders: paired.length,
        cronJobs: (await countJobs(ctx.home)) ?? 0,
        health: { ok: report.summary.ok, warn: report.summary.warn, error: report.summary.error },
        needsOnboarding: !providers.some((p) => p.connected) && !flags.dismissedAt,
      };
      return snapshot;
    },
  };
}
