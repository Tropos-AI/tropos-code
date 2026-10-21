// src/doctor/checks/messages.test.ts
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HELPER_VERSION } from "../../messages/helper/applet";
import type { MessagesRuntime, MessagesStatus } from "../../messages/runtime";
import { byId, makeFixture, runOne, type Fixture } from "../testing";
import { messagesCheckWith } from "./messages";

let fx: Fixture;
afterEach(() => fx?.close());

const status = (over: Partial<MessagesStatus> = {}): MessagesStatus => ({ helper: { installed: true, version: HELPER_VERSION, current: HELPER_VERSION }, fullDiskAccess: "yes", automation: "yes", ...over });
const fakeRuntime = (s: MessagesStatus): (() => MessagesRuntime) => () => ({ tools: () => [], status: async () => s, enable: async () => {}, dispose: () => {} });
const on = async () => fx.write("settings.json", JSON.stringify({ messages: true }));

test("not macOS: no findings", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, messagesCheckWith(fakeRuntime(status())))).findings).toEqual([]);
});

test("off: one info finding", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, messagesCheckWith(fakeRuntime(status())), { platform: "darwin" });
  expect(r.findings.map((f) => [f.id, f.level])).toEqual([["messages", "info"]]);
  expect(r.findings[0]!.message).toBe("Texts (Messages) are off");
});

test("on with Full Disk Access refused: an error naming it", async () => {
  fx = await makeFixture();
  await on();
  const r = await runOne(fx, messagesCheckWith(fakeRuntime(status({ fullDiskAccess: "no", automation: "no" }))), { platform: "darwin" });
  expect(byId(r, "messages.fda")).toMatchObject({ level: "error" });
  expect(byId(r, "messages.fda")!.message).toContain("Full Disk Access");
  expect(byId(r, "messages.automation")!.level).toBe("warn");
});

test("automation not yet checked is only info", async () => {
  fx = await makeFixture();
  await on();
  const r = await runOne(fx, messagesCheckWith(fakeRuntime(status({ automation: "unknown" }))), { platform: "darwin" });
  expect(byId(r, "messages.automation")!.level).toBe("info");
});

test("a missing helper is a fixable warning, and the fix builds it", async () => {
  fx = await makeFixture();
  await on();
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push(cmd);
    // osacompile makes the bundle the later steps edit.
    if (cmd.endsWith("osacompile")) await (await import("node:fs/promises")).mkdir(join(args[1]!, "Contents", "Resources"), { recursive: true });
    return { code: 0, stdout: "", stderr: "", };
  };
  const check = messagesCheckWith(fakeRuntime(status({ helper: { installed: false, current: HELPER_VERSION } })));
  const r = await runOne(fx, check, { platform: "darwin", fix: "safe", runner: { exec } });
  const f = byId(r, "messages.helper")!;
  expect(f).toMatchObject({ level: "warn", fixable: true, safe: true, fixed: true });
  expect(calls).toContain("/usr/bin/osacompile");
  expect(existsSync(join(fx.userHome, ".local", "share", "tropos", "helpers", "Tropos Messages Helper.app"))).toBe(true);
});

test("an outdated helper is fixable but not safe, and its fix says the permissions must be granted again", async () => {
  fx = await makeFixture();
  await on();
  const app = join(fx.userHome, ".local", "share", "tropos", "helpers", "Tropos Messages Helper.app");
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await writeFile(join(app, "Contents", "Resources", "tropos-helper-version"), "0\n");
  const exec = async (cmd: string, args: string[]) => {
    if (cmd.endsWith("osacompile")) await mkdir(join(args[1]!, "Contents", "Resources"), { recursive: true });
    return { code: 0, stdout: "", stderr: "" };
  };
  const check = messagesCheckWith(fakeRuntime(status({ helper: { installed: true, version: 0, current: HELPER_VERSION } })));
  const asked = await runOne(fx, check, { platform: "darwin", fix: "safe", runner: { exec } });
  expect(byId(asked, "messages.helper")).toMatchObject({ level: "warn", fixable: true });
  expect(byId(asked, "messages.helper")!.safe).toBeUndefined();
  expect(byId(asked, "messages.helper")!.fixed).toBeFalsy();
  const fixed = await runOne(fx, check, { platform: "darwin", fix: true, runner: { exec } });
  expect(byId(fixed, "messages.helper")!.fixMessage).toContain("Full Disk Access");
});

test("Full Disk Access that could not be checked is only info", async () => {
  fx = await makeFixture();
  await on();
  const r = await runOne(fx, messagesCheckWith(fakeRuntime(status({ fullDiskAccess: "unknown" }))), { platform: "darwin" });
  expect(byId(r, "messages.fda")!.level).toBe("info");
});
