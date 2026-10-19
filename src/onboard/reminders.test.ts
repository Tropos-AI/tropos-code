import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { BOOTSTRAP_TEXT, saveIdentity } from "../context/identity";
import { addProject } from "../gateway/projects";
import { finish } from "./engine";
import { readOnboardingFlags } from "./flags";
import { openSkippedSteps, setupReminderContext, takeSetupReminder } from "./reminders";
import { fakeService, testDeps } from "./testing";

let root: string;
let home: string;
let userHome: string;
let appDir: string;
beforeEach(async () => {
  root = await makeTmpDir("reminders-");
  userHome = root;
  home = join(root, ".tropos");
  appDir = join(root, "app");
  await mkdir(home, { recursive: true });
  await mkdir(appDir);
});
afterEach(() => removeDir(root));

const owner = { role: "owner" as const, interactive: true };

test("a skipped step that is still open is reminded once, then never again", async () => {
  const deps = testDeps(home);
  await finish(deps, { skipped: ["telegram", "phone"] });
  expect(await takeSetupReminder(deps, owner)).toContain("Telegram, so they can talk to you from their phone");
  expect(await takeSetupReminder(deps, owner)).toContain("phone access");
  expect(await takeSetupReminder(deps, owner)).toBe("");
  expect((await readOnboardingFlags(home)).reminded).toEqual(["telegram", "phone"]);
});

test("the reminder text is the specified block", () => {
  expect(setupReminderContext("service")).toStartWith("<setup-reminder>\nDuring setup the user skipped running in the background");
  expect(setupReminderContext("service")).toEndWith("Don't bring it up again.\n</setup-reminder>");
});

test("guests, scheduled runs and print mode get nothing; a step done since is not reminded", async () => {
  const deps = testDeps(home);
  await finish(deps, { skipped: ["projects"] });
  for (const who of [{ role: "guest", interactive: true }, { role: "scheduled", interactive: false }, { role: "owner", interactive: false }] as const) {
    expect(await takeSetupReminder(deps, who)).toBe("");
  }
  expect((await readOnboardingFlags(home)).reminded).toBeUndefined();
  await addProject(home, { path: appDir }, { userHome });
  expect(await takeSetupReminder(deps, owner)).toBe("");
});

test("openSkippedSteps lists only skipped steps still undone, in step order", async () => {
  const deps = testDeps(home);
  await mkdir(join(home, "workspace"), { recursive: true });
  await writeFile(join(home, "workspace", "BOOTSTRAP.md"), BOOTSTRAP_TEXT);
  await finish(deps, { skipped: ["projects", "identity", "service"] });
  expect(await openSkippedSteps(deps)).toEqual(["identity", "projects", "service"]);
  await saveIdentity(home, { name: "Ada" });
  expect(await openSkippedSteps(deps)).toEqual(["projects", "service"]);
  expect(await openSkippedSteps(deps, { serviceInstalled: true })).toEqual(["projects"]);
  const withService = testDeps(home, { service: fakeService({ installed: true }) });
  expect(await openSkippedSteps(withService)).toEqual(["projects"]);
});
