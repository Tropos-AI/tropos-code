// src/cli/lifecycle/index.ts — loads the module behind a lifecycle command only when it is used.
import type { LifecycleName } from "./names";
import type { LifecycleRun } from "./types";

export { LIFECYCLE_NAMES, isLifecycleName, type LifecycleName } from "./names";
export type { LifecycleContext, LifecycleRun } from "./types";

export async function loadLifecycle(name: LifecycleName): Promise<LifecycleRun> {
  switch (name) {
    case "uninstall":
      return (await import("./uninstall")).default;
    case "reset":
      return (await import("./reset")).default;
    case "doctor":
      return (await import("./doctor")).default;
    case "status":
      return (await import("./status")).default;
    case "backup":
      return (await import("./backup")).default;
    case "logs":
      return (await import("./logs")).default;
    case "config":
      return (await import("./config")).default;
    case "security":
      return (await import("./security")).default;
    case "cron":
      return (await import("./cron")).default;
    case "onboard":
      return (await import("./onboard")).default;
    case "dashboard":
      return (await import("./dashboard")).default;
    case "migrate":
      return (await import("./migrate")).default;
  }
}
