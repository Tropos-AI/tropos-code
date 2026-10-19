import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeDocker, fakeService, GOOD_KEY } from "../../onboard/testing";
import { PROVIDERS } from "../../providers/registry";
import type { Flow } from "../../ui/flow";
import { engineFakes, scriptAnswers, scriptedFlow } from "./onboard-test-kit";
import { fakeRunner } from "../../doctor/testing";
import { makeFixture as baseFixture, type Fixture } from "./lifecycle-fixture";
import { runOnboard, type OnboardCliDeps } from "./onboard";
import type { LifecycleContext } from "./types";

const makeFixture = baseFixture;

let fx: Fixture;
afterEach(() => fx?.cleanup());

function engine(over: NonNullable<OnboardCliDeps["engine"]> = {}): NonNullable<OnboardCliDeps["engine"]> {
  const docker = fakeDocker({ daemon: false });
  return engineFakes({ runner: fakeRunner({ exec: docker.exec }), ...over });
}

/** A terminal whose prompts and yes/no questions are answered from one script; every question asked is kept. The flow is scripted too. */
function terminal(answers: string[]): { ctx: LifecycleContext; questions: string[]; flow: Flow } {
  const s = scriptAnswers(fx.ctx, answers);
  return { ctx: s.ctx, questions: s.questions, flow: scriptedFlow(s.ctx) };
}
const providerNumber = (id: string) => String(PROVIDERS.findIndex((p) => p.id === id) + 1);

const read = (name: string) => readFile(join(fx.ctx.home, name), "utf8");
const exists = async (p: string) => (await stat(p).catch(() => null)) !== null;

describe("usage", () => {
  test("--help", async () => {
    fx = await makeFixture();
    expect(await runOnboard(["--help"], fx.ctx)).toBe(0);
    expect(fx.stdout()).toContain("--api-key-env");
  });

  test.each([
    [["--api-key", "sk-secret-value"]],
    [["--api-key=sk-secret-value"]],
    [["--telegram-token=1:abc"]],
    [["--non-interactive"]],
    [["--non-interactive", "--accept-risk", "--api-key-env", "sk-abc-123"]],
    [["--non-interactive", "--accept-risk", "--provider", "nope"]],
    [["--non-interactive", "--accept-risk", "--install-service", "--skip-service"]],
    [["--json"]],
    [["--advanced", "--quick"]],
    [["--advanced", "--non-interactive", "--accept-risk"]],
    [["--bogus"]],
    [["extra"]],
  ])("%j is a usage error (64) and never echoes a key", async (argv) => {
    fx = await makeFixture({ interactive: true });
    expect(await runOnboard(argv, fx.ctx, { engine: engine() })).toBe(64);
    expect(fx.stderr()).not.toContain("sk-secret-value");
    expect(fx.stderr()).not.toContain("sk-abc-123");
    expect(fx.stderr()).toContain("tcode onboard");
  });

  test("without a terminal and without --non-interactive it refuses", async () => {
    fx = await makeFixture({ interactive: false });
    expect(await runOnboard([], fx.ctx, { engine: engine() })).toBe(64);
  });
});

test("tcode onboard on a fresh home lays it out first, so the identity step is todo", async () => {
  fx = await makeFixture({ env: { DS_KEY: GOOD_KEY } });
  const argv = ["--non-interactive", "--accept-risk", "--json", "--provider", "deepseek", "--api-key-env", "DS_KEY", "--skip-telegram", "--skip-service"];
  await runOnboard(argv, fx.ctx, { engine: engine() });
  expect(await exists(join(fx.ctx.home, "workspace", "BOOTSTRAP.md"))).toBe(true);
  expect(JSON.parse(fx.stdout()).steps.find((s: { id: string }) => s.id === "identity").status).toBe("todo");
});

describe("--non-interactive", () => {
  const base = ["--non-interactive", "--accept-risk"];

  test("connects a provider from an env var, saves the key privately, picks a model and records the flags", async () => {
    fx = await makeFixture({ env: { DS_KEY: GOOD_KEY } });
    const argv = [...base, "--provider", "deepseek", "--api-key-env", "DS_KEY", "--skip-telegram", "--skip-sandbox", "--skip-service"];
    expect(await runOnboard(argv, fx.ctx, { engine: engine() })).toBe(0);
    expect(JSON.parse(await read("credentials.json"))).toEqual({ deepseek: { apiKey: GOOD_KEY } });
    expect(((await stat(join(fx.ctx.home, "credentials.json"))).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(await read("settings.json")).model).toBe("deepseek/deepseek-chat");
    const flags = JSON.parse(await read("onboarding.json"));
    expect(flags.skipped.sort()).toEqual(["service", "telegram"]); // --skip-sandbox is accepted and does nothing
    expect(flags.dismissedAt).toBeTruthy();
    expect(fx.stdout() + fx.stderr()).not.toContain(GOOD_KEY);
  });

  test("--model must be one the provider offers; a listed one is saved", async () => {
    fx = await makeFixture({ env: { DS_KEY: GOOD_KEY } });
    const argv = [...base, "--provider", "deepseek", "--api-key-env", "DS_KEY"];
    expect(await runOnboard([...argv, "--model", "gpt-nope"], fx.ctx, { engine: engine() })).toBe(1);
    expect(fx.stderr()).toContain("gpt-nope");
    expect(await runOnboard([...argv, "--model", "deepseek-reasoner"], fx.ctx, { engine: engine() })).toBe(0);
    expect(JSON.parse(await read("settings.json")).model).toBe("deepseek/deepseek-reasoner");
  });

  test("a rejected key fails with exit 1, saves nothing and never prints the key", async () => {
    fx = await makeFixture({ env: { DS_KEY: "sk-wrong-wrong-wrong" } });
    expect(await runOnboard([...base, "--provider", "deepseek", "--api-key-env", "DS_KEY"], fx.ctx, { engine: engine() })).toBe(1);
    expect(await exists(join(fx.ctx.home, "credentials.json"))).toBe(false);
    expect(fx.stdout() + fx.stderr()).not.toContain("sk-wrong-wrong-wrong");
  });

  test("an unset env var, a missing provider and a provider without a key are failures", async () => {
    fx = await makeFixture();
    expect(await runOnboard([...base, "--provider", "deepseek", "--api-key-env", "NOPE"], fx.ctx, { engine: engine() })).toBe(1);
    expect(fx.stderr()).toContain("NOPE");
    expect(await runOnboard([...base, "--api-key-env", "NOPE"], fx.ctx, { engine: engine() })).toBe(1);
    expect(await runOnboard([...base, "--provider", "deepseek"], fx.ctx, { engine: engine() })).toBe(1);
    expect(await runOnboard(base, fx.ctx, { engine: engine() })).toBe(1);
  });

  test("an already connected machine needs no provider flags", async () => {
    fx = await makeFixture({ env: { ANTHROPIC_API_KEY: "x" } });
    expect(await runOnboard(base, fx.ctx, { engine: engine() })).toBe(0);
  });

  test("telegram token from an env var is verified with getMe and saved to gateway.json", async () => {
    fx = await makeFixture({ env: { DS_KEY: GOOD_KEY, TG: "123:good" } });
    const argv = [...base, "--provider", "deepseek", "--api-key-env", "DS_KEY", "--telegram-token-env", "TG"];
    expect(await runOnboard(argv, fx.ctx, { engine: engine() })).toBe(0);
    expect(JSON.parse(await read("gateway.json")).telegram.botToken).toBe("123:good");
    fx.ctx.env.TG = "9:bad";
    expect(await runOnboard(argv, fx.ctx, { engine: engine() })).toBe(1);
    expect(fx.stderr()).not.toContain("9:bad");
  });

  test("--install-service installs the service", async () => {
    fx = await makeFixture({ env: { DS_KEY: GOOD_KEY } });
    const service = fakeService();
    const docker = fakeDocker({ image: false });
    const argv = [...base, "--provider", "deepseek", "--api-key-env", "DS_KEY", "--install-service"];
    expect(await runOnboard(argv, fx.ctx, { engine: engine({ service, runner: fakeRunner({ exec: docker.exec }) }) })).toBe(0);
    expect(service.installed).toHaveLength(1);
    expect(docker.log).toEqual([]); // the sandbox image is no longer pulled during setup
  });

  test("--json prints one object with the steps and no key", async () => {
    fx = await makeFixture({ env: { DS_KEY: GOOD_KEY } });
    expect(await runOnboard([...base, "--json", "--provider", "deepseek", "--api-key-env", "DS_KEY", "--skip-sandbox"], fx.ctx, { engine: engine() })).toBe(0);
    const out = JSON.parse(fx.stdout());
    expect(out).toMatchObject({ ok: true, complete: true });
    expect(out.steps.map((s: { id: string }) => s.id)).toContain("provider");
    expect(fx.stdout()).not.toContain(GOOD_KEY);
  });

  test("--reset forgets an earlier dismissal first", async () => {
    fx = await makeFixture({ env: { ANTHROPIC_API_KEY: "x" } });
    await writeFile(join(fx.ctx.home, "onboarding.json"), JSON.stringify({ dismissedAt: "2026-01-01T00:00:00Z", skipped: ["telegram"] })).catch(async () => {
      await mkdir(fx.ctx.home, { recursive: true });
      await writeFile(join(fx.ctx.home, "onboarding.json"), JSON.stringify({ dismissedAt: "2026-01-01T00:00:00Z", skipped: ["telegram"] }));
    });
    expect(await runOnboard([...base, "--reset"], fx.ctx, { engine: engine() })).toBe(0);
    const flags = JSON.parse(await read("onboarding.json"));
    expect(flags.skipped).toBeUndefined();
    expect(flags.dismissedAt).toBe("2026-10-15T12:00:00.000Z");
  });
});

describe("interactive", () => {
  const eng = () => engine({ anthropicModels: async () => ["claude-opus-5-5"] });

  test("shows the welcome and the notice before the question, walks the steps, installs the service, opens the dashboard", async () => {
    fx = await makeFixture({ interactive: true });
    const opened: string[] = [];
    const service = fakeService();
    //  risk, provider, open key page, key, model, name (skip), [projects: none found], autonomy, telegram (skip), phone (skip), service, dashboard
    const { ctx, questions, flow } = terminal(["y", providerNumber("deepseek"), "", GOOD_KEY, "", "s", "", "s", "s", "y", "y"]);
    const code = await runOnboard([], ctx, { engine: engine({ service }), flow, sleep: async () => {}, openBrowser: (u) => void opened.push(u) });
    expect(code).toBe(0);
    const out = fx.stdout();
    expect(out).toContain("Set up Tropos Code");
    expect(out.indexOf("Welcome to Tropos")).toBeLessThan(out.indexOf("~/.tropos/credentials.json"));
    expect(out.indexOf("~/.tropos/credentials.json")).toBeLessThan(out.indexOf("Do you understand"));
    expect(out).toContain("[1/");
    expect(out).toContain("Connect a model");
    expect(out).not.toContain(GOOD_KEY);
    expect(questions.some((q) => q.includes("API key"))).toBe(true);
    expect(JSON.parse(await read("credentials.json")).deepseek.apiKey).toBe(GOOD_KEY);
    expect(JSON.parse(await read("settings.json")).model).toBe("deepseek/deepseek-chat");
    expect(service.installed).toHaveLength(1);
    expect(opened[0]).toBe("https://platform.deepseek.com/api_keys");
    expect(opened.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:4317\/#login=[A-Za-z0-9_-]{43}$/);
    const flags = JSON.parse(await read("onboarding.json"));
    expect(flags.skipped).toEqual(["identity", "telegram", "phone"]);
    expect(flags.dismissedAt).toBeTruthy();
    expect(JSON.parse(await read("gateway.json")).chat).toMatchObject({ autonomy: "balanced", backend: "host" });
    expect(out).toContain("Setup is complete.");
    expect(flags.startedAt).toBeTruthy();
    expect(questions[0]).toContain("understand");
  });

  test("declining the notice stops without changing anything", async () => {
    fx = await makeFixture({ interactive: true });
    const { ctx, flow } = terminal(["n"]);
    expect(await runOnboard([], ctx, { engine: engine(), flow })).toBe(1);
    expect(await exists(join(fx.ctx.home, "credentials.json"))).toBe(false);
    expect(await exists(join(fx.ctx.home, "onboarding.json"))).toBe(false);
  });

  test("--accept-risk skips the question; three wrong keys give up with exit 1 and save nothing", async () => {
    fx = await makeFixture({ interactive: true });
    const { ctx, questions, flow } = terminal([providerNumber("deepseek"), "", "sk-bad-1", "sk-bad-2", "sk-bad-3"]);
    expect(await runOnboard(["--accept-risk"], ctx, { engine: engine(), flow })).toBe(1);
    expect(questions.some((q) => q.includes("understand"))).toBe(false);
    expect(fx.stdout() + fx.stderr()).not.toContain("sk-bad");
    expect(fx.stdout()).toContain("That key was rejected by DeepSeek");
    expect(await exists(join(fx.ctx.home, "credentials.json"))).toBe(false);
  });

  test("on --reset a key already in the environment is offered first and is not copied to credentials.json", async () => {
    fx = await makeFixture({ interactive: true, env: { DEEPSEEK_API_KEY: GOOD_KEY } });
    const { ctx, flow } = terminal(["y" /*risk*/, "" /*provider*/, "" /*model*/, "s" /*name*/, "" /*autonomy*/, "n" /*telegram*/, "n" /*phone*/, "n" /*service*/]);
    expect(await runOnboard(["--reset", "--no-open"], ctx, { engine: engine(), flow, sleep: async () => {} })).toBe(0);
    expect(fx.stdout()).toContain("found: $DEEPSEEK_API_KEY");
    expect(await exists(join(fx.ctx.home, "credentials.json"))).toBe(false);
    expect(JSON.parse(await read("settings.json")).model).toBe("deepseek/deepseek-chat");
    expect(fx.stdout()).toContain("Open the dashboard any time with `tcode dashboard`.");
  });

  test("--quick asks nothing but the key, skips Telegram, installs the service and opens the dashboard", async () => {
    fx = await makeFixture({ interactive: true });
    const { ctx, questions, flow } = terminal([providerNumber("deepseek"), GOOD_KEY]);
    const opened: string[] = [];
    const service = fakeService();
    expect(await runOnboard(["--quick", "--accept-risk"], ctx, { engine: engine({ service }), flow, sleep: async () => {}, openBrowser: (u) => void opened.push(u) })).toBe(0);
    expect(questions).toHaveLength(2); // which provider, the key
    expect(service.installed).toHaveLength(1);
    expect(opened.at(-1)).toContain("#login=");
    expect(JSON.parse(await read("onboarding.json")).skipped).toEqual(["identity", "telegram", "phone"]);
  });

  test("--no-open never opens the browser", async () => {
    fx = await makeFixture({ interactive: true, env: { ANTHROPIC_API_KEY: "x" } });
    const { ctx, flow } = terminal(["s" /*name*/, "" /*autonomy*/, "n" /*telegram*/, "n" /*phone*/, "y" /*service*/]);
    const opened: string[] = [];
    expect(await runOnboard(["--accept-risk", "--no-open"], ctx, { engine: eng(), flow, openBrowser: (u) => void opened.push(u) })).toBe(0);
    expect(opened).toEqual([]);
    expect(fx.stdout()).toContain("tcode dashboard");
  });

  test("telegram: a wrong token is explained and never echoed; three wrong ones skip the step", async () => {
    fx = await makeFixture({ interactive: true, env: { ANTHROPIC_API_KEY: "x" } });
    const { ctx, flow } = terminal(["s" /*name*/, "" /*autonomy*/, "y" /*telegram*/, "n" /*BotFather*/, "9:bad", "8:bad", "7:bad", "n" /*phone*/, "n" /*service*/]);
    expect(await runOnboard(["--accept-risk", "--no-open"], ctx, { engine: eng(), flow, sleep: async () => {} })).toBe(0);
    expect(fx.stdout()).toContain("Telegram didn't accept that token");
    expect(fx.stdout() + fx.stderr()).not.toMatch(/[789]:bad/);
    expect(await exists(join(fx.ctx.home, "gateway", "pairing.json"))).toBe(false);
    expect(JSON.parse(await read("onboarding.json")).skipped).toContain("telegram");
  });

  test("a finished setup is not asked again, but --reset asks every step", async () => {
    fx = await makeFixture({ interactive: true, env: { ANTHROPIC_API_KEY: "x" } });
    const first = terminal(["s", "", "n", "n", "n"]);
    expect(await runOnboard(["--accept-risk", "--no-open"], first.ctx, { engine: eng(), flow: first.flow, sleep: async () => {} })).toBe(0);
    const again = terminal([]);
    expect(await runOnboard(["--accept-risk", "--no-open"], again.ctx, { engine: eng(), flow: again.flow, sleep: async () => {} })).toBe(0);
    expect(again.questions).toEqual([]);
    const reset = terminal(["", "", "s", "", "n", "n", "n"]);
    expect(await runOnboard(["--accept-risk", "--no-open", "--reset"], reset.ctx, { engine: eng(), flow: reset.flow, sleep: async () => {} })).toBe(0);
    expect(reset.questions.some((q) => q.startsWith("Which model"))).toBe(true);
  });
});
