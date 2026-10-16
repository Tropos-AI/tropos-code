import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerCheck } from "../../doctor/checks/docker";
import { writeOnboardingFlags } from "../../onboard/flags";
import { FilePairing } from "../../gateway/pairing";
import { fail, fakeService, makeKit, ok, adminWith, type Kit } from "./host-testkit";
import { statusHandlers } from "./status";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
  // No keys from the developer's own environment leak into the provider check.
  kit.ctx.env = { HOME: kit.userHome, TROPOS_HOME: kit.home, PATH: "" };
});
afterEach(() => kit.close());

const get = async (deps: Parameters<typeof statusHandlers>[1] = {}) =>
  (await adminWith(kit, statusHandlers(kit.ctx, { service: fakeService({ installed: true, running: true, pid: 77 }), checks: [dockerCheck], runner: { exec: async () => ok("27.0") }, ...deps })).handle("status.get", undefined)) as any;

test("an empty install needs onboarding and reports nothing connected", async () => {
  const s = await get({ service: fakeService({ manager: "none" }) });
  expect(s.version).toBe("1.2.3");
  expect(s.channel).toBe("latest");
  expect(s.updateAvailable).toBeUndefined();
  expect(s.service).toEqual({ manager: "none", installed: false, running: false });
  expect(s.gateway).toEqual({ running: false, telegram: false });
  expect(s.providers.length).toBeGreaterThan(0);
  expect(s.providers.every((p: any) => p.connected === false)).toBe(true);
  expect(s.projects).toEqual({ count: 1, defaultId: "default" });
  expect(s.pairedSenders).toBe(0);
  expect(s.cronJobs).toBe(0);
  expect(s.needsOnboarding).toBe(true);
  expect(s.docker.ok).toBe(true);
});

test("aggregates service, gateway process, telegram, provider, projects, pairing, cron and health", async () => {
  await mkdir(join(kit.home, "gateway", "cron"), { recursive: true });
  await writeFile(join(kit.home, "gateway", "state.json"), JSON.stringify({ pid: 4242, startedAt: "2026-10-15T00:00:00.000Z", webPort: 7788 }));
  await writeFile(join(kit.home, "gateway", "cron", "jobs.json"), JSON.stringify([{ id: "a" }, { id: "b" }]));
  await writeFile(join(kit.home, "gateway.json"), JSON.stringify({ telegram: { botToken: "1:abc" }, projects: [{ id: "app", name: "App", path: kit.userHome }], defaultProject: "app" }));
  await writeFile(join(kit.home, "settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
  const pairing = new FilePairing({ path: join(kit.home, "gateway", "pairing.json") });
  const c = await pairing.challenge("telegram", "u1");
  if (c.kind === "code") await pairing.approve("telegram", c.code);
  kit.ctx.env = { ...kit.ctx.env, ANTHROPIC_API_KEY: "sk-ant-test-0000" };
  const s = await get({ pidAlive: (pid) => pid === 4242, runner: { exec: async () => fail("daemon down"), pidAlive: (pid) => pid === 4242 } });
  expect(s.channel).toBe("stable");
  expect(s.service).toEqual({ manager: "launchd", installed: true, running: true, pid: 77 });
  expect(s.gateway).toEqual({ running: true, pid: 4242, startedAt: "2026-10-15T00:00:00.000Z", webPort: 7788, telegram: true });
  expect(s.providers.find((p: any) => p.id === "anthropic").connected).toBe(true);
  expect(JSON.stringify(s)).not.toContain("sk-ant-test");
  expect(JSON.stringify(s)).not.toContain("1:abc");
  expect(s.projects).toEqual({ count: 2, defaultId: "app" });
  expect(s.pairedSenders).toBe(1);
  expect(s.cronJobs).toBe(2);
  expect(s.docker.ok).toBe(false);
  expect(s.docker.problem).toContain("Docker");
  expect(s.health.warn).toBeGreaterThan(0);
  expect(s.needsOnboarding).toBe(false);
});

test("a stale pid is not running and dismissing onboarding clears needsOnboarding", async () => {
  await mkdir(join(kit.home, "gateway"), { recursive: true });
  await writeFile(join(kit.home, "gateway", "state.json"), JSON.stringify({ pid: 4242, startedAt: "x" }));
  await writeOnboardingFlags(kit.home, { dismissedAt: "2026-10-01T00:00:00.000Z" });
  const s = await get({ pidAlive: () => false, runner: { exec: async () => ok("27"), pidAlive: () => false } });
  expect(s.gateway.running).toBe(false);
  expect(s.needsOnboarding).toBe(false);
});

test("a newer version already installed on disk is reported as the update available", async () => {
  await mkdir(join(kit.userHome, ".local", "share", "tropos", "versions", "1.3.0"), { recursive: true });
  const s = await get();
  expect(s.updateAvailable).toBe("1.3.0");
});
