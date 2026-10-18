// src/onboard/reminders.ts — a step the owner skipped in setup is mentioned once, by the agent, in the owner's own
// interactive session. Only cheap reads decide whether it is still undone (no doctor, no network).
import { bootstrapPending } from "../context/identity";
import type { SessionRole } from "../gateway/types";
import type { OnboardStepId } from "../web/admin/api";
import { REMINDER_TOPICS } from "./copy";
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

export function setupReminderContext(id: OnboardStepId): string {
  return `<setup-reminder>
During setup the user skipped ${REMINDER_TOPICS[id] ?? id}.
Mention it once, at a natural pause or at the end of a reply, in one short sentence (for example: "You can reach me from your phone too; want to set up Telegram?"). Never instead of answering. If they want it, tell them to run \`tcode onboard\` or open Setup in the dashboard. Don't bring it up again.
</setup-reminder>`;
}

/** The next reminder for the owner's interactive session, or "". It is marked as shown before it is returned. */
export async function takeSetupReminder(deps: OnboardDeps, who: { role: SessionRole; interactive: boolean }): Promise<string> {
  if (who.role !== "owner" || !who.interactive) return "";
  const flags = await readOnboardingFlags(deps.home);
  const reminded = new Set(flags.reminded ?? []);
  const open = new Set(await openSkippedSteps(deps));
  const next = REMINDABLE.find((id) => open.has(id) && !reminded.has(id));
  if (!next) return "";
  await markReminded(deps.home, next);
  return setupReminderContext(next);
}
