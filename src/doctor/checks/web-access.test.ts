import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { byId, fakeRunner, makeFixture, runOne, type Fixture } from "../testing";
import { loadGatewayConfig } from "../../gateway/config";
import { webAccessCheck } from "./web-access";

let fx: Fixture;
afterEach(() => fx?.close());
const alive = fakeRunner({ pidAlive: (p) => p === 4242 });

test("running with a port: ok", async () => {
  fx = await makeFixture();
  await fx.write("gateway/state.json", JSON.stringify({ pid: 4242, webPort: 4317 }));
  const r = await runOne(fx, webAccessCheck, { runner: alive });
  expect(r.findings[0]).toMatchObject({ id: "gateway.web", level: "ok", message: expect.stringContaining("4317") });
});

test("state.json carries webProblem: warn with that text", async () => {
  fx = await makeFixture();
  await fx.write("gateway/state.json", JSON.stringify({ pid: 4242, webProblem: "Port 4317 is in use by node (pid 9)." }));
  const r = await runOne(fx, webAccessCheck, { runner: alive });
  expect(r.findings[0]).toMatchObject({ level: "warn", message: expect.stringContaining("Port 4317 is in use by node (pid 9).") });
});

test("not running and the configured port is held by someone: warn naming the holder", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", JSON.stringify({ webPort: 4555 }));
  const runner = fakeRunner({ exec: async (cmd) => (cmd === "lsof" ? { code: 0, stdout: "p812\ncpython3\n", stderr: "" } : { code: null, stdout: "", stderr: "", error: "x" }) });
  const r = await runOne(fx, webAccessCheck, { runner });
  expect(r.findings[0]!.level).toBe("warn");
  expect(r.findings[0]!.message).toContain("python3 (pid 812)");
  expect(r.findings[0]!.message).toContain("4555");
  
});

test("not running and the port is free: ok", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, webAccessCheck);
  expect(r.findings[0]).toMatchObject({ level: "ok" });
});

test("an old gateway/token file: warn, safe fix deletes it", async () => {
  fx = await makeFixture();
  await fx.write("gateway/token", "a".repeat(43));
  await fx.write("gateway/devices.json", "{}");
  const seen = await runOne(fx, webAccessCheck);
  expect(byId(seen, "gateway.web.oldToken")).toMatchObject({ level: "warn", fixable: true, safe: true });
  expect(JSON.stringify(seen)).not.toContain("a".repeat(43));
  const r = await runOne(fx, webAccessCheck, { fix: "safe" });
  expect(byId(r, "gateway.web.oldToken")).toMatchObject({ fixed: true });
  expect(existsSync(join(fx.home, "gateway", "token"))).toBe(false);
  // Only that file.
  expect(existsSync(join(fx.home, "gateway", "devices.json"))).toBe(true);
});

test("no old token file: no finding about it", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, webAccessCheck);
  expect(byId(r, "gateway.web.oldToken")).toBeUndefined();
});

const phoneOn = JSON.stringify({ remoteAccess: { tailscale: true, httpsPort: 443, hostname: "mac.tail1234.ts.net" } });
const tsExec = (stdout: string, code = 0) => fakeRunner({ pidAlive: () => false, exec: async (cmd) => (cmd === "tailscale" ? { code, stdout, stderr: "" } : { code: 1, stdout: "", stderr: "" }) });

test("phone access on but Tailscale not running: warn", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", phoneOn);
  const r = await runOne(fx, webAccessCheck, { runner: tsExec("", 1) });
  expect(byId(r, "gateway.web.remote")).toMatchObject({ level: "warn", message: expect.stringContaining("Phone access is on but Tailscale isn't running") });
});

test("phone access on and Tailscale running: ok with the address", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", phoneOn);
  const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail1234.ts.net." } });
  const r = await runOne(fx, webAccessCheck, { runner: tsExec(running) });
  expect(byId(r, "gateway.web.remote")).toMatchObject({ level: "ok", message: expect.stringContaining("https://mac.tail1234.ts.net/") });
});

test("phone access off: no phone finding, and Tailscale is never asked", async () => {
  fx = await makeFixture();
  const asked: string[] = [];
  const runner = fakeRunner({ exec: async (cmd) => { asked.push(cmd); return { code: 1, stdout: "", stderr: "" }; } });
  const r = await runOne(fx, webAccessCheck, { runner });
  expect(byId(r, "gateway.web.remote")).toBeUndefined();
  expect(asked).not.toContain("tailscale");
});

const NAME = "mac.tail1234.ts.net";
const tsStatus = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NAME}.` } });
const tsRunner = (answers: Record<string, { code: number; stdout: string; stderr: string }>) =>
  fakeRunner({ exec: async (_c, args) => answers[args.join(" ")] ?? { code: 1, stdout: "", stderr: "unexpected" } });
const remoteCfg = (extra: object = {}) => JSON.stringify({ remoteAccess: { tailscale: true, httpsPort: 443, hostname: NAME, ...extra } });

test("phone access on and the port is open to the internet (Funnel): warn", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", remoteCfg());
  const runner = tsRunner({
    "status --json": { code: 0, stdout: tsStatus, stderr: "" },
    "serve status --json": { code: 0, stdout: JSON.stringify({ AllowFunnel: { [`${NAME}:443`]: true } }), stderr: "" },
  });
  const r = await runOne(fx, webAccessCheck, { runner });
  expect(byId(r, "gateway.web.remote")).toMatchObject({ level: "warn", message: expect.stringContaining("Funnel") });
});

test("a pending disable is a fixable warning; the fix retries `serve off` and clears it", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", remoteCfg({ pendingDisable: true }));
  const calls: string[] = [];
  const runner = tsRunner({});
  const exec = runner.exec;
  runner.exec = async (c, a, t) => {
    calls.push(a.join(" "));
    return a.join(" ") === "serve --https=443 off" ? { code: 0, stdout: "", stderr: "" } : exec(c, a, t);
  };
  const seen = await runOne(fx, webAccessCheck, { runner });
  expect(byId(seen, "gateway.web.remote.pending")).toMatchObject({ level: "warn", fixable: true });
  const fixed = await runOne(fx, webAccessCheck, { runner, fix: true });
  expect(byId(fixed, "gateway.web.remote.pending")).toMatchObject({ fixed: true });
  expect(calls).toContain("serve --https=443 off");
  expect((await loadGatewayConfig(fx.home)).remoteAccess).toEqual({ tailscale: false });
});
