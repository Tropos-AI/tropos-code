// src/suggest/signals.ts — what is worth suggesting to the owner right now, and the <suggestions> block that tells the
// agent. Setup signals come from P4's reminders (src/onboard/reminders.ts), never from a second detection.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { neutraliseHarnessTags } from "../context/tags";
import { gatewayDir } from "../gateway/config";
import { untrustedJob } from "../gateway/cron/runner";
import { CronStore } from "../gateway/cron/store";
import { FilePairing } from "../gateway/pairing";
import { REMINDER_TOPICS } from "../onboard/copy";
import { makeOnboardDeps } from "../onboard/engine";
import { readOnboardingFlags } from "../onboard/flags";
import { openSkippedSteps, REMINDABLE } from "../onboard/reminders";
import { localDate } from "../memory/daily";
import { journalDir } from "../paths";
import { serviceManager } from "../service";
import type { OnboardStepId } from "../web/admin/api";
import { SuggestionStore, type SuggestionState } from "./store";

const DAY = 86_400_000;
const REPEAT_AFTER_MS = 7 * DAY;
const MAX_SIGNALS = 3;
const ROUTINE_DAYS = 5;
const ROUTINE_WINDOW_DAYS = 14;
const SERVICE_CACHE_MS = 10 * 60_000;

export interface SignalFacts {
  /** Skipped setup steps that are still undone and were not raised yet. */
  setupOpen: OnboardStepId[];
  failingJobs: { id: string; name: string; error: string }[];
  /** Days with a journal entry in the last 14. */
  journalDays: number;
  cronJobs: number;
}

export interface Signal {
  id: string;
  text: string;
}

const FIELD_CHARS = 80;

/** Text from a job or a command is data, not part of the instruction: tags broken, one line, short, quoted. */
export function quoteField(text: string): string {
  return JSON.stringify(neutraliseHarnessTags(text.replace(/\s+/g, " ").trim()).slice(0, FIELD_CHARS));
}

export function computeSignals(facts: SignalFacts, state: SuggestionState, now: number): Signal[] {
  const out: Signal[] = [];
  const quiet = (id: string): boolean => id in state.declined || now - (state.mentioned[id] ?? -Infinity) < REPEAT_AFTER_MS;
  for (const step of facts.setupOpen) {
    const id = `setup:${step}`;
    // A setup step is raised once, ever: any earlier mention is enough.
    if (id in state.declined || id in state.mentioned) continue;
    out.push({ id, text: `During setup the owner skipped ${REMINDER_TOPICS[step] ?? step}, and it is still undone. Offer it once; to set it up they run \`tcode onboard\` or open Setup in the dashboard.` });
  }
  for (const job of facts.failingJobs) {
    const id = `cron-failing:${job.id}`;
    if (!quiet(id)) out.push({ id, text: `The scheduled job ${quoteField(job.name)} failed on its last run (${quoteField(job.error)}). Offer to look at it.` });
  }
  for (const [project, t] of Object.entries(state.tests)) {
    const id = `tests-failing:${project}`;
    if (!t.ok && !quiet(id)) out.push({ id, text: `The last run of ${quoteField(t.command)} in project ${quoteField(project)} failed. Offer to look into it.` });
  }
  if (facts.journalDays >= ROUTINE_DAYS && facts.cronJobs === 0 && !quiet("routine")) {
    out.push({ id: "routine", text: `The owner has worked with you on ${facts.journalDays} of the last ${ROUTINE_WINDOW_DAYS} days and has no scheduled jobs. Offer to schedule a recurring task they keep doing by hand.` });
  }
  return out.slice(0, MAX_SIGNALS);
}

export function suggestionsBlock(signals: Signal[]): string {
  if (signals.length === 0) return "";
  return `<suggestions>\n${signals.map((s) => `- [${s.id}] ${s.text}`).join("\n")}\n</suggestions>`;
}

async function countJournalDays(home: string, now: number): Promise<number> {
  const recent = new Set<string>();
  for (let n = 0; n < ROUTINE_WINDOW_DAYS; n++) recent.add(`${localDate(new Date(now - n * DAY))}.md`);
  const names = await readdir(journalDir(home)).catch(() => [] as string[]);
  return names.filter((name) => recent.has(name)).length;
}

export async function gatherFacts(i: {
  home: string;
  env: NodeJS.ProcessEnv;
  serviceInstalled: () => Promise<boolean | undefined>;
  now?: number;
}): Promise<SignalFacts> {
  const now = i.now ?? Date.now();
  const deps = makeOnboardDeps({ home: i.home, env: i.env });
  const flags = await readOnboardingFlags(i.home);
  const reminded = new Set(flags.reminded ?? []);
  // The service lookup shells out; only a skipped, not yet raised service step needs it.
  const serviceInstalled = flags.skipped?.includes("service") && !reminded.has("service") ? await i.serviceInstalled().catch(() => undefined) : undefined;
  const open = await openSkippedSteps(deps, serviceInstalled === undefined ? {} : { serviceInstalled }).catch(() => [] as OnboardStepId[]);
  const store = new CronStore(i.home);
  const jobs = store.list();
  // A guest's job is the guest's text: its name and errors never reach the owner's context.
  const o = new FilePairing({ path: join(gatewayDir(i.home), "pairing.json") }).ownerNow();
  const ownerChat = o ? `${o.channel}:${o.senderId}` : undefined;
  return {
    setupOpen: open.filter((id) => (REMINDABLE as readonly string[]).includes(id) && !reminded.has(id)),
    failingJobs: jobs
      .filter((j) => j.enabled && !untrustedJob(j, ownerChat) && (j.lastStatus === "error" || j.lastStatus === "timeout"))
      .map((j) => ({ id: j.id, name: j.name, error: store.runs(j.id, 1).at(-1)?.error ?? j.lastStatus ?? "failed" })),
    journalDays: await countJournalDays(i.home, now),
    cronJobs: jobs.length,
  };
}

/** Whether the background service is installed; a computer with no service manager has nothing to finish. */
export function serviceInstalledProbe(userHome: string): () => Promise<boolean | undefined> {
  return async () => {
    const status = await serviceManager({ userHome }).status();
    return status.installed || status.manager === "none";
  };
}

// Keyed by the probe, so every session sharing one probe shares its answer: one service lookup per ten minutes per process.
const serviceAnswers = new WeakMap<object, { at: number; value: boolean | undefined }>();

/** The owner's `contextBlocks` producer: the suggestions block, or nothing. The service status is cached for ten minutes per process. */
export function suggestionContext(i: {
  home: string;
  env: NodeJS.ProcessEnv;
  serviceInstalled: () => Promise<boolean | undefined>;
  now?: () => number;
}): () => Promise<string[]> {
  const clock = i.now ?? Date.now;
  const store = new SuggestionStore(i.home);
  const serviceInstalled = async (): Promise<boolean | undefined> => {
    const cached = serviceAnswers.get(i.serviceInstalled);
    if (cached && clock() - cached.at < SERVICE_CACHE_MS) return cached.value;
    const value = await i.serviceInstalled().catch(() => undefined);
    serviceAnswers.set(i.serviceInstalled, { at: clock(), value });
    return value;
  };
  return async () => {
    try {
      const now = clock();
      const facts = await gatherFacts({ home: i.home, env: i.env, serviceInstalled, now });
      const block = suggestionsBlock(computeSignals(facts, await store.read(), now));
      return block ? [block] : [];
    } catch {
      return []; // a suggestion is never worth a failed turn
    }
  };
}
