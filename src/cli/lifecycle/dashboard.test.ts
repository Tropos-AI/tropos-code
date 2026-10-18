import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceManager, ServiceStatus } from "../../service/types";
import { loginCodesFor } from "../../web/login-codes";
import { runDashboard, waitForDashboard } from "./dashboard";
import { makeFixture, type Fixture } from "./lifecycle-fixture";

let fx: Fixture;
afterEach(() => fx?.cleanup());

async function running(webPort = 4317) {
  await mkdir(join(fx.ctx.home, "gateway"), { recursive: true });
  await writeFile(join(fx.ctx.home, "gateway", "state.json"), JSON.stringify({ pid: 4242, webPort }));
}
const alive = (pid: number) => pid === 4242;

test("opens localhost with a one-time #login key and prints the link without it", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard([], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^http:\/\/localhost:4317\/#login=[A-Za-z0-9_-]{43}$/);
  expect(fx.stdout()).toContain("Opening the dashboard at http://localhost:4317/");
  expect(fx.stdout() + fx.stderr()).not.toContain("#login");
  // The gateway redeems it from the same file, once.
  const key = opened[0]!.split("#login=")[1]!;
  expect(await loginCodesFor(fx.ctx.home).redeem(key)).toBe(true);
  expect(await loginCodesFor(fx.ctx.home).redeem(key)).toBe(false);
});

test("--code prints a 6-digit code valid 10 minutes and opens nothing", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard(["--code"], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  const m = fx.stdout().match(/Code: (\d{3}) (\d{3})/);
  expect(m).not.toBeNull();
  expect(fx.stdout()).toContain("works once, for 10 minutes");
  expect(fx.stdout()).toContain("http://localhost:4317/");
  expect(opened).toEqual([]);
  expect(await loginCodesFor(fx.ctx.home).redeem(`${m![1]}${m![2]}`)).toBe(true);
});

test("--print-url prints the one-time link and warns on stderr that it works once for 2 minutes", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard(["--print-url"], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(fx.stdout()).toMatch(/^http:\/\/localhost:4317\/#login=[A-Za-z0-9_-]{43}\n$/);
  expect(fx.stderr()).toContain("works once");
  expect(fx.stderr()).toContain("2 minutes");
  expect(opened).toEqual([]);
  expect(await loginCodesFor(fx.ctx.home).redeem(fx.stdout().trim().split("#login=")[1]!)).toBe(true);
});

test("--no-open prints the plain URL and how to log in elsewhere; no key is issued", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard(["--no-open"], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(opened).toEqual([]);
  expect(fx.stdout()).toContain("http://localhost:4317/");
  expect(fx.stdout()).toContain("tcode dashboard --code");
  expect(fx.stdout()).not.toContain("#login");
  expect(existsSync(join(fx.ctx.home, "gateway", "login-codes.json"))).toBe(false);
});

test("the help says the link logs this browser in once", async () => {
  fx = await makeFixture();
  expect(await runDashboard(["--help"], fx.ctx)).toBe(0);
  expect(fx.stdout()).toContain("--code");
  expect(fx.stdout()).toMatch(/logs this browser in once/);
  expect(fx.stdout()).not.toContain("secret key");
});

const noSleep = async () => {};

/** A service manager that fakes the unit: starting (or installing) it brings the gateway up the way the real daemon would. */
function fakeService(initial: Partial<ServiceStatus> & { manager?: ServiceStatus["manager"] }, comesUp: "port" | "problem" | "never" = "port") {
  const calls = { starts: 0, installs: 0 };
  let status: ServiceStatus = { manager: "launchd", installed: false, running: false, ...initial };
  const up = async () => {
    status = { ...status, installed: true, running: true };
    if (comesUp === "never") return;
    await mkdir(join(fx.ctx.home, "gateway"), { recursive: true });
    const state = comesUp === "port" ? { pid: 4242, webPort: 4317 } : { pid: 4242, webProblem: "Port 4317 is in use by node (pid 9). Stop it." };
    await writeFile(join(fx.ctx.home, "gateway", "state.json"), JSON.stringify(state));
  };
  const service: ServiceManager = {
    get manager() {
      return status.manager;
    },
    install: async () => (calls.installs++, await up(), { unitPath: "/u/x" }),
    uninstall: async () => ({ removed: false }),
    start: async () => (calls.starts++, await up()),
    stop: async () => {},
    restart: async () => {},
    status: async () => status,
  };
  return { service, calls };
}
const deps = (service: ServiceManager, opened: string[] = []) => ({ alive, service, sleep: noSleep, waitMs: 1_000, git: async () => {}, openBrowser: (u: string) => void opened.push(u) });

test("service installed but stopped: starts it, waits for the port, then opens", async () => {
  fx = await makeFixture();
  const { service, calls } = fakeService({ installed: true, running: false });
  const opened: string[] = [];
  expect(await runDashboard([], fx.ctx, deps(service, opened))).toBe(0);
  expect(calls.starts).toBe(1);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toStartWith("http://localhost:4317/#login=");
});

test("service not installed: asks (default yes), installs, opens", async () => {
  fx = await makeFixture({ interactive: true, answers: [true] });
  const { service, calls } = fakeService({});
  const opened: string[] = [];
  expect(await runDashboard([], fx.ctx, deps(service, opened))).toBe(0);
  expect(calls.installs).toBe(1);
  expect(fx.asked[0]).toContain("background service");
  expect(opened).toHaveLength(1);
});

test("not installed and the owner says no: nothing installed, exit 1", async () => {
  fx = await makeFixture({ interactive: true, answers: [false] });
  const { service, calls } = fakeService({});
  expect(await runDashboard([], fx.ctx, deps(service))).toBe(1);
  expect(calls.installs).toBe(0);
});

test("not installed and no terminal: says how, exit 1, nothing installed", async () => {
  fx = await makeFixture();
  const { service, calls } = fakeService({});
  expect(await runDashboard([], fx.ctx, deps(service))).toBe(1);
  expect(calls.installs).toBe(0);
  expect(fx.stdout() + fx.stderr()).toContain("tcode gateway install");
});

test("no service manager on this system: points at `tcode gateway` and exits 1", async () => {
  fx = await makeFixture({ interactive: true });
  const { service, calls } = fakeService({ manager: "none" });
  expect(await runDashboard([], fx.ctx, deps(service))).toBe(1);
  expect(fx.stdout() + fx.stderr()).toContain("`tcode gateway` in another terminal");
  expect(calls.installs + calls.starts).toBe(0);
});

test("the service did not come up in time: says where the log is, exit 1", async () => {
  fx = await makeFixture();
  const { service } = fakeService({ installed: true }, "never");
  expect(await runDashboard([], fx.ctx, { ...deps(service), waitMs: 10 })).toBe(1);
  expect(fx.stderr()).toContain("tcode logs gateway");
});

test("the dashboard could not take its port: prints why and exits 1", async () => {
  fx = await makeFixture();
  const { service } = fakeService({ installed: true }, "problem");
  expect(await runDashboard([], fx.ctx, deps(service))).toBe(1);
  expect(fx.stderr()).toContain("Port 4317 is in use by node (pid 9)");
});

test("waitForDashboard gives up after waitMs and returns the state once it has a port", async () => {
  fx = await makeFixture();
  expect(await waitForDashboard(fx.ctx.home, { alive, sleep: noSleep, waitMs: 500 })).toBeNull();
  await running(4321);
  expect(await waitForDashboard(fx.ctx.home, { alive, sleep: noSleep, waitMs: 500 })).toMatchObject({ pid: 4242, webPort: 4321 });
  expect(await waitForDashboard(fx.ctx.home, { alive: () => false, sleep: noSleep, waitMs: 500 })).toBeNull();
});

test("usage errors are 64", async () => {
  fx = await makeFixture();
  expect(await runDashboard(["--bogus"], fx.ctx)).toBe(64);
  expect(await runDashboard(["x"], fx.ctx)).toBe(64);
  expect(await runDashboard(["--help"], fx.ctx)).toBe(0);
});
