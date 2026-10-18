import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { STEP_ORDER } from "../../onboard/engine";
import { readOnboardingFlags } from "../../onboard/flags";
import { GOOD_KEY, fakeNet } from "../../onboard/testing";
import { PROVIDERS } from "../../providers/registry";
import type { OnboardState, OnboardStepId } from "../../web/admin/api";
import { cleanupWizardIO, wizardIO } from "./onboard-test-kit";
import { ask, askYesNo, modelStep, providerStep, runSteps, stepsToVisit, type StepHandler, type StepOutcome } from "./onboard-wizard";

afterEach(cleanupWizardIO);

const read = (io: { home: string }, name: string) => readFile(join(io.home, name), "utf8");
const exists = async (p: string) => (await stat(p).catch(() => null)) !== null;
const number = (id: string) => String(PROVIDERS.findIndex((p) => p.id === id) + 1);
const ANTHROPIC_BAD = { anthropicModels: async (k: string) => { if (k !== "sk-ant-good") throw new Error("401 invalid x-api-key"); return ["claude-opus-5-5"]; } };

describe("ask", () => {
  test("Enter takes the default, /skip skips, /back goes back; a required question refuses to skip", async () => {
    const io = await wizardIO(["", "/skip", "/back", "/skip", "x"]);
    expect(await ask(io, "Q", { default: "d" })).toEqual({ kind: "value", value: "d" });
    expect(await ask(io, "Q")).toEqual({ kind: "skip" });
    expect(await ask(io, "Q")).toEqual({ kind: "back" });
    expect(await ask(io, "Q", { required: true })).toEqual({ kind: "value", value: "x" });
    expect(io.out()).toContain("This step is needed");
  });

  test("--quick answers with the default and asks nothing, unless the answer cannot be guessed", async () => {
    const io = await wizardIO(["typed"], {}, { quick: true });
    expect(await ask(io, "Q", { default: "d" })).toEqual({ kind: "value", value: "d" });
    expect(await askYesNo(io, "Open?", true)).toBe(true);
    expect(io.questions).toEqual([]);
    expect(await ask(io, "Key", { always: true })).toEqual({ kind: "value", value: "typed" });
  });

  test("askYesNo: y, n, Enter for the default, s and b", async () => {
    const io = await wizardIO(["y", "n", "", "s", "b"]);
    expect(await askYesNo(io, "Q", false)).toBe(true);
    expect(await askYesNo(io, "Q", true)).toBe(false);
    expect(await askYesNo(io, "Q", true)).toBe(true);
    expect(await askYesNo(io, "Q", true)).toBe("skip");
    expect(await askYesNo(io, "Q", true)).toBe("back");
  });
});

describe("stepsToVisit", () => {
  const state = (todo: OnboardStepId[]): OnboardState => ({
    complete: false,
    dismissed: false,
    steps: STEP_ORDER.map((id) => ({ id, title: id, status: todo.includes(id) ? "todo" : id === "service" ? "skipped" : "done", optional: true })),
  });

  test("open steps in order, never welcome, done always last", () => {
    expect(stepsToVisit(state(["welcome", "model", "telegram"]), false)).toEqual(["model", "telegram", "done"]);
    expect(stepsToVisit(state([]), false)).toEqual(["done"]);
  });

  test("--reset visits everything but welcome, skipped steps included", () => {
    expect(stepsToVisit(state([]), true)).toEqual(["provider", "model", "identity", "projects", "autonomy", "telegram", "phone", "service", "done"]);
  });
});

describe("runSteps", () => {
  test("a step announces itself; skip records at once; back returns to the previous step", async () => {
    const io = await wizardIO([]);
    const visited: string[] = [];
    const script = ["next", "next", "skip", "back", "next", "next"];
    const h = (id: OnboardStepId): StepHandler => async () => (visited.push(id), script.shift() as StepOutcome);
    const result = await runSteps(io, { provider: h("provider"), model: h("model"), identity: h("identity"), projects: h("projects") }, ["provider", "model", "identity", "projects"]);
    expect(result).toEqual({ aborted: false });
    expect(visited).toEqual(["provider", "model", "identity", "projects", "identity", "projects"]);
    expect((await readOnboardingFlags(io.home)).skipped).toEqual(["identity"]);
    expect(io.out()).toContain("[1/4] Connect a model");
    expect(io.out()).toContain("Tropos needs an AI provider to think with.");
  });

  test("back on the first step stays there; a step without a handler counts as next; abort stops", async () => {
    const io = await wizardIO([]);
    const seen: string[] = [];
    const outcomes: StepOutcome[] = ["back", "next"];
    const first: StepHandler = async () => (seen.push("provider"), outcomes.shift()!);
    expect(await runSteps(io, { provider: first }, ["provider", "projects"])).toEqual({ aborted: false });
    expect(seen).toEqual(["provider", "provider"]);
    expect(await runSteps(io, { provider: async () => "abort", model: async () => "next" }, ["provider", "model"])).toEqual({ aborted: true });
  });

  test("a required step cannot be skipped: it is asked again", async () => {
    const io = await wizardIO([]);
    const outcomes: StepOutcome[] = ["skip", "next"];
    let calls = 0;
    await runSteps(io, { provider: async () => (calls++, outcomes.shift()!) }, ["provider"]);
    expect(calls).toBe(2);
    expect(io.out()).toContain("This step is needed");
    expect((await readOnboardingFlags(io.home)).skipped).toBeUndefined();
  });
});

describe("providerStep", () => {
  test("Anthropic without a key opens its key page, explains a rejected key without echoing it, saves a good one", async () => {
    const io = await wizardIO([number("anthropic"), "", "sk-ant-bad-0000", "sk-ant-good"], ANTHROPIC_BAD);
    expect(await providerStep(io)).toBe("next");
    expect(io.opened).toEqual(["https://platform.claude.com/settings/keys"]);
    expect(io.out()).toContain("That key was rejected by Anthropic. Check you copied all of it.");
    expect(io.out() + io.err()).not.toContain("sk-ant-bad-0000");
    expect(JSON.parse(await read(io, "credentials.json")).anthropic.apiKey).toBe("sk-ant-good");
  });

  test("a key in the environment is listed first, validated and not copied", async () => {
    const io = await wizardIO([""], { env: { PATH: "", DEEPSEEK_API_KEY: GOOD_KEY } });
    expect(await providerStep(io)).toBe("next");
    expect(io.out()).toMatch(/1\. DeepSeek[^\n]*found: \$DEEPSEEK_API_KEY/);
    expect(await exists(join(io.home, "credentials.json"))).toBe(false);
    expect(io.out()).not.toContain(GOOD_KEY);
  });

  test("a silent local server says how to start it; /back returns to the list", async () => {
    const io = await wizardIO([number("ollama"), "/back", number("deepseek"), "", GOOD_KEY]);
    expect(await providerStep(io)).toBe("next");
    const text = io.out().replace(/\n│  /g, " "); // a long sentence is wrapped inside the gutter
    expect(text).toContain("isn't answering on http://localhost:11434");
    expect(text).toContain("Start it, then press Enter to check again (b picks another provider).");
    expect(JSON.parse(await read(io, "credentials.json")).deepseek.apiKey).toBe(GOOD_KEY);
  });

  test("an empty key goes back to the list", async () => {
    const io = await wizardIO([number("deepseek"), "n", "", number("deepseek"), "n", GOOD_KEY]);
    expect(await providerStep(io)).toBe("next");
    expect(io.opened).toEqual([]);
  });

  test("three rejected keys abort and save nothing", async () => {
    const io = await wizardIO([number("anthropic"), "", "sk-ant-bad-1", "sk-ant-bad-2", "sk-ant-bad-3"], ANTHROPIC_BAD);
    expect(await providerStep(io)).toBe("abort");
    expect(await exists(join(io.home, "credentials.json"))).toBe(false);
    expect(io.out()).not.toContain("sk-ant-bad");
  });

  test("a provider that cannot be reached says so, in plain words", async () => {
    const io = await wizardIO([number("openai"), "n", "sk-whatever", "sk-whatever", "sk-whatever"]);
    expect(await providerStep(io)).toBe("abort");
    expect(io.out()).toContain("Couldn't reach OpenAI");
  });

  test("/back on the first question goes back a step", async () => {
    const io = await wizardIO(["b"]);
    expect(await providerStep(io)).toBe("back");
  });
});

describe("modelStep", () => {
  const seven = ["deepseek-chat", "deepseek-reasoner", "m3", "m4", "m5", "m6", "m7"];
  const env = { PATH: "", DEEPSEEK_API_KEY: GOOD_KEY };

  test("the short list puts the best model first and Enter saves it", async () => {
    const io = await wizardIO([""], { env, fetch: fakeNet(seven).fetch });
    expect(await modelStep(io)).toBe("next");
    expect(io.out()).toContain("m5");
    expect(io.out()).not.toContain("m6");
    expect(io.out()).toContain("advanced");
    expect(JSON.parse(await read(io, "settings.json")).model).toBe("deepseek/deepseek-chat");
  });

  test("--advanced lists them all, and a number picks one", async () => {
    const io = await wizardIO(["7"], { env, fetch: fakeNet(seven).fetch }, { advanced: true });
    expect(await modelStep(io)).toBe("next");
    expect(io.out()).toContain("m7");
    expect(JSON.parse(await read(io, "settings.json")).model).toBe("deepseek/m7");
  });

  test("with no provider connected the step cannot continue", async () => {
    const io = await wizardIO([]);
    expect(await modelStep(io)).toBe("back");
    expect(io.out()).toContain("Connect a provider first");
  });
});
