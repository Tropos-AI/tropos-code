import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { BOOTSTRAP_TEXT, saveIdentity } from "../context/identity";
import { addProject } from "../gateway/projects";
import { finish } from "./engine";
import { openSkippedSteps } from "./reminders";
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

test("a step done since being skipped is no longer open", async () => {
  const deps = testDeps(home);
  await finish(deps, { skipped: ["projects"] });
  expect(await openSkippedSteps(deps)).toEqual(["projects"]);
  await addProject(home, { path: appDir }, { userHome });
  expect(await openSkippedSteps(deps)).toEqual([]);
});
