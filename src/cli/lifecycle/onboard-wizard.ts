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
  listModels,
  markStarted,
  modelIdFor,
  pickDefaultModel,
  reopen,
  saveKey,
  saveModel,
  shortModelList,
  skipStep,
  validateKey,
  type OnboardDeps,
} from "../../onboard/engine";
import { RISK_NOTICE, STEP_WHY, WELCOME_LINES } from "../../onboard/copy";
import { CredentialsError } from "../../providers/credentials";
import { FlowCancelled } from "../../ui/flow";
import type { OnboardState, OnboardStepId } from "../../web/admin/api";
import { doneStep, messagesStep, phoneStep, serviceStep, telegramStep } from "./onboard-remote-steps";
import { autonomyStep, identityStep, projectsStep } from "./onboard-steps";
import { MAX_KEY_TRIES, NEEDED, ask, askYesNo, choose, openUrl, wrapAll, wrapText, type StepHandler, type StepOutcome, type WizardIO } from "./onboard-ask";

export * from "./onboard-ask";

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

export const TERMINAL_STEPS: Partial<Record<OnboardStepId, StepHandler>> = { provider: providerStep, model: modelStep, identity: identityStep, projects: projectsStep, autonomy: autonomyStep, telegram: telegramStep, phone: phoneStep, messages: messagesStep, service: serviceStep, done: doneStep };

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
