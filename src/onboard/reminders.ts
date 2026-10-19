// src/onboard/reminders.ts — which steps the owner skipped in setup are still undone, and which were already raised.
// The agent raises each once, as a `setup:*` suggestion (src/suggest). Only cheap reads decide (no doctor, no network).
import { bootstrapPending } from "../context/identity";
import type { OnboardStepId } from "../web/admin/api";
import { phoneEnabled, registeredProjectCount, STEP_ORDER, telegramState, type OnboardDeps } from "./engine";
import { readOnboardingFlags, updateOnboardingFlags } from "./flags";

/** The steps worth a reminder, in the order they are raised. */
export const REMINDABLE = ["telegram", "phone", "service", "projects"] as const;

async function stillOpen(deps: OnboardDeps, id: OnboardStepId, known: { serviceInstalled?: boolean }, autonomyChosen: boolean): Promise<boolean> {
  switch (id) {
    case "identity":
      return bootstrapPending(deps.home).catch(() => false);
    case "projects":
      return (await registeredProjectCount(deps.home)) === 0;
    case "autonomy":
      return !autonomyChosen;
    case "telegram": {
      const tg = await telegramState(deps);
      return !(tg.token && tg.owner);
    }
    case "phone":
      return !(await phoneEnabled(deps.home));
    case "service": {
      if (known.serviceInstalled !== undefined) return !known.serviceInstalled;
      const svc = await deps.service.status().catch(() => null);
      return Boolean(svc && svc.manager !== "none" && !svc.installed); // no service manager: nothing to finish
    }
    default:
      return false; // welcome, provider, model and done are never "skipped"
  }
}

/** The skipped steps that are still undone, in `STEP_ORDER`. */
export async function openSkippedSteps(deps: OnboardDeps, known: { serviceInstalled?: boolean } = {}): Promise<OnboardStepId[]> {
  const flags = await readOnboardingFlags(deps.home);
  const skipped = new Set(flags.skipped ?? []);
  const open: OnboardStepId[] = [];
  for (const id of STEP_ORDER) if (skipped.has(id) && (await stillOpen(deps, id, known, flags.autonomyChosen === true))) open.push(id);
  return open;
}

export async function markReminded(home: string, id: OnboardStepId): Promise<void> {
  const prior = (await readOnboardingFlags(home)).reminded ?? [];
  if (!prior.includes(id)) await updateOnboardingFlags(home, { reminded: [...prior, id] });
}
