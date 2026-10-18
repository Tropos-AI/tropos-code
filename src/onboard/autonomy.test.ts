import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { Autonomy } from "../gateway/autonomy";
import type { AutonomyLevel } from "../web/admin/api";
import { bwrapInstallCommand, readChatSettings, saveChatSettings, UnconfinedNotConfirmedError } from "./autonomy";
import { finish, reopen } from "./engine";
import { testDeps } from "./testing";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("autonomy-");
});
afterEach(() => removeDir(home));
const chat = async () => JSON.parse(await readFile(join(home, "gateway.json"), "utf8")).chat;

test("an existing Docker install reads as it is: docker, ask, not yet chosen in setup", async () => {
  await writeFile(join(home, "gateway.json"), JSON.stringify({ chat: { autonomy: "ask", backend: "docker" } }));
  expect(await readChatSettings(testDeps(home))).toMatchObject({ autonomy: "ask", backend: "docker", explicit: false, confinement: "sandbox-exec" });
});

test("saving Balanced on a confined machine writes chat.autonomy and backend host through P2's setters, and marks it chosen", async () => {
  await saveChatSettings(testDeps(home), { autonomy: "balanced", backend: "host" });
  expect(await chat()).toEqual({ autonomy: "balanced", backend: "host" });
  expect((await readChatSettings(testDeps(home))).explicit).toBe(true);
});

test("without confinement, Balanced needs the unconfined confirmation; Ask never does", async () => {
  const deps = testDeps(home, { confinement: async () => null, which: (c) => (c === "dnf" ? "/usr/bin/dnf" : null) });
  expect((await readChatSettings(deps)).installHint).toBe("sudo dnf install bubblewrap");
  await expect(saveChatSettings(deps, { autonomy: "balanced", backend: "host" })).rejects.toBeInstanceOf(UnconfinedNotConfirmedError);
  await saveChatSettings(deps, { autonomy: "ask", backend: "host" });
  expect((await saveChatSettings(deps, { autonomy: "balanced", backend: "host", acceptUnconfined: true })).allowUnconfined).toBe(true);
  expect((await chat()).allowUnconfined).toBe(true);
});

test("lowering to Ask and switching to host in one save needs no consent", async () => {
  const deps = testDeps(home, { confinement: async () => null });
  await writeFile(join(home, "gateway.json"), JSON.stringify({ chat: { autonomy: "balanced", backend: "docker" } }));
  await saveChatSettings(deps, { autonomy: "ask", backend: "host" });
  expect(await chat()).toMatchObject({ autonomy: "ask", backend: "host" });
});

test("finishing or reopening setup keeps what the owner chose", async () => {
  const deps = testDeps(home);
  await saveChatSettings(deps, { autonomy: "ask" });
  await finish(deps);
  expect((await readChatSettings(deps)).explicit).toBe(true);
  await reopen(deps);
  expect((await readChatSettings(deps)).explicit).toBe(true);
});

test("bwrapInstallCommand takes the first package manager found, in order", () => {
  expect(bwrapInstallCommand((c) => (c === "pacman" || c === "apk" ? `/bin/${c}` : null))).toBe("sudo pacman -S bubblewrap");
  expect(bwrapInstallCommand(() => null)).toBeNull();
});

test("AutonomyLevel and C3 Autonomy are the same union", () => {
  const a: Autonomy = "balanced" as AutonomyLevel;
  const b: AutonomyLevel = a;
  expect(b).toBe("balanced");
});
