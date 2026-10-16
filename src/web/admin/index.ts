// src/web/admin/index.ts — the admin dispatcher: one table of handlers, composed from the area modules.
import { ADMIN_METHODS, type AdminMethod } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { autonomyHandlers } from "./autonomy";
import { backupHandlers } from "./backup";
import { channelsHandlers } from "./channels";
import { configHandlers } from "./config";
import { cronHandlers } from "./cron";
import { doctorHandlers } from "./doctor";
import { extensionsHandlers } from "./extensions";
import { logsHandlers } from "./logs";
import { onboardHandlers } from "./onboard";
import { pairingHandlers } from "./pairing";
import { projectsHandlers } from "./projects";
import { serviceHandlers } from "./service";
import { statusHandlers } from "./status";
import { updateHandlers } from "./update";
import { usageHandlers } from "./usage";

export { AdminError, type AdminContext, type AdminHandlers } from "./context";

export interface Admin {
  handle(method: string, params: unknown): Promise<unknown>;
  /** Method names that have a handler (tests and the status page use it). */
  methods(): AdminMethod[];
}

export function createAdmin(ctx: AdminContext, extra: AdminHandlers = {}): Admin {
  const handlers: AdminHandlers = {
    ...statusHandlers(ctx),
    ...doctorHandlers(ctx),
    ...configHandlers(ctx),
    ...channelsHandlers(ctx),
    ...pairingHandlers(ctx),
    ...projectsHandlers(ctx),
    ...serviceHandlers(ctx),
    ...logsHandlers(ctx),
    ...usageHandlers(ctx),
    ...updateHandlers(ctx),
    ...backupHandlers(ctx),
    ...cronHandlers(ctx),
    ...extensionsHandlers(ctx),
    ...onboardHandlers(ctx),
    ...autonomyHandlers(ctx),
    ...extra,
  };
  return {
    methods: () => ADMIN_METHODS.filter((m) => handlers[m] !== undefined),
    async handle(method, params) {
      if (!(ADMIN_METHODS as string[]).includes(method)) throw new AdminError("Unknown request.");
      const handler = handlers[method as AdminMethod] as ((p: unknown) => Promise<unknown>) | undefined;
      if (!handler) throw new AdminError("That isn't available yet.");
      try {
        return await handler(params);
      } catch (error) {
        // Unexpected failures must not leak paths or stacks into the browser: AdminError messages are meant to be seen.
        if (error instanceof AdminError) throw error;
        throw new AdminError(error instanceof Error && error.message ? error.message.split("\n")[0]!.slice(0, 300) : "Something went wrong.");
      }
    },
  };
}
