import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "../../install/check";
import { InstallError } from "../../install/errors";
import { ensureLayout, resolveLayout } from "../../install/layout";
import { emptyState, writeState } from "../../install/state";
import { adminOverWs, makeKit, writeText, type Kit } from "./ops-testkit";
import type { AdminContext } from "./context";
import { updateHandlers, type UpdateDeps } from "./update";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.cleanup());

const engine = (() => ({}) as never) as UpdateDeps["engine"];
const found = (latest: string): UpdateDeps["check"] => async (_d, channel) => ({ channel, latest, source: "primary", checkedAt: "2026-10-15T12:00:00.000Z", available: latest !== "1.2.3" }) satisfies CheckResult;

test("status reads local settings and state only, no network", async () => {
  const layout = resolveLayout(kit.ctx.env, kit.userHome);
  await ensureLayout(layout, { uid: process.getuid!(), gid: process.getgid!(), user: "", group: "" });
  await writeState(layout, { ...emptyState(), autoUpdate: { ...emptyState().autoUpdate, lastCheck: "2026-10-14T08:00:00.000Z" } });
  await writeText(join(kit.home, "settings.json"), '{"autoUpdatesChannel":"stable","autoUpdates":false}');
  const h = updateHandlers(kit.ctx, { check: (async () => { throw new Error("no network in status"); }) as never });
  expect(await h["update.status"]!(undefined)).toEqual({ current: "1.2.3", channel: "stable", available: false, checkedAt: "2026-10-14T08:00:00.000Z", autoUpdates: false });
});

test("status defaults: latest channel, auto updates on, nothing checked", async () => {
  expect(await updateHandlers(kit.ctx)["update.status"]!(undefined)).toEqual({ current: "1.2.3", channel: "latest", available: false, autoUpdates: true });
});

test("check asks the channel and remembers what it saw", async () => {
  const seen: string[] = [];
  const h = updateHandlers(kit.ctx, { engine, check: (async (d, c, cur) => (seen.push(`${c}@${cur}`), found("1.3.0")(d, c, cur))) as UpdateDeps["check"] });
  expect(await h["update.check"]!(undefined)).toMatchObject({ latest: "1.3.0", available: true, current: "1.2.3" });
  expect(seen).toEqual(["latest@1.2.3"]);
  expect((await h["update.status"]!(undefined)).latest).toBe("1.3.0");
});

test("a failed check is a readable error without secrets", async () => {
  const h = updateHandlers(kit.ctx, { engine, check: (async () => { throw new InstallError("network", "cannot resolve the latest channel (Bearer abcdef123456)"); }) as never });
  const err = await h["update.check"]!(undefined).catch((e: Error) => e);
  expect((err as Error).message).toMatch(/Couldn't check for updates: cannot resolve/);
  expect((err as Error).message).not.toContain("abcdef123456");
});

test("run reports the outcome of the same install as `tcode update`", async () => {
  let seen: { autoUpdatesChannel: string } | undefined;
  const h = updateHandlers(kit.ctx, {
    engine,
    install: async (c) => {
      seen = c.settings;
      c.out("Updated Tropos Code from 1.2.3 to 1.4.0.\n");
      return 0;
    },
  });
  expect(await h["update.run"]!(undefined)).toEqual({ ok: true, from: "1.2.3", to: "1.4.0", message: "Updated Tropos Code from 1.2.3 to 1.4.0." });
  expect(seen).toMatchObject({ autoUpdatesChannel: "latest" });
  expect((await h["update.status"]!(undefined)).latest).toBe("1.4.0");
});

test("run reports failures, and an up-to-date install", async () => {
  const failing = updateHandlers(kit.ctx, { engine, install: async (c) => (c.err("tcode: not a native install; install with install.sh\n"), 1) });
  expect(await failing["update.run"]!(undefined)).toEqual({ ok: false, from: "1.2.3", message: "tcode: not a native install; install with install.sh" });
  const same = updateHandlers(kit.ctx, { engine, install: async (c) => (c.out("Tropos Code 1.2.3 is up to date (latest: 1.2.3).\n"), 0) });
  expect(await same["update.run"]!(undefined)).toMatchObject({ ok: true, to: "1.2.3" });
  const throwing = updateHandlers(kit.ctx, { engine, install: async () => { throw new Error("disk exploded"); } });
  expect(await throwing["update.run"]!(undefined)).toMatchObject({ ok: false, message: "disk exploded" });
});

test("run refuses to run twice at once and status says running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = updateHandlers(kit.ctx, { engine, install: async () => (await gate, 0) });
  const first = h["update.run"]!(undefined);
  expect((await h["update.status"]!(undefined)).running).toBe(true);
  expect(await h["update.run"]!(undefined)).toEqual({ ok: false, from: "1.2.3", message: "An update is already running." });
  release();
  expect((await first).ok).toBe(true);
  expect((await h["update.status"]!(undefined)).running).toBeUndefined();
});

describe("run with restart (the dashboard's Update now)", () => {
  const updated = (to: string): UpdateDeps["install"] => async (c) => (c.out(`Updated Tropos Code from 1.2.3 to ${to}.\n`), 0);
  function fakeService(status: { installed: boolean; running: boolean }) {
    const calls: string[] = [];
    const service = { status: async () => ({ manager: "launchd" as const, ...status }), restart: async () => void calls.push("restart") };
    return { service, calls };
  }
  const inGateway = (): AdminContext => ({ ...kit.ctx, gateway: { runCronNow: async () => {}, reload: async () => {}, devicesChanged: async () => {} } });

  test("inside the gateway a running service restarts after the answer has gone out, and the message says so", async () => {
    const { service, calls } = fakeService({ installed: true, running: true });
    const timers: { fn: () => void; ms: number }[] = [];
    const h = updateHandlers(inGateway(), { engine, install: updated("1.4.0"), service, later: (fn, ms) => void timers.push({ fn, ms }) });
    const out = await h["update.run"]!({ restart: true });
    expect(out).toMatchObject({ ok: true, to: "1.4.0", restarting: true });
    expect(out.message).toBe("Updated Tropos Code from 1.2.3 to 1.4.0. Restarting the background service to run 1.4.0; this page reconnects by itself.");
    // Not yet: this process answers first, then the restart ends it.
    expect(calls).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBeGreaterThan(0);
    timers[0]!.fn();
    await Promise.resolve();
    expect(calls).toEqual(["restart"]);
  });

  test("outside the gateway (the terminal's setup) the running service restarts at once", async () => {
    const { service, calls } = fakeService({ installed: true, running: true });
    const h = updateHandlers(kit.ctx, { engine, install: updated("1.4.0"), service, later: () => { throw new Error("no timer outside the gateway"); } });
    const out = await h["update.run"]!({ restart: true });
    expect(out).toMatchObject({ ok: true, to: "1.4.0", restarting: true });
    expect(out.message).toBe("Updated Tropos Code from 1.2.3 to 1.4.0. Restarted the background service; it runs 1.4.0 now.");
    expect(calls).toEqual(["restart"]);
  });

  test("nothing restarts when it was up to date, when the service is stopped or missing, or when not asked", async () => {
    for (const [status, install, params] of [
      [{ installed: true, running: true }, (async (c) => (c.out("Tropos Code 1.2.3 is up to date (latest: 1.2.3).\n"), 0)) as UpdateDeps["install"], { restart: true }],
      [{ installed: true, running: false }, updated("1.4.0"), { restart: true }],
      [{ installed: false, running: false }, updated("1.4.0"), { restart: true }],
      [{ installed: true, running: true }, updated("1.4.0"), undefined],
    ] as const) {
      const { service, calls } = fakeService(status);
      const h = updateHandlers(inGateway(), { engine, install, service, later: (fn) => fn() });
      const out = await h["update.run"]!(params);
      expect(out.ok).toBe(true);
      expect(out.restarting).toBeUndefined();
      expect(calls).toEqual([]);
    }
  });

  test("a restart that fails outside the gateway is reported; the update stands", async () => {
    const service = { status: async () => ({ manager: "systemd" as const, installed: true, running: true }), restart: async () => { throw new Error("systemctl restart failed: exit 1"); } };
    const h = updateHandlers(kit.ctx, { engine, install: updated("1.4.0"), service });
    const out = await h["update.run"]!({ restart: true });
    expect(out).toMatchObject({ ok: true, to: "1.4.0" });
    expect(out.message).toContain("1.4.0 is installed, but the background service could not be restarted: systemctl restart failed: exit 1");
  });
});

test("setChannel and setAuto write user settings through the store", async () => {
  await writeText(join(kit.home, "settings.json"), '{"model":"claude-sonnet-5-5"}');
  const h = updateHandlers(kit.ctx);
  expect(await h["update.setChannel"]!({ channel: "stable" })).toMatchObject({ channel: "stable" });
  expect(await h["update.setAuto"]!({ enabled: false })).toMatchObject({ autoUpdates: false, channel: "stable" });
  const saved = JSON.parse(await readFile(join(kit.home, "settings.json"), "utf8"));
  expect(saved).toEqual({ model: "claude-sonnet-5-5", autoUpdatesChannel: "stable", autoUpdates: false });
  await expect(h["update.setChannel"]!({ channel: "nightly" as never })).rejects.toThrow(/latest/);
  await expect(h["update.setAuto"]!({ enabled: "yes" as never })).rejects.toThrow();
});

test("end to end over the WebSocket", async () => {
  const handlers = updateHandlers(kit.ctx, { engine, check: found("1.9.0"), install: async (c) => (c.out("Updated Tropos Code from 1.2.3 to 1.9.0.\n"), 0) });
  const ws = await adminOverWs(kit.ctx, handlers);
  try {
    expect(await ws.call("update.status")).toMatchObject({ ok: true, result: { current: "1.2.3" } });
    expect(await ws.call("update.check")).toMatchObject({ ok: true, result: { latest: "1.9.0", available: true } });
    expect(await ws.call("update.run")).toMatchObject({ ok: true, result: { ok: true, to: "1.9.0" } });
    expect(await ws.call("update.setChannel", { channel: "stable" })).toMatchObject({ ok: true, result: { channel: "stable" } });
    expect(await ws.call("update.setChannel", { channel: "x" })).toMatchObject({ ok: false });
  } finally {
    await ws.close();
  }
});
