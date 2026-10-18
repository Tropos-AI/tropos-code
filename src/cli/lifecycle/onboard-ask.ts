// src/cli/lifecycle/onboard-ask.ts — what every wizard step asks with: text, yes/no and a list, drawn by the flow
// (src/ui/flow.ts) and answered with Enter (accept), skip or back. Kept apart from the runner so the step files can
// import it without a cycle; onboard-wizard.ts re-exports all of it.
import { SKIP, BACK, type Flow } from "../../ui/flow";
import type { OnboardDeps } from "../../onboard/engine";
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

export const MAX_KEY_TRIES = 3;
export const NEEDED = "This step is needed: Tropos can't answer without it.";

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
export async function ask(io: WizardIO, question: string, opts: { default?: string; secret?: boolean; required?: boolean; always?: boolean; validate?(value: string): string | undefined } = {}): Promise<Answer> {
  if (io.opt.quick && !opts.always) return { kind: "value", value: opts.default ?? "" };
  for (;;) {
    // An empty answer means "the default", so it is never validated.
    const validate = opts.validate && ((v: string) => (v.trim() === "" ? undefined : opts.validate!(v.trim())));
    const r = await io.flow.text({ message: question, placeholder: opts.default, secret: opts.secret, validate, skip: true, back: true });
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

