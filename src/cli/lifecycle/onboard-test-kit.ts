// src/cli/lifecycle/onboard-test-kit.ts — test-only: a WizardIO over a throwaway home, with scripted answers.
// Not imported by production code. Every answer is one line; "" takes the question's default, like Enter.
import { mkdir } from "node:fs/promises";
import { createFlow, flowStyle, type Flow } from "../../ui/flow";
import { fakeMessages, fakeNet, fakeService, testDeps } from "../../onboard/testing";
import { makeFixture, type Fixture } from "./lifecycle-fixture";
import type { OnboardCliDeps } from "./onboard";
import type { WizardIO, WizardOptions } from "./onboard-wizard";
import type { LifecycleContext } from "./types";

export interface TestWizardIO extends WizardIO {
  /** Every question asked, in order (a list or a yes/no included). */
  questions: string[];
  /** URLs passed to the browser opener. */
  opened: string[];
  out(): string;
  err(): string;
  home: string;
  root: string;
  fixture: Fixture;
  /** The answers not used yet. */
  left(): string[];
}

const open: Fixture[] = [];
/** Call from afterEach. */
export async function cleanupWizardIO(): Promise<void> {
  await Promise.all(open.splice(0).map((f) => f.cleanup()));
}

/** Both kinds of question (a line, a yes/no) read the same script, so a test lists the answers in the order they are asked. */
export function scriptAnswers(ctx: LifecycleContext, answers: string[]): { ctx: LifecycleContext; questions: string[]; left(): string[] } {
  const queue = [...answers];
  const questions: string[] = [];
  const next = (q: string): string | undefined => {
    questions.push(q);
    return queue.shift();
  };
  return {
    questions,
    left: () => queue,
    ctx: {
      ...ctx,
      interactive: true,
      prompt: async (q, opts) => {
        const a = next(q);
        return a === undefined || a === "" ? (opts?.default ?? "") : a;
      },
      confirm: async (q, defaultYes = false) => {
        const a = next(q);
        return a === undefined || a === "" ? defaultYes : /^y/i.test(a);
      },
    },
  };
}

/** A flow over the scripted context: plain frames (no colour), one answer per question. */
export function scriptedFlow(ctx: LifecycleContext): Flow {
  const style = flowStyle({ LANG: "en_US.UTF-8", NO_COLOR: "1" }, { isTTY: false, columns: 100 });
  return createFlow(
    {
      write: (t) => ctx.out(t),
      readLine: (q, o) => ctx.prompt(q, { secret: o?.secret, default: o?.default }),
      confirm: (q, d) => ctx.confirm(q, d),
    },
    style,
  );
}

/** The offline machine a wizard test runs on: no network but the fakes, no Docker, a service manager that records. */
export function engineFakes(over: NonNullable<OnboardCliDeps["engine"]> = {}): NonNullable<OnboardCliDeps["engine"]> {
  return {
    fetch: fakeNet().fetch,
    service: fakeService(),
    doctor: { checks: [] },
    confinement: async () => "sandbox-exec",
    which: () => null,
    messages: fakeMessages(),
    ...over,
  };
}

export async function wizardIO(
  answers: string[],
  engine: OnboardCliDeps["engine"] = {},
  opt: Partial<WizardOptions> = {},
  cli: Partial<OnboardCliDeps> = {},
  fixtureOver: Parameters<typeof makeFixture>[0] = {},
): Promise<TestWizardIO> {
  const fixture = await makeFixture({ interactive: true, ...fixtureOver });
  open.push(fixture);
  await mkdir(fixture.ctx.home, { recursive: true });
  const script = scriptAnswers(fixture.ctx, answers);
  const opened: string[] = [];
  const deps = testDeps(fixture.ctx.home, { env: { PATH: "" }, ...engine });
  return {
    ctx: script.ctx,
    deps,
    flow: scriptedFlow(script.ctx),
    cli: { openBrowser: (u) => void opened.push(u), sleep: async () => {}, ...cli },
    opt: { quick: false, advanced: false, noOpen: false, reset: false, acceptRisk: false, ...opt },
    questions: script.questions,
    opened,
    out: fixture.stdout,
    err: fixture.stderr,
    home: fixture.ctx.home,
    root: fixture.root,
    fixture,
    left: script.left,
  };
}
