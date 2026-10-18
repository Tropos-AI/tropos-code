import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceManager, ServiceStatus } from "../../service/types";
import { runDashboard, waitForDashboard } from "./dashboard";
import { makeFixture, type Fixture } from "./lifecycle-fixture";

let fx: Fixture;
afterEach(() => fx?.cleanup());

async function running(webPort = 4321, token = "t".repeat(40)) {
  await mkdir(join(fx.ctx.home, "gateway"), { recursive: true });
  await writeFile(join(fx.ctx.home, "gateway", "state.json"), JSON.stringify({ pid: 4242, webPort }));
  if (token) await writeFile(join(fx.ctx.home, "gateway", "token"), `${token}\n`);
}
const alive = (pid: number) => pid === 4242;

test("opens the link with the persistent token and prints it without the token", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard([], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(opened).toEqual([`http://127.0.0.1:4321/?token=${"t".repeat(40)}`]);
  expect(fx.stdout()).toContain("http://127.0.0.1:4321/");
  expect(fx.stdout()).not.toContain("t".repeat(40));
});

test("--print-url prints the link and warns that it is a secret, without opening", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard(["--print-url"], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(fx.stdout()).toBe(`http://127.0.0.1:4321/?token=${"t".repeat(40)}\n`);
  expect(fx.stderr()).toContain("secret");
  expect(opened).toEqual([]);
});

test("--no-open opens nothing and does not print the key", async () => {
  fx = await makeFixture();
  await running();
  const opened: string[] = [];
  expect(await runDashboard(["--no-open"], fx.ctx, { alive, openBrowser: (u) => void opened.push(u) })).toBe(0);
  expect(opened).toEqual([]);
  expect(fx.stdout()).not.toContain("t".repeat(40));
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
    await writeFile(join(fx.ctx.home, "gateway", "token"), `${"t".repeat(40)}\n`);
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
  expect(opened[0]).toContain("http://127.0.0.1:4317/");
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
  await running();
  expect(await waitForDashboard(fx.ctx.home, { alive, sleep: noSleep, waitMs: 500 })).toMatchObject({ pid: 4242, webPort: 4321 });
  expect(await waitForDashboard(fx.ctx.home, { alive: () => false, sleep: noSleep, waitMs: 500 })).toBeNull();
});

test("a gateway without a token file is reported instead of opening a link that cannot sign in", async () => {
  fx = await makeFixture();
  await running(4321, "");
  expect(await runDashboard([], fx.ctx, { alive, openBrowser: () => { throw new Error("no"); } })).toBe(1);
  expect(await runDashboard(["--print-url"], fx.ctx, { alive })).toBe(1);
});

test("usage errors are 64", async () => {
  fx = await makeFixture();
  expect(await runDashboard(["--bogus"], fx.ctx)).toBe(64);
  expect(await runDashboard(["x"], fx.ctx)).toBe(64);
  expect(await runDashboard(["--help"], fx.ctx)).toBe(0);
});
