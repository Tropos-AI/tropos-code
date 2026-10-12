import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { DEFAULT_SETTINGS } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { SessionStore } from "../session/store";
import { createTools } from "../tools/registry";
import { DARK } from "../ui/theme";
import { createRuntime, type AppContext } from "./runtime";

let dir: string;
let ctx: AppContext;
beforeEach(async () => {
  dir = await makeTmpDir();
  ctx = {
    cwd: dir,
    home: join(dir, ".home"),
    version: "0.1.0",
    settings: DEFAULT_SETTINGS,
    rules: compileRules({ allow: [], ask: [], deny: [] }).rules,
    allowedDirs: [dir],
    tools: createTools({ rgPath: null }),
    model: new FakeModel([]),
    shell: "/bin/bash",
    localSettingsPath: join(dir, ".home", "projects", "p", "settings.json"),
  };
});
afterEach(() => removeDir(dir));

async function runtime() {
  const session = await SessionStore.create(ctx.home, { cwd: dir, model: "m", version: "v" });
  return { session, runtime: await createRuntime(ctx, { session, history: [], mode: "default", modes: ["default", "acceptEdits", "plan"], theme: DARK }) };
}

test("mode, model and effort changes are recorded as session events", async () => {
  const { session, runtime: rt } = await runtime();
  rt.setMode("plan");
  rt.setEffort("max");
  await Bun.sleep(20);
  const lines = (await readFile(session.path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.filter((l) => l.type === "event").map((l) => [l.name, l.value])).toEqual([
    ["mode", "plan"],
    ["effort", "max"],
  ]);
  expect(rt.state()).toMatchObject({ mode: "plan", effort: "max" });
});

test("clear starts a new session", async () => {
  const { runtime: rt } = await runtime();
  await rt.clear();
  expect(rt.history()).toEqual([]);
});

test("input history is saved per project and reloaded", async () => {
  const { runtime: first } = await runtime();
  first.recordInput("run the tests");
  await Bun.sleep(20);
  const { runtime: second } = await runtime();
  expect(second.inputHistory()).toEqual(["run the tests"]);
});
