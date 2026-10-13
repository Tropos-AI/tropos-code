// eval/lib/task.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { isSafeRelativePath, loadTask, loadTasks, selectTasks, TaskError } from "./task";

let root: string;
beforeEach(async () => {
  root = await makeTmpDir("eval-task-");
});
afterEach(() => removeDir(root));

const valid = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  repo: ".",
  base: "abc1234",
  gold: "def5678",
  prompt: "The thing is broken when you do X; it should do Y.",
  hiddenTests: ["src/a.test.ts"],
  verify: "bun test ./src/a.test.ts",
  split: "dev",
  ...over,
});

async function writeTask(id: string, body: object, hidden = ["src/a.test.ts"]): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "task.json"), JSON.stringify(body));
  for (const p of hidden) {
    await mkdir(join(dir, "hidden", p, ".."), { recursive: true });
    await writeFile(join(dir, "hidden", p), "test");
  }
  return dir;
}

describe("loadTask", () => {
  test("fills defaults", async () => {
    const task = await loadTask(await writeTask("t1", valid("t1")));
    expect(task).toMatchObject({ id: "t1", setup: "", timeoutSec: 1800, tags: [] });
    expect(task.dir).toBe(join(root, "t1"));
  });

  test("rejects a missing hidden file, a wrong id, and a bad split", async () => {
    await expect(loadTask(await writeTask("t2", valid("t2"), []))).rejects.toThrow("hidden/src/a.test.ts is missing");
    await expect(loadTask(await writeTask("t3", valid("other")))).rejects.toThrow("must match its directory");
    await expect(loadTask(await writeTask("t4", valid("t4", { split: "train" })))).rejects.toBeInstanceOf(TaskError);
  });

  test("rejects hidden test paths that escape the workspace", async () => {
    await expect(loadTask(await writeTask("t5", valid("t5", { hiddenTests: ["../x.test.ts"] }), []))).rejects.toThrow("repo-relative");
  });
});

test("isSafeRelativePath", () => {
  expect(["src/a.ts", "test/e2e/x.test.ts", "a"].every(isSafeRelativePath)).toBe(true);
  expect(["/etc/passwd", "../a", "a/../../b", ".", "a\\b"].some(isSafeRelativePath)).toBe(false);
});

test("loadTasks sorts by id and selectTasks filters by id and split", async () => {
  await writeTask("b", valid("b", { split: "holdout" }));
  await writeTask("a", valid("a"));
  await mkdir(join(root, "not-a-task"));
  const tasks = await loadTasks(root);
  expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
  expect(selectTasks(tasks, { split: "holdout" }).map((t) => t.id)).toEqual(["b"]);
  expect(selectTasks(tasks, { ids: ["a"] }).map((t) => t.id)).toEqual(["a"]);
  expect(selectTasks(tasks, {}).length).toBe(2);
  expect(() => selectTasks(tasks, { ids: ["zzz"] })).toThrow("unknown task id");
  expect(await loadTasks(join(root, "missing"))).toEqual([]);
});
