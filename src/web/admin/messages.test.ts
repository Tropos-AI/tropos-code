// src/web/admin/messages.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HELPER_VERSION } from "../../messages/helper/applet";
import type { MessagesView } from "./api";
import type { MessagesRuntime, MessagesStatus } from "../../messages/runtime";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";
import { messagesHandlers, type MessagesDeps } from "./messages";

let kit: Kit;
let log: string[];
let status: MessagesStatus;
let opened: string[];
beforeEach(async () => {
  kit = await makeKit();
  log = [];
  opened = [];
  status = { helper: { installed: true, version: HELPER_VERSION, current: HELPER_VERSION }, fullDiskAccess: "no", automation: "unknown", signedIn: "unknown" };
});
afterEach(() => kit.close());

const runtime = (): MessagesRuntime => ({
  tools: () => [],
  status: async (o) => {
    log.push(o?.probe ? "probe" : "status");
    return status;
  },
  enable: async () => void log.push("enable"),
  dispose: () => void log.push("dispose"),
});
const admin = (over: MessagesDeps = {}) =>
  adminWith(kit, messagesHandlers(kit.ctx, { platform: "darwin", runtime, exec: async (cmd, args) => (opened.push([cmd, ...args].join(" ")), { code: 0, stdout: "", stderr: "" }), ...over }));
const settings = async () => JSON.parse(await readFile(join(kit.home, "settings.json"), "utf8")) as Record<string, unknown>;

test("on another system texts are unavailable and cannot be turned on", async () => {
  const a = admin({ platform: "linux" });
  expect(await a.handle("messages.get", undefined)).toEqual({ available: false, enabled: false });
  expect(await failure(a, "messages.set", { enabled: true })).toBe("Texts are only available on macOS.");
  expect(log).toEqual([]);
});

test("off by default: no status is asked", async () => {
  expect(await admin().handle("messages.get", undefined)).toEqual({ available: true, enabled: false });
  expect(log).toEqual([]);
});

test("turning on builds the helper, writes the user layer, reloads the gateway and returns the status", async () => {
  const out = await admin().handle("messages.set", { enabled: true });
  expect(out).toEqual({ available: true, enabled: true, status });
  expect(log.slice(0, 2)).toEqual(["enable", "dispose"]);
  expect((await settings()).messages).toBe(true);
  expect(kit.reloads).toBe(1);
  expect(await admin().handle("messages.get", undefined)).toMatchObject({ enabled: true, status });
});

test("turning off writes false and does not build anything", async () => {
  const a = admin();
  await a.handle("messages.set", { enabled: true });
  log.length = 0;
  expect(await a.handle("messages.set", { enabled: false })).toEqual({ available: true, enabled: false });
  expect((await settings()).messages).toBe(false);
  expect(log).not.toContain("enable");
});

test("a failed build leaves the setting alone and says why", async () => {
  const a = admin({ runtime: () => ({ ...runtime(), enable: async () => { throw new Error("osacompile failed"); } }) });
  expect(await failure(a, "messages.set", { enabled: true })).toContain("osacompile failed");
  await expect(readFile(join(kit.home, "settings.json"), "utf8")).rejects.toThrow();
});

test("probe asks Messages now; openSettings opens the named pane", async () => {
  const a = admin();
  await a.handle("messages.set", { enabled: true });
  log.length = 0;
  await a.handle("messages.probe", undefined);
  expect(log).toContain("probe");
  expect(await a.handle("messages.openSettings", { pane: "fda" })).toEqual({ ok: true });
  expect(opened).toEqual(["/usr/bin/open x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]);
  expect(await failure(a, "messages.openSettings", { pane: "x" as never })).toContain("pane");
});

test("a reload that fails is said in the answer; the setting is still saved", async () => {
  kit.ctx.gateway!.reload = async () => {
    throw new Error("gone");
  };
  const out = (await admin().handle("messages.set", { enabled: true })) as MessagesView;
  expect(out.note).toContain("restart the service");
  expect((await settings()).messages).toBe(true);
});

test("revealHelper selects the helper app in Finder, and says so when there is none yet", async () => {
  const app = join(kit.home, "helpers", "Tropos Messages Helper.app");
  expect(await failure(admin({ appPath: app }), "messages.revealHelper", undefined)).toBe("The Messages helper isn't set up yet: turn texts on first.");
  expect(opened).toEqual([]);
  await mkdir(app, { recursive: true });
  expect(await admin({ appPath: app }).handle("messages.revealHelper", undefined)).toEqual({ ok: true });
  expect(opened).toEqual([`/usr/bin/open -R ${app}`]);
  expect(await failure(admin({ appPath: app, platform: "linux" }), "messages.revealHelper", undefined)).toBe("Texts are only available on macOS.");
});
