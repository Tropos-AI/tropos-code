// src/gateway/cron/service.ts — the scheduler as a gateway service: connects the engine to the daemon's sessions and channels.
import type { GatewayService, GatewayServiceDeps } from "../types";
import { createJobRunner } from "./runner";
import { createCronService, type CronServiceOptions } from "./scheduler";
import type { RunRecord } from "./types";

export interface CronGatewayService extends GatewayService {
  runNow(idOrPrefix: string): Promise<RunRecord>;
}

export function createCronGatewayService(opts: CronServiceOptions & { log?: (message: string) => void } = {}): CronGatewayService {
  const { log, ...schedulerOptions } = opts;
  const engine = createCronService(schedulerOptions);
  return {
    name: "cron",
    async start(deps: GatewayServiceDeps) {
      await engine.start({
        home: deps.home,
        runJob: createJobRunner({
          home: deps.home,
          openSession: (projectId) => deps.openSession(projectId),
          projectPath: async (projectId) => (await deps.projects.get(projectId))?.path,
        }),
        deliver: (target, text) => deps.deliver(target, text),
        log,
      });
    },
    stop: async () => void (await engine.stop()),
    runNow: (id) => engine.runNow(id),
  };
}
