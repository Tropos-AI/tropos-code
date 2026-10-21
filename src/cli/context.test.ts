// src/cli/context.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { SYSTEM_PROMPT } from "../context/system-prompt";
import { globalHarnessDir } from "../harness/tree";
import { loadProjectContext } from "./context";

let root: string;
beforeEach(async () => {
  root = await makeTmpDir("project-context-");
  await mkdir(join(root, "project"));
});
afterEach(() => removeDir(root));

test("each new session reads the harness, so one adopted while the gateway runs reaches the next session", async () => {
  const home = join(root, ".tropos");
  const project = await loadProjectContext({ cwd: join(root, "project"), home, env: {}, model: new FakeModel([]) });
  try {
    expect(project.ctx.system).toBe(SYSTEM_PROMPT);
    await mkdir(globalHarnessDir(home), { recursive: true });
    await writeFile(join(globalHarnessDir(home), "guardrails.md"), "Run the tests.\n");
    expect((await project.newSessionContext()).ctx.system).toBe(`${SYSTEM_PROMPT}\n\nRun the tests.`);
  } finally {
    await project.close();
  }
});
