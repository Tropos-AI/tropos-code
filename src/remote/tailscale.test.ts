import { expect, test } from "bun:test";
import type { RunResult } from "../doctor/types";
import { SERVE_PORTS, TailscaleError, disableServe, enableServe, serveFunnelled, tailscaleStatus, type TailscaleRunner } from "./tailscale";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

/** A runner keyed by the argv after `tailscale`; unknown commands fail. Every call is recorded. */
function fake(answers: Record<string, RunResult>) {
  const calls: Array<[string, string[]]> = [];
  const runner: TailscaleRunner = {
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      return answers[args.join(" ")] ?? fail("unexpected command");
    },
  };
  return { runner, calls };
}

const running = ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail1234.ts.net." } }));
const NAME = "mac.tail1234.ts.net";
const proxy = (port: number, to: string) => ({ Web: { [`${NAME}:${port}`]: { Handlers: { "/": { Proxy: to } } } } });

test("status: running with a DNS name (trailing dot trimmed)", async () => {
  expect(await tailscaleStatus(fake({ "status --json": running }).runner)).toEqual({ installed: true, running: true, dnsName: NAME });
});

test("status: daemon not reachable or logged out = installed, not running", async () => {
  expect(await tailscaleStatus(fake({ "status --json": fail("failed to connect to local tailscaled") }).runner)).toEqual({ installed: true, running: false });
  const stopped = ok(JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "mac.tail1234.ts.net." } }));
  expect(await tailscaleStatus(fake({ "status --json": stopped }).runner)).toEqual({ installed: true, running: false });
});

test("status: running but no DNS name counts as not running", async () => {
  expect((await tailscaleStatus(fake({ "status --json": ok(JSON.stringify({ BackendState: "Running", Self: {} })) }).runner)).running).toBe(false);
});

test("a wrapper whose app is gone counts as not installed", async () => {
  const r: TailscaleRunner = {
    exec: async () => fail("/usr/local/bin/tailscale: line 2: /Applications/Tailscale.app/Contents/MacOS/Tailscale: No such file or directory", 127),
  };
  expect((await tailscaleStatus(r)).installed).toBe(false);
});

test("a missing binary (spawn error) is not installed", async () => {
  const r: TailscaleRunner = { exec: async () => ({ code: null, stdout: "", stderr: "", error: "tailscale: not found" }) };
  expect(await tailscaleStatus(r)).toEqual({ installed: false, running: false });
});

test("enable: 443 free → `serve --bg --https=443 http://127.0.0.1:4317`", async () => {
  const { runner, calls } = fake({ "status --json": running, "serve status --json": ok("{}"), "serve --bg --https=443 http://127.0.0.1:4317": ok() });
  const res = await enableServe(runner, 4317);
  expect(calls).toContainEqual(["tailscale", ["serve", "--bg", "--https=443", "http://127.0.0.1:4317"]]);
  expect(res).toEqual({ url: `https://${NAME}/`, httpsPort: 443 });
});

test("enable: 443 serves something else → 8443, and the existing config is never touched", async () => {
  const { runner, calls } = fake({
    "status --json": running,
    "serve status --json": ok(JSON.stringify(proxy(443, "http://127.0.0.1:3000"))),
    "serve --bg --https=8443 http://127.0.0.1:4317": ok(),
  });
  expect(await enableServe(runner, 4317)).toEqual({ url: `https://${NAME}:8443/`, httpsPort: 8443 });
  expect(calls.some(([, a]) => a.includes("--https=443"))).toBe(false);
});

test("enable: a port held by a raw TCP forward is taken too", async () => {
  const { runner } = fake({
    "status --json": running,
    "serve status --json": ok(JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } })),
    "serve --bg --https=8443 http://127.0.0.1:4317": ok(),
  });
  expect((await enableServe(runner, 4317)).httpsPort).toBe(8443);
});

test("enable: already serving our port → reused, nothing run", async () => {
  const { runner, calls } = fake({ "status --json": running, "serve status --json": ok(JSON.stringify(proxy(8443, "http://localhost:4317"))) });
  expect(await enableServe(runner, 4317)).toEqual({ url: `https://${NAME}:8443/`, httpsPort: 8443 });
  expect(calls.some(([, a]) => a[0] === "serve" && a.includes("--bg"))).toBe(false);
});

test("enable: every serve port taken → a TailscaleError naming them", async () => {
  const taken = { Web: Object.fromEntries(SERVE_PORTS.map((p) => [`${NAME}:${p}`, { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } }])) };
  const { runner } = fake({ "status --json": running, "serve status --json": ok(JSON.stringify(taken)) });
  await expect(enableServe(runner, 4317)).rejects.toThrow(/Ports 443, 8443 and 10000/);
});

test("enable: Tailscale not running → a TailscaleError with the next step", async () => {
  const { runner } = fake({ "status --json": fail("failed to connect") });
  const err = await enableServe(runner, 4317).catch((e) => e);
  expect(err).toBeInstanceOf(TailscaleError);
  expect(err.message).toMatch(/Tailscale/);
});

test("enable: HTTPS not enabled on the tailnet → TailscaleError carrying Tailscale's own message and URL", async () => {
  const msg = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\t https://login.tailscale.com/f/serve?node=abc";
  const { runner } = fake({ "status --json": running, "serve status --json": ok("{}"), "serve --bg --https=443 http://127.0.0.1:4317": fail(msg + "\n") });
  const err = await enableServe(runner, 4317).catch((e) => e);
  expect(err).toBeInstanceOf(TailscaleError);
  expect(err.message).toBe(msg);
});

test("enable never runs funnel", async () => {
  const all: Array<[string, string[]]> = [];
  for (const serveStatus of [ok("{}"), ok(JSON.stringify(proxy(443, "http://127.0.0.1:3000"))), ok(JSON.stringify(proxy(443, "http://127.0.0.1:4317")))]) {
    const { runner, calls } = fake({ "status --json": running, "serve status --json": serveStatus, "serve --bg --https=443 http://127.0.0.1:4317": ok(), "serve --bg --https=8443 http://127.0.0.1:4317": ok() });
    await enableServe(runner, 4317);
    await disableServe(runner, 443).catch(() => {});
    all.push(...calls);
  }
  expect(all.some(([c, a]) => c.includes("funnel") || a.includes("funnel"))).toBe(false);
});

test("disable: `serve --https=8443 off`", async () => {
  const { runner, calls } = fake({ "serve --https=8443 off": ok() });
  await disableServe(runner, 8443);
  expect(calls).toEqual([["tailscale", ["serve", "--https=8443", "off"]]]);
});

test("disable: a failure is a TailscaleError", async () => {
  await expect(disableServe(fake({ "serve --https=443 off": fail("boom\n") }).runner, 443)).rejects.toThrow("boom");
});

test("enable: a port that is open to the internet (Funnel) is neither ours nor free", async () => {
  const funnelled = { ...proxy(443, "http://127.0.0.1:4317"), AllowFunnel: { [`${NAME}:443`]: true } };
  const { runner, calls } = fake({ "status --json": running, "serve status --json": ok(JSON.stringify(funnelled)) });
  const err = await enableServe(runner, 4317).catch((e) => e);
  expect(err).toBeInstanceOf(TailscaleError);
  expect(err.message).toMatch(/Funnel/);
  expect(err.message).toMatch(/443/);
  expect(calls.some(([, a]) => a.includes("--bg"))).toBe(false);
});

test("enable: a funnelled port that holds something else is skipped like any taken port", async () => {
  const cfg = { ...proxy(443, "http://127.0.0.1:3000"), AllowFunnel: { [`${NAME}:443`]: true } };
  const { runner } = fake({ "status --json": running, "serve status --json": ok(JSON.stringify(cfg)), "serve --bg --https=8443 http://127.0.0.1:4317": ok() });
  expect((await enableServe(runner, 4317)).httpsPort).toBe(8443);
});

test("enable: serve status that can't be read or parsed fails closed", async () => {
  for (const status of [fail("daemon busy"), ok("not json{")]) {
    const { runner, calls } = fake({ "status --json": running, "serve status --json": status });
    const err = await enableServe(runner, 4317).catch((e) => e);
    expect(err).toBeInstanceOf(TailscaleError);
    expect(err.message).toMatch(/couldn't read the current serve config/);
    expect(calls.some(([, a]) => a.includes("--bg"))).toBe(false);
  }
});

test("serveFunnelled: reports whether a port is open to the internet", async () => {
  const cfg = { AllowFunnel: { [`${NAME}:8443`]: true } };
  const { runner } = fake({ "status --json": running, "serve status --json": ok(JSON.stringify(cfg)) });
  expect(await serveFunnelled(runner, 8443)).toBe(true);
  expect(await serveFunnelled(runner, 443)).toBe(false);
});
