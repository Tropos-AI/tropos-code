// src/web/admin/service.ts — `service.*` (run the gateway at login) and `sandbox.check` (Docker and the sandbox image).
import { sandboxImage } from "../../doctor/checks/docker";
import { defaultRunner } from "../../doctor/runner";
import type { Runner } from "../../doctor/types";
import { gatewayLogPath } from "../../gateway/config";
import { ensureDefaultProject } from "../../gateway/projects";
import { programArguments, serviceEnv, type ServiceManager } from "../../service";
import type { ServiceInfo } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { messageOf, scrub, serviceFor } from "./util";

export interface ServiceDeps {
  service: ServiceManager;
  /** Only `exec` is used: it runs `docker`. Tests replace it so no docker command ever runs. */
  runner: Pick<Runner, "exec">;
  /** `git init` of the default workspace, as in `tcode gateway install`. */
  git: (dir: string) => Promise<void>;
}

const NOT_INSTALLED = "The gateway service isn't installed. Install it first.";
const PULL_CAP_MS = 5 * 60_000;

async function shown<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof AdminError ? err : new AdminError(scrub(messageOf(err)));
  }
}

export function serviceHandlers(ctx: AdminContext, deps: Partial<ServiceDeps> = {}): AdminHandlers {
  const service = serviceFor(ctx, deps);
  const docker = deps.runner ?? defaultRunner();
  const info = (s: Awaited<ReturnType<ServiceManager["status"]>>): ServiceInfo => ({ manager: s.manager, installed: s.installed, running: s.running, ...(s.pid !== undefined ? { pid: s.pid } : {}) });

  const control = (verb: "start" | "stop" | "restart") => () =>
    shown(async () => {
      const current = await service.status();
      if (current.manager !== "none" && !current.installed) throw new AdminError(NOT_INSTALLED);
      await service[verb]();
      return info(await service.status());
    });

  return {
    "service.status": () =>
      shown(async () => {
        const s = await service.status();
        return { ...info(s), ...(s.unitPath ? { unitPath: s.unitPath } : {}), logPath: gatewayLogPath(ctx.home) };
      }),
    "service.install": () =>
      shown(async () => {
        await ensureDefaultProject(ctx.home, { git: deps.git });
        const { unitPath } = await service.install({
          programArguments: programArguments(ctx.execPath, ctx.scriptPath),
          workingDirectory: ctx.home,
          logPath: gatewayLogPath(ctx.home),
          env: serviceEnv(ctx.env, ctx.userHome),
        });
        return { ...info(await service.status()), unitPath };
      }),
    "service.uninstall": () => shown(() => service.uninstall()),
    "service.start": control("start"),
    "service.stop": control("stop"),
    "service.restart": control("restart"),
    "sandbox.check": (params) =>
      shown(async () => {
        const image = await sandboxImage(ctx.home);
        const base = { image, docker: false, imagePresent: false };
        const daemon = await docker.exec("docker", ["info", "--format", "{{.ServerVersion}}"], 8_000);
        if (daemon.code !== 0) {
          const missing = daemon.error?.includes("not found");
          return { ...base, ok: false, problem: missing ? "Docker isn't installed. Chat commands run in a Docker sandbox, so the gateway needs it." : "Docker is installed but its daemon isn't reachable. Start Docker Desktop or the docker service." };
        }
        const present = async () => (await docker.exec("docker", ["image", "inspect", "--format", "{{.Id}}", image], 8_000)).code === 0;
        let imagePresent = await present();
        let problem: string | undefined;
        if (!imagePresent && params?.pull) {
          // An image name that looks like an option must never reach docker as one.
          if (image.startsWith("-")) problem = `The sandbox image name "${image}" isn't valid.`;
          else {
            const pulled = await docker.exec("docker", ["pull", image], PULL_CAP_MS);
            if (pulled.code !== 0) problem = scrub(`Could not pull ${image}: ${(pulled.error ?? pulled.stderr.trim().split("\n").pop()) || "docker pull failed"}`);
            imagePresent = await present();
          }
        }
        if (!imagePresent && !problem) problem = `The sandbox image ${image} isn't downloaded yet.`;
        return { ok: imagePresent, docker: true, image, imagePresent, ...(problem ? { problem } : {}) };
      }),
  };
}
