// eval/lib/task.ts
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { z } from "zod";

/**
 * One eval task: a repository at `base`, a prompt written like an issue report, and hidden tests
 * that are copied in only after the agent has finished. `gold` is the commit that really fixed it;
 * validation checks that the hidden tests fail at `base` and pass at `gold`.
 */
const taskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Git repository the task comes from: "." for this repo, or an absolute path. */
  repo: z.string().min(1),
  base: z.string().regex(/^[0-9a-f]{7,40}$/),
  gold: z.string().regex(/^[0-9a-f]{7,40}$/),
  prompt: z.string().min(20),
  /** Repo-relative paths of the test files kept back from the agent; stored under hidden/. */
  hiddenTests: z.array(z.string().min(1)).min(1),
  /** Runs inside the workspace before the agent starts, with network (e.g. installing dependencies). */
  setup: z.string().default(""),
  /** Pass when this exits 0, run after the hidden tests are copied in, without network. */
  verify: z.string().min(1),
  /** "holdout" tasks are never looked at while tuning TCode; report them separately. */
  split: z.enum(["dev", "holdout"]),
  timeoutSec: z.number().int().positive().default(1800),
  tags: z.array(z.string()).default([]),
});

export type Task = z.infer<typeof taskSchema> & { dir: string };

export class TaskError extends Error {}

/** Repo-relative, no `..`, no absolute paths: hidden tests must land inside the workspace. */
export function isSafeRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\")) return false;
  const n = normalize(path);
  return n !== ".." && !n.startsWith("../") && n !== ".";
}

export async function loadTask(dir: string): Promise<Task> {
  const file = join(dir, "task.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new TaskError(`${file}: ${(e as Error).message}`);
  }
  const parsed = taskSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new TaskError(`${file}: ${issues}`);
  }
  const task = { ...parsed.data, dir };
  if (!dir.endsWith(`/${task.id}`)) throw new TaskError(`${file}: id "${task.id}" must match its directory name`);
  for (const path of task.hiddenTests) {
    if (!isSafeRelativePath(path)) throw new TaskError(`${file}: hidden test path "${path}" must be repo-relative`);
    if (!existsSync(join(dir, "hidden", path))) throw new TaskError(`${file}: hidden/${path} is missing`);
  }
  return task;
}

/** Every task under `root`, sorted by id. */
export async function loadTasks(root: string): Promise<Task[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  const tasks = await Promise.all(dirs.filter((d) => existsSync(join(d, "task.json"))).map(loadTask));
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/** Picks tasks by id (exact) or split; no filter means every task. */
export function selectTasks(tasks: Task[], filter: { ids?: string[]; split?: Task["split"] }): Task[] {
  let picked = tasks;
  if (filter.ids && filter.ids.length > 0) {
    const unknown = filter.ids.filter((id) => !tasks.some((t) => t.id === id));
    if (unknown.length > 0) throw new TaskError(`unknown task id(s): ${unknown.join(", ")}`);
    picked = picked.filter((t) => filter.ids!.includes(t.id));
  }
  if (filter.split) picked = picked.filter((t) => t.split === filter.split);
  return picked;
}
