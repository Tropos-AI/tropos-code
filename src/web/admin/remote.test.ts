import { afterEach, expect, test } from "bun:test";
import type { RunResult } from "../../doctor/types";
import { loadGatewayConfig, saveGatewayConfig } from "../../gateway/config";
import type { TailscaleRunner } from "../../remote/tailscale";
import { DeviceStore, devicesPath } from "../devices";
import type { RemoteView } from "./api";
import { AdminError } from "./context";
import { createAdmin } from "./index";
import { remoteHandlers } from "./remote";
import { makeKit, type Kit } from "./ops-testkit";

let kit: Kit | undefined;
afterEach(async () => {
  await kit?.cleanup();
  kit = undefined;
});

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const NAME = "mac.tail1234.ts.net";
const running = ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NAME}.` } }));

async function setup(answers: Record<string, RunResult>) {
  const calls: string[][] = [];
  const runner: TailscaleRunner = {
    exec: async (_cmd, args) => {
      calls.push(args);
      return answers[args.join(" ")] ?? { code: 1, stdout: "", stderr: "unexpected command" };
    },
  };
  let reloads = 0;
  let changed = 0;
  kit = await makeKit();
  const ctx = { ...kit.ctx, gateway: { runCronNow: async () => {}, reload: async () => void reloads++, devicesChanged: async () => void changed++ } };
  const admin = createAdmin(ctx, remoteHandlers(ctx, { runner }));
  const devices = new DeviceStore({ path: devicesPath(kit.home), now: kit.ctx.now });
  return { admin, devices, home: kit.home, calls, reloads: () => reloads, changed: () => changed };
}

test("enable saves remoteAccess and reloads; disable turns serve off, clears it and logs out tailscale-only devices", async () => {
  const t = await setup({ "status --json": running, "serve status --json": ok("{}"), "serve --bg --https=443 http://127.0.0.1:4317": ok(), "serve --https=443 off": ok() });
  const mac = await t.devices.create("Mac");
  const phone = await t.devices.create("Phone", "tailscale");
  const ipad = await t.devices.create("iPad", "tailscale");
  await t.devices.verify(ipad.key, "local"); // seen on the Mac too: it stays

  const on = (await t.admin.handle("remote.enable", undefined)) as RemoteView;
  expect(on).toMatchObject({ enabled: true, url: `https://${NAME}/` });
  expect(on.note).toBeUndefined();
  expect((await loadGatewayConfig(t.home)).remoteAccess).toEqual({ tailscale: true, httpsPort: 443, hostname: NAME });
  expect(t.reloads()).toBe(1);

  const off = (await t.admin.handle("remote.disable", undefined)) as RemoteView;
  expect(off).toMatchObject({ enabled: false });
  expect(off.url).toBeUndefined();
  expect(t.calls).toContainEqual(["serve", "--https=443", "off"]);
  expect((await loadGatewayConfig(t.home)).remoteAccess).toEqual({ tailscale: false });
  expect((await t.devices.list()).map((d) => d.id).sort()).toEqual([mac.id, ipad.id].sort());
  expect(await t.devices.verify(phone.key)).toBeNull();
  expect(t.changed()).toBe(1);
  expect(t.reloads()).toBe(2);
});

test("enable on a busy 443 says which port the dashboard is on", async () => {
  const busy = ok(JSON.stringify({ Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }));
  const t = await setup({ "status --json": running, "serve status --json": busy, "serve --bg --https=8443 http://127.0.0.1:4317": ok() });
  const view = (await t.admin.handle("remote.enable", undefined)) as RemoteView;
  expect(view.url).toBe(`https://${NAME}:8443/`);
  expect(view.note).toBe("443 was already in use on your tailnet name, so the dashboard is on 8443.");
});

test("enable uses the configured dashboard port", async () => {
  const t = await setup({ "status --json": running, "serve status --json": ok("{}"), "serve --bg --https=443 http://127.0.0.1:4555": ok() });
  await saveGatewayConfig(t.home, { ...(await loadGatewayConfig(t.home)), webPort: 4555 });
  expect(((await t.admin.handle("remote.enable", undefined)) as RemoteView).enabled).toBe(true);
});

test("a Tailscale failure reaches the owner as its own message and changes nothing", async () => {
  const t = await setup({ "status --json": running, "serve status --json": ok("{}"), "serve --bg --https=443 http://127.0.0.1:4317": { code: 1, stdout: "", stderr: "Serve is not enabled on your tailnet.\n" } });
  await expect(t.admin.handle("remote.enable", undefined)).rejects.toThrow(new AdminError("Serve is not enabled on your tailnet."));
  expect((await loadGatewayConfig(t.home)).remoteAccess).toEqual({ tailscale: false });
  expect(t.reloads()).toBe(0);
});

test("status when not installed carries install guidance in note", async () => {
  const t = await setup({ "status --json": { code: 127, stdout: "", stderr: "/usr/local/bin/tailscale: line 2: /Applications/Tailscale.app/Contents/MacOS/Tailscale: No such file or directory" } });
  const view = (await t.admin.handle("remote.status", undefined)) as RemoteView;
  expect(view).toMatchObject({ enabled: false, tailscale: { installed: false, running: false } });
  expect(view.note).toContain("tailscale.com/download");
});

test("status when installed but signed out says to sign in; when on, it shows the url", async () => {
  const t = await setup({ "status --json": { code: 1, stdout: "", stderr: "Logged out." } });
  expect(((await t.admin.handle("remote.status", undefined)) as RemoteView).note).toMatch(/sign in/i);
  await saveGatewayConfig(t.home, { ...(await loadGatewayConfig(t.home)), remoteAccess: { tailscale: true, httpsPort: 8443, hostname: NAME } });
  expect(((await t.admin.handle("remote.status", undefined)) as RemoteView)).toMatchObject({ enabled: true, url: `https://${NAME}:8443/` });
});

test("disable when serve is already gone still turns the setting off", async () => {
  const t = await setup({ "status --json": running, "serve --https=443 off": { code: 1, stdout: "", stderr: "error: serve config not found\n" } });
  await saveGatewayConfig(t.home, { ...(await loadGatewayConfig(t.home)), remoteAccess: { tailscale: true, httpsPort: 443, hostname: NAME } });
  await t.admin.handle("remote.disable", undefined);
  expect((await loadGatewayConfig(t.home)).remoteAccess).toEqual({ tailscale: false });
});
