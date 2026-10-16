// src/learning/stores.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { STORE_TOOLS, troposStorePaths } from "./stores";

let dir: string;
let outside: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  outside = await makeTmpDir();
});
afterEach(async () => {
  await removeDir(dir);
  await removeDir(outside);
});

test("lists the five tools' stores as canonical paths under the home", async () => {
  const real = join(dir, "real-home");
  await mkdir(real);
  // The home is reached through a link, as /var is on macOS; what is listed is where the files really go.
  await symlink(real, join(dir, "home"));
  expect(STORE_TOOLS).toEqual(["Memory", "DailyNote", "SkillManage", "AgentManage", "Identity"]);
  expect(troposStorePaths(join(dir, "home"))).toEqual(
    ["memories", "skills", "skills-learned", "agents", "IDENTITY.md", "SOUL.md", "identity.json"].map((name) => join(real, name)),
  );
});

test("a store that is itself a link is left out, wherever it points", async () => {
  await symlink(outside, join(dir, "skills"));
  await mkdir(join(dir, "elsewhere"));
  await symlink(join(dir, "elsewhere"), join(dir, "agents"));
  await symlink("/etc/hosts", join(dir, "SOUL.md"));
  const paths = troposStorePaths(dir);
  expect(paths).toEqual(["memories", "skills-learned", "IDENTITY.md", "identity.json"].map((name) => join(dir, name)));
});
