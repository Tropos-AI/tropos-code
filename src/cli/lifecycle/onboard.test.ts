import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeDocker, fakeNet, fakeService, GOOD_KEY } from "../../onboard/testing";
import { fakeRunner } from "../../doctor/testing";
import { makeFixture, type Fixture } from "./lifecycle-fixture";
import { runOnboard, type OnboardCliDeps } from "./onboard";
import type { LifecycleContext } from "./types";

let fx: Fixture;
afterEach(() => fx?.cleanup());

function engine(over: NonNullable<OnboardCliDeps["engine"]> = {}): NonNullable<OnboardCliDeps["engine"]> {
  const docker = fakeDocker({ daemon: false });
  return { fetch: fakeNet().fetch, service: fakeService(), doctor: { checks: [] }, runner: fakeRunner({ exec: docker.exec }), ...over };
}

/** A terminal whose prompts are answered from a script; every question asked is kept. */
function terminal(prompts: string[]): { ctx: LifecycleContext; questions: string[] } {
  const questions: string[] = [];
  const queue = [...prompts];
  const ctx: LifecycleContext = {
    ...fx.ctx,
    interactive: true,
    prompt: async (q, opts) => {
      questions.push(q);
      const next = queue.shift();
      return next === undefined || next === "" ? (opts?.default ?? "") : next;
    },
  };
  return { ctx, questions };
}

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
    expect(flags.skipped.sort()).toEqual(["sandbox", "service", "telegram"]);
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

  test("--install-service installs the service; sandbox image is pulled when Docker works", async () => {
    fx = await makeFixture({ env: { DS_KEY: GOOD_KEY } });
    const service = fakeService();
    const docker = fakeDocker({ image: false });
    const argv = [...base, "--provider", "deepseek", "--api-key-env", "DS_KEY", "--install-service"];
    expect(await runOnboard(argv, fx.ctx, { engine: engine({ service, runner: fakeRunner({ exec: docker.exec }) }) })).toBe(0);
    expect(service.installed).toHaveLength(1);
    expect(docker.hasImage).toBe(true);
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
  async function gatewayUp() {
    await mkdir(join(fx.ctx.home, "gateway"), { recursive: true });
    await writeFile(join(fx.ctx.home, "gateway", "state.json"), JSON.stringify({ pid: 4242, webPort: 4321 }));
    await writeFile(join(fx.ctx.home, "gateway", "token"), `${"t".repeat(40)}\n`);
  }

  test("shows the notice, walks the steps, installs the service, opens the dashboard", async () => {
    fx = await makeFixture({ interactive: true, answers: [true /*risk*/, false /*telegram*/, true /*service*/, true /*open*/] });
    await gatewayUp();
    const { ctx, questions } = terminal(["deepseek", GOOD_KEY, "1"]);
    const opened: string[] = [];
    const service = fakeService();
    const code = await runOnboard([], ctx, { engine: engine({ service }), alive: (p) => p === 4242, sleep: async () => {}, openBrowser: (u) => void opened.push(u) });
    expect(code).toBe(0);
    const out = fx.stdout();
    expect(out).toContain("~/.tropos/credentials.json");
    expect(out).toContain("Docker sandbox");
    expect(out).not.toContain(GOOD_KEY);
    expect(questions.some((q) => q.includes("API key"))).toBe(true);
    expect(JSON.parse(await read("credentials.json")).deepseek.apiKey).toBe(GOOD_KEY);
    expect(JSON.parse(await read("settings.json")).model).toBe("deepseek/deepseek-chat");
    expect(service.installed).toHaveLength(1);
    expect(opened).toEqual([`http://127.0.0.1:4321/?token=${"t".repeat(40)}`]);
    expect(JSON.parse(await read("onboarding.json")).skipped).toEqual(["telegram", "sandbox"]);
    expect(fx.asked[0]).toContain("understand");
  });

  test("declining the notice stops without changing anything", async () => {
    fx = await makeFixture({ interactive: true, answers: [false] });
    const { ctx } = terminal([]);
    expect(await runOnboard([], ctx, { engine: engine() })).toBe(1);
    expect(await exists(join(fx.ctx.home, "credentials.json"))).toBe(false);
  });

  test("--accept-risk skips the question; a wrong key is retried, then it gives up with exit 1", async () => {
    fx = await makeFixture({ interactive: true });
    const { ctx } = terminal(["deepseek", "sk-bad-1", "sk-bad-2", "sk-bad-3"]);
    expect(await runOnboard(["--accept-risk"], ctx, { engine: engine() })).toBe(1);
    expect(fx.asked).toEqual([]);
    expect(fx.stderr()).not.toContain("sk-bad");
    expect(await exists(join(fx.ctx.home, "credentials.json"))).toBe(false);
  });

  test("on --reset a key already in the environment is offered first and is not copied to credentials.json", async () => {
    fx = await makeFixture({ interactive: true, env: { DEEPSEEK_API_KEY: GOOD_KEY }, answers: [true /*risk*/, true /*use env*/, false /*telegram*/, false /*service*/] });
    const { ctx } = terminal(["1"]);
    expect(await runOnboard(["--reset", "--no-open"], ctx, { engine: engine(), alive: () => false })).toBe(0);
    expect(fx.asked[1]).toContain("$DEEPSEEK_API_KEY");
    expect(await exists(join(fx.ctx.home, "credentials.json"))).toBe(false);
    expect(JSON.parse(await read("settings.json")).model).toBe("deepseek/deepseek-chat");
    expect(fx.stdout()).toContain("tcode gateway");
  });

  test("--quick asks nothing but the key, skips Telegram, installs the service and opens the dashboard", async () => {
    fx = await makeFixture({ interactive: true });
    await gatewayUp();
    const { ctx } = terminal(["deepseek", GOOD_KEY]);
    const opened: string[] = [];
    const service = fakeService();
    expect(await runOnboard(["--quick", "--accept-risk"], ctx, { engine: engine({ service }), alive: () => true, sleep: async () => {}, openBrowser: (u) => void opened.push(u) })).toBe(0);
    expect(fx.asked).toEqual([]);
    expect(service.installed).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(JSON.parse(await read("onboarding.json")).skipped).toContain("telegram");
  });

  test("--no-open never opens the browser", async () => {
    fx = await makeFixture({ interactive: true, env: { ANTHROPIC_API_KEY: "x" }, answers: [false, false] });
    await gatewayUp();
    const { ctx } = terminal([]);
    const opened: string[] = [];
    expect(await runOnboard(["--accept-risk", "--no-open"], ctx, { engine: engine({ anthropicModels: async () => ["claude-opus-5-5"] }), alive: () => true, openBrowser: (u) => void opened.push(u) })).toBe(0);
    expect(opened).toEqual([]);
    expect(fx.stdout()).toContain("tcode dashboard");
  });

  test("telegram: a token is verified with getMe and saved; bad tokens are not echoed", async () => {
    fx = await makeFixture({ interactive: true, env: { ANTHROPIC_API_KEY: "x" }, answers: [true /*telegram*/, false /*service*/] });
    const { ctx } = terminal(["9:bad", "123:good"]);
    expect(await runOnboard(["--accept-risk", "--no-open"], ctx, { engine: engine({ anthropicModels: async () => ["claude-opus-5-5"] }), alive: () => false })).toBe(0);
    expect(JSON.parse(await read("gateway.json")).telegram.botToken).toBe("123:good");
    expect(fx.stdout()).toContain("@tropos_bot");
    expect(fx.stderr()).not.toContain("9:bad");
  });

  test("sandbox: offers to pull a missing image", async () => {
    fx = await makeFixture({ interactive: true, env: { ANTHROPIC_API_KEY: "x" }, answers: [false /*telegram*/, true /*pull*/, false /*service*/] });
    const docker = fakeDocker({ image: false });
    const { ctx } = terminal([]);
    expect(await runOnboard(["--accept-risk", "--no-open"], ctx, { engine: engine({ runner: fakeRunner({ exec: docker.exec }), anthropicModels: async () => [] }), alive: () => false })).toBe(0);
    expect(docker.hasImage).toBe(true);
  });

  test("a finished setup is not asked again, but --reset asks every step", async () => {
    fx = await makeFixture({ interactive: true, env: { ANTHROPIC_API_KEY: "x" }, answers: [false, false] });
    const { ctx, questions } = terminal([]);
    const eng = engine({ anthropicModels: async () => ["claude-opus-5-5"] });
    expect(await runOnboard(["--accept-risk", "--no-open"], ctx, { engine: eng, alive: () => false })).toBe(0);
    expect(questions).toEqual([]);
    fx = await makeFixture({ interactive: true, env: { ANTHROPIC_API_KEY: "x" }, answers: [false, false] });
    const again = terminal([]);
    expect(await runOnboard(["--accept-risk", "--no-open", "--reset"], again.ctx, { engine: eng, alive: () => false })).toBe(0);
    expect(again.questions.some((q) => q.startsWith("Model"))).toBe(true);
  });
});
