// src/web/admin/proactive.ts — `proactive.*`: whether and when the agent may message the owner on its own, and where
// new projects are created. These live in gateway.json; every change asks the running gateway to re-read it.
import { ConfigStoreError, setAt, unsetAt, updateConfigFile, gatewayFile } from "../../config/store";
import { loadGatewayConfig, newProjectsDirOf, proactiveEnabled, telegramToken } from "../../gateway/config";
import type { ProactivePatch, ProactiveView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { messageOf } from "./util";

export function proactiveHandlers(ctx: AdminContext): AdminHandlers {
  const view = async (): Promise<ProactiveView> => {
    const config = await loadGatewayConfig(ctx.home).catch((err) => {
      throw new AdminError(messageOf(err));
    });
    const telegram = Boolean(telegramToken(config, ctx.env));
    return {
      enabled: proactiveEnabled(config, telegram),
      explicit: config.proactive.enabled !== undefined,
      telegram,
      activeHours: { ...config.proactive.activeHours },
      everyHours: config.proactive.everyHours,
      maxPerDay: config.proactive.maxPerDay,
      newProjectsDir: newProjectsDirOf(config, ctx.userHome),
    };
  };

  return {
    "proactive.get": () => view(),

    async "proactive.set"(patch: ProactivePatch) {
      if (patch === null || typeof patch !== "object") throw new AdminError("Say what to change.");
      try {
        await updateConfigFile(gatewayFile(ctx.home), (draft) => {
          let next = draft;
          // null removes the key, which is the default; the schema (and so the message) rejects bad values.
          const put = (path: string[], value: unknown) => {
            next = value === null || value === undefined ? unsetAt(next, path) : setAt(next, path, value);
          };
          if (patch.enabled !== undefined) put(["proactive", "enabled"], patch.enabled);
          if (patch.activeHours !== undefined) put(["proactive", "activeHours"], patch.activeHours);
          if (patch.everyHours !== undefined) put(["proactive", "everyHours"], patch.everyHours);
          if (patch.maxPerDay !== undefined) put(["proactive", "maxPerDay"], patch.maxPerDay);
          if (patch.newProjectsDir !== undefined) put(["newProjectsDir"], patch.newProjectsDir);
          return next;
        });
      } catch (err) {
        if (err instanceof ConfigStoreError) throw new AdminError(err.message);
        throw err;
      }
      await ctx.gateway?.reload().catch(() => undefined);
      return view();
    },
  };
}
