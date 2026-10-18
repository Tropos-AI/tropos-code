// src/cli/lifecycle/onboard-wizard.ts — the terminal wizard: a step runner (Enter accepts, s skips, b goes back) and the
// provider and model steps. Every step is drawn with the flow API (src/ui/flow.ts), so the look is the same everywhere.
// The other steps live in onboard-steps.ts and onboard-remote-steps.ts and register themselves in TERMINAL_STEPS.
import {
  REQUIRED_STEPS,
  STEP_TITLES,
  computeOnboardState,
  detectProviders,
  effectiveModel,
  explainKeyError,
  finish,
  healthReport,
  installService,
  listModels,
  markStarted,
  modelIdFor,
  pickDefaultModel,
  reopen,
  saveKey,
  saveModel,
  saveTelegram,
  shortModelList,
  skipStep,
  validateKey,
  verifyTelegram,
  type OnboardDeps,
} from "../../onboard/engine";
import { RISK_NOTICE, STEP_WHY, WELCOME_LINES } from "../../onboard/copy";
import { CredentialsError } from "../../providers/credentials";
import { BACK, FlowCancelled, SKIP, type Flow } from "../../ui/flow";
import type { OnboardState, OnboardStepId } from "../../web/admin/api";
import { dashboardLoginLink } from "../../web/links";
import { runningDashboard } from "./dashboard";
import type { OnboardCliDeps } from "./onboard";
import type { LifecycleContext } from "./types";

export interface WizardOptions {
  /** Take every suggested answer without asking (an answer that cannot be guessed, such as a key, is still asked). */
  quick: boolean;
  /** Ask about every option and list every model. */
  advanced: boolean;
  noOpen: boolean;
  reset: boolean;
  /** The notice was accepted on the command line. */
  acceptRisk: boolean;
}

export interface WizardIO {
  ctx: LifecycleContext;
  deps: OnboardDeps;
  cli: OnboardCliDeps;
  opt: WizardOptions;
  flow: Flow;
}

export type Answer = { kind: "value"; value: string } | { kind: "skip" } | { kind: "back" };
export type StepOutcome = "next" | "skip" | "back" | "abort";
export type StepHandler = (io: WizardIO) => Promise<StepOutcome>;

const MAX_KEY_TRIES = 3;
const NEEDED = "This step is needed: Tropos can't answer without it.";

/** Text wrapped to the terminal so a line is never cut off by the frame (a wrapped frame line would break the redraw). */
export function wrapText(text: string, width = Math.max(40, (process.stdout.columns ?? 80) - 8)): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
}

/** Several sentences as frame lines, each wrapped to the terminal. */
export const wrapAll = (...texts: string[]): string[] => texts.flatMap((t) => wrapText(t));

/**
 * A line of text. Enter takes `default`; Esc (`/skip` without a terminal) skips and Ctrl+B (`/back`) goes back.
 * `--quick` answers with the default without asking, unless `always` (a key cannot be guessed).
 */
export async function ask(io: WizardIO, question: string, opts: { default?: string; secret?: boolean; required?: boolean; always?: boolean } = {}): Promise<Answer> {
  if (io.opt.quick && !opts.always) return { kind: "value", value: opts.default ?? "" };
  for (;;) {
    const r = await io.flow.text({ message: question, placeholder: opts.default, secret: opts.secret, skip: true, back: true });
    if (r === SKIP) {
      if (!opts.required) return { kind: "skip" };
      io.flow.warn(NEEDED);
      continue;
    }
    if (r === BACK) return { kind: "back" };
    const value = r.trim();
    return { kind: "value", value: value === "" ? (opts.default ?? "") : value };
  }
}

/** A yes/no question; `--quick` answers with the default. */
export async function askYesNo(io: WizardIO, question: string, defaultYes: boolean): Promise<boolean | "skip" | "back"> {
  if (io.opt.quick) return defaultYes;
  const r = await io.flow.confirm({ message: question, initial: defaultYes, skip: true, back: true });
  return r === SKIP ? "skip" : r === BACK ? "back" : r;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean | string;
}

/** A pick from a list (↑/↓ and Enter; s and b where they apply). `--quick` takes `initial`, unless `always`. */
export async function choose<T extends string>(
  io: WizardIO,
  o: { message: string; options: readonly Choice<T>[]; initial?: T; skip?: boolean; back?: boolean; always?: boolean },
): Promise<T | "skip" | "back"> {
  if (io.opt.quick && !o.always) return o.initial ?? o.options.find((x) => !x.disabled)!.value;
  const r: T | typeof SKIP | typeof BACK = await io.flow.select<T>({ message: o.message, options: o.options, initial: o.initial, skip: o.skip, back: o.back });
  return r === SKIP ? "skip" : r === BACK ? "back" : (r as T);
}

/** Opens a page in the browser. The address is always printed too, so a failure here costs nothing. */
export async function openUrl(io: WizardIO, url: string): Promise<void> {
  try {
    await (io.cli.openBrowser ?? (async (u: string) => (await import("../../web/serve")).openInBrowser(u)))(url);
  } catch {
    // the link is on screen
  }
}

// ---------- the runner ----------

/** Every open step in order (all of them with `reset`), never the welcome, and the closing step last. */
export function stepsToVisit(state: OnboardState, reset: boolean): OnboardStepId[] {
  const open = state.steps.filter((s) => s.id !== "welcome" && s.id !== "done" && (reset || s.status === "todo" || s.status === "warn" || s.status === "error")).map((s) => s.id);
  return [...open, "done"];
}

export async function runSteps(io: WizardIO, handlers: Partial<Record<OnboardStepId, StepHandler>>, visit: OnboardStepId[]): Promise<{ aborted: boolean }> {
  let i = 0;
  while (i < visit.length) {
    const id = visit[i]!;
    io.flow.info([`[${i + 1}/${visit.length}] ${STEP_TITLES[id]}`, ...wrapText(STEP_WHY[id])]);
    const handler = handlers[id];
    const outcome = handler ? await handler(io) : "next";
    if (outcome === "abort") return { aborted: true };
    if (outcome === "back") i = Math.max(0, i - 1);
    else if (outcome === "skip") {
      if ((REQUIRED_STEPS as readonly string[]).includes(id)) io.flow.warn(NEEDED);
      else {
        await skipStep(io.deps, id);
        i++;
      }
    } else i++;
  }
  return { aborted: false };
}

// ---------- provider ----------

const foundIn = (p: { source: string | null; envName?: string }) => (p.source === "env" ? `$${p.envName}` : p.source === "saved" ? "saved key" : "local server");

export const providerStep: StepHandler = async (io) => {
  const { flow, deps } = io;
  for (;;) {
    const all = await detectProviders(deps);
    const ordered = [...all.filter((p) => p.source), ...all.filter((p) => !p.source)];
    const detected = ordered.filter((p) => p.source).length;
    const picked = await choose(io, {
      message: "Which AI provider do you want to use?",
      options: ordered.map((p) => ({ value: p.info.id, label: p.source ? `${p.info.name} (found: ${foundIn(p)})` : p.info.name })),
      initial: ordered[0]!.info.id,
      back: true,
      always: detected === 0,
    });
    if (picked === "back" || picked === "skip") return "back";
    const { info, source } = ordered.find((p) => p.info.id === picked)!;

    if (source) {
      const r = await listModels(deps, info.id);
      if (r.ok) {
        flow.success(`${info.name} works (${r.models.length} models).`);
        return "next";
      }
      flow.error(wrapText(explainKeyError(info.name, r)));
      continue;
    }

    if (!info.keyRequired && info.keyURL === null) {
      // A local server: nothing to type, it has to be running.
      for (;;) {
        flow.warn(wrapText(`${info.name} isn't answering on ${info.baseURL}. Start it, then press Enter to check again (b picks another provider).`));
        const a = await ask(io, "Check again", { always: true });
        if (a.kind !== "value") break;
        const r = await validateKey(deps, { provider: info.id, key: "" });
        if (r.ok) {
          flow.success(`${info.name} works (${r.models.length} models).`);
          return "next";
        }
      }
      continue;
    }

    if (info.keyURL) {
      const open = await askYesNo(io, `Open ${info.keyURL} to create a key?`, true);
      if (open === "back" || open === "skip") continue;
      flow.note([`Create a key at ${info.keyURL}`]);
      if (open) await openUrl(io, info.keyURL);
    }
    for (let attempt = 1; attempt <= MAX_KEY_TRIES; attempt++) {
      const a = await ask(io, `${info.name} API key (hidden; leave empty to pick another provider)`, { secret: true, always: true });
      if (a.kind !== "value" || a.value === "") break;
      const r = await validateKey(deps, { provider: info.id, key: a.value });
      if (r.ok) {
        try {
          await saveKey(deps, { provider: info.id, key: a.value });
        } catch (err) {
          flow.error(err instanceof CredentialsError ? err.message : "The key could not be saved.");
          return "abort";
        }
        flow.success(wrapText(`Key works (${r.models.length} models) and is saved in ~/.tropos/credentials.json.`));
        return "next";
      }
      flow.error(wrapText(explainKeyError(info.name, r)));
      if (attempt === MAX_KEY_TRIES) {
        flow.error(wrapText("That's three tries. Nothing was saved; run `tcode onboard` to try again."));
        return "abort";
      }
    }
  }
};

// ---------- model ----------

export const modelStep: StepHandler = async (io) => {
  const { flow, deps, opt } = io;
  const connected = (await detectProviders(deps)).filter((p) => p.source);
  if (!connected.length) {
    flow.error("Connect a provider first.");
    return "back";
  }
  const current = await effectiveModel(deps.home);
  const slash = current.model.indexOf("/");
  const currentProvider = slash > 0 ? current.model.slice(0, slash) : "anthropic";
  const owner = connected.find((p) => p.info.id === currentProvider) ?? connected[0]!;
  const sameProvider = owner.info.id === currentProvider;
  const currentBare = sameProvider ? (slash > 0 ? current.model.slice(slash + 1) : current.model) : undefined;

  const listing = await listModels(deps, owner.info.id);
  if (!listing.ok || !listing.models.length) {
    flow.warn(wrapText(listing.ok ? `${owner.info.name} listed no models; type the id of one.` : `${explainKeyError(owner.info.name, listing)} Type the id of a model instead.`));
    for (;;) {
      const a = await ask(io, "Model id", { default: currentBare, always: true });
      if (a.kind !== "value") return "back";
      if (!a.value) continue;
      const id = a.value.includes("/") || owner.info.id === "anthropic" ? a.value : modelIdFor(owner.info.id, a.value);
      await saveModel(deps, id);
      flow.success(`Model: ${id}`);
      return "next";
    }
  }

  const { models } = listing;
  const best = pickDefaultModel(owner.info.id, models)!;
  const keep = current.explicit && currentBare && models.includes(currentBare) ? currentBare : undefined;
  let list = opt.advanced ? models.slice(0, 15) : shortModelList(owner.info.id, models);
  if (keep && !list.includes(keep)) list = [keep, ...list];
  if (list.length < models.length) flow.info(wrapText(`Showing ${list.length} of ${models.length} models; run \`tcode onboard --advanced\` to see more.`));
  const picked = await choose(io, { message: "Which model should answer?", options: list.map((m) => ({ value: m, label: m })), initial: keep ?? best, back: true });
  if (picked === "back" || picked === "skip") return "back";
  const id = modelIdFor(owner.info.id, picked);
  await saveModel(deps, id);
  if (opt.quick) flow.success(`Model: ${id}`);
  return "next";
};

// ---------- telegram, service, done (carried over; Task 10 replaces them) ----------

const telegramStep: StepHandler = async (io) => {
  const { flow, deps } = io;
  const want = await askYesNo(io, "Connect a Telegram bot so you can chat from your phone?", false);
  if (want === "back") return "back";
  if (want !== true) return "skip";
  flow.info("Create a bot with @BotFather in Telegram and copy its token.");
  for (let attempt = 1; attempt <= MAX_KEY_TRIES; attempt++) {
    const a = await ask(io, "Bot token (hidden; leave empty to skip)", { secret: true, always: true });
    if (a.kind !== "value" || !a.value) return "skip";
    const me = await verifyTelegram(deps, a.value);
    if (me.ok) {
      await saveTelegram(deps, a.value);
      flow.success(`Connected to @${me.username || "your bot"}.`);
      return "next";
    }
    flow.error(`Telegram did not accept it: ${me.error}`);
  }
  return "skip";
};

const serviceStep: StepHandler = async (io) => {
  const { flow, deps } = io;
  const want = await askYesNo(io, "Keep the gateway running in the background (starts at login)?", true);
  if (want === "back") return "back";
  if (want !== true) return "skip";
  try {
    const { unitPath, hint } = await installService(deps);
    flow.success([`Background service installed (${unitPath}).`, ...(hint ? [hint] : [])]);
    return "next";
  } catch (err) {
    flow.error([`Could not install the service: ${err instanceof Error ? err.message : "failed"}`, "You can run `tcode gateway` yourself instead."]);
    return "skip";
  }
};

const doneStep: StepHandler = async (io) => {
  const { flow, deps, cli, ctx, opt } = io;
  const report = await healthReport(deps).catch(() => null);
  if (!report) flow.warn("The health check could not run; try `tcode doctor`.");
  else {
    const { ok, warn, error } = report.summary;
    const problems = report.findings.filter((x) => x.level === "warn" || x.level === "error").slice(0, 8);
    flow.info([`Health: ${ok} ok, ${warn} warning${warn === 1 ? "" : "s"}, ${error} error${error === 1 ? "" : "s"}`, ...problems.map((f) => `- ${f.message}`), ...(warn + error ? ["Run `tcode doctor` for details and fixes."] : [])]);
  }
  const sleep = cli.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let target = await runningDashboard(ctx.home, cli.alive);
  // A service that was just started needs a moment to write its state file.
  for (let i = 0; !target && i < 10 && (await deps.service.status().catch(() => null))?.running; i++) {
    await sleep(300);
    target = await runningDashboard(ctx.home, cli.alive);
  }
  if (!target) {
    flow.info("The gateway is not running. Start it with `tcode gateway` (or `tcode gateway install`), then open the dashboard with `tcode dashboard`.");
    return "next";
  }
  const open = opt.noOpen ? false : await askYesNo(io, "Open the web dashboard now?", true);
  if (open !== true) {
    flow.info(`Open the dashboard any time with: tcode dashboard  (${target.url})`);
    return "next";
  }
  // The one-time link logs this browser in; it is issued only when it is about to be opened.
  await openUrl(io, await dashboardLoginLink(ctx.home, target.port));
  flow.success(`Opened ${target.url}`);
  return "next";
};

/** Filled in by the step files of Tasks 9 and 10. */
export const TERMINAL_STEPS: Partial<Record<OnboardStepId, StepHandler>> = { provider: providerStep, model: modelStep, telegram: telegramStep, service: serviceStep, done: doneStep };

// ---------- the whole wizard ----------

export async function runWizard(io: WizardIO): Promise<number> {
  const { flow, deps, opt } = io;
  try {
    flow.intro("Set up Tropos Code");
    flow.note(wrapAll(...WELCOME_LINES));
    flow.warn(wrapAll(...RISK_NOTICE));
    if (!opt.acceptRisk && !(await flow.confirm({ message: "Do you understand and want to continue?", initial: false }))) {
      flow.outro("Setup cancelled; nothing was changed.");
      return 1;
    }
    if (opt.reset) await reopen(deps);
    await markStarted(deps);
    const state = await computeOnboardState(deps, { health: false });
    const { aborted } = await runSteps(io, TERMINAL_STEPS, stepsToVisit(state, opt.reset));
    if (aborted) {
      flow.outro("Setup stopped. Run `tcode onboard` to continue where you left off.");
      return 1;
    }
    const final = await finish(deps);
    flow.outro(final.complete ? "Setup is complete." : "Setup is not complete yet: Tropos still needs a provider and a model. Run `tcode onboard` to finish.");
    return final.complete ? 0 : 1;
  } catch (err) {
    if (err instanceof FlowCancelled) {
      flow.outro("Setup stopped. Run `tcode onboard` to continue where you left off.");
      return 1;
    }
    throw err;
  }
}
