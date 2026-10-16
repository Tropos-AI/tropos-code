// src/web/admin/onboard.ts — the web wizard's calls, on top of the onboarding engine (src/onboard/engine.ts).
import { z } from "zod";
import { computeOnboardState, finish, makeOnboardDeps, reopen, validateKey, type OnboardDeps } from "../../onboard/engine";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

const STEP_IDS = ["provider", "model", "telegram", "pairing", "sandbox", "service", "health"] as const;
const keyParams = z.object({ provider: z.string().min(1).max(64), key: z.string().max(4096) });
const finishParams = z.object({ skipped: z.array(z.enum(STEP_IDS)).max(STEP_IDS.length).optional() }).optional();

/** `deps` lets tests swap the network, Docker and the service manager; the default is the real machine. */
export function onboardHandlers(ctx: AdminContext, deps?: OnboardDeps): AdminHandlers {
  const engine = (): OnboardDeps =>
    deps ?? makeOnboardDeps({ home: ctx.home, userHome: ctx.userHome, env: ctx.env, fetch: ctx.fetch, now: ctx.now, execPath: ctx.execPath, scriptPath: ctx.scriptPath });
  return {
    "onboard.state": () => computeOnboardState(engine()),
    "onboard.validateKey": async (params) => {
      const parsed = keyParams.safeParse(params);
      if (!parsed.success) throw new AdminError("Choose a provider and enter a key.");
      return validateKey(engine(), parsed.data);
    },
    "onboard.finish": async (params) => {
      const parsed = finishParams.safeParse(params);
      if (!parsed.success) throw new AdminError("Unknown step.");
      return finish(engine(), { skipped: parsed.data?.skipped });
    },
    "onboard.reopen": () => reopen(engine()),
  };
}
