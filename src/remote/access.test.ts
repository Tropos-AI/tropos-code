import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../doctor/types";
import { loadGatewayConfig, saveGatewayConfig } from "../gateway/config";
import { remoteHostHeader, remoteUrl } from "../web/links";
import { disableRemoteAccess, retryPendingDisable } from "./access";
import type { TailscaleRunner } from "./tailscale";

const NAME = "mac.tail1234.ts.net";
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });
const running = ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NAME}.` } }));

let home: string;
afterEach(() => rm(home, { recursive: true, force: true }));
async function setup(answers: Record<string, RunResult>) {
  home = await mkdtemp(join(tmpdir(), "tcode-access-"));
  await saveGatewayConfig(home, { ...(await loadGatewayConfig(home)), remoteAccess: { tailscale: true, httpsPort: 443, hostname: NAME } });
  const calls: string[][] = [];
  const runner: TailscaleRunner = {
    exec: async (_c, args) => {
      calls.push(args);
      return answers[args.join(" ")] ?? fail("unexpected command");
    },
  };
  return { runner, calls };
}

test("disable while Tailscale isn't running keeps a pending disable and still refuses the ts.net host", async () => {
  const t = await setup({ "serve --https=443 off": fail("failed to connect to local tailscaled"), "status --json": fail("failed to connect to local tailscaled") });
  await disableRemoteAccess(home, t.runner);
  const remote = (await loadGatewayConfig(home)).remoteAccess;
  expect(remote).toMatchObject({ pendingDisable: true, httpsPort: 443, hostname: NAME });
  expect(remote.tailscale).toBe(true);
  expect(remoteHostHeader(remote)).toBeNull();
  expect(remoteUrl(remote)).toBeNull();
});

test("a pending disable is retried: serve off succeeds, then the setting is cleared", async () => {
  const t = await setup({ "serve --https=443 off": fail("failed to connect"), "status --json": fail("failed to connect") });
  await disableRemoteAccess(home, t.runner);
  const back: TailscaleRunner = { exec: async () => ok() };
  expect(await retryPendingDisable(home, back)).toBe(true);
  expect((await loadGatewayConfig(home)).remoteAccess).toEqual({ tailscale: false });
});

test("a pending disable that still can't reach Tailscale stays pending", async () => {
  const t = await setup({ "serve --https=443 off": fail("failed to connect"), "status --json": fail("failed to connect") });
  await disableRemoteAccess(home, t.runner);
  expect(await retryPendingDisable(home, t.runner)).toBe(false);
  expect((await loadGatewayConfig(home)).remoteAccess.pendingDisable).toBe(true);
});

test("retry with nothing pending does not touch Tailscale", async () => {
  const t = await setup({});
  expect(await retryPendingDisable(home, t.runner)).toBe(false);
  expect(t.calls).toEqual([]);
});

test("a vague error mentioning 'nothing' is not 'already off': Tailscale running means the failure is real", async () => {
  const t = await setup({ "serve --https=443 off": fail("nothing works, permission denied"), "status --json": running });
  await expect(disableRemoteAccess(home, t.runner)).rejects.toThrow(/permission denied/);
  expect((await loadGatewayConfig(home)).remoteAccess).toMatchObject({ tailscale: true });
});

test("Tailscale's own 'handler does not exist' counts as already off", async () => {
  const t = await setup({ "serve --https=443 off": fail("error: failed to remove web serve: handler does not exist"), "status --json": running });
  await disableRemoteAccess(home, t.runner);
  expect((await loadGatewayConfig(home)).remoteAccess).toEqual({ tailscale: false });
});
