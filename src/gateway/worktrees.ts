// src/gateway/worktrees.ts — git worktrees for chat work (spec §2.6): a chat in a registered repo edits a copy under
// ~/.tropos/worktrees/<project>/<task> on its own branch, and the owner then merges, opens a PR, keeps or discards it.
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { worktreesDir } from "../paths";

export type GitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Flags for every git call Tropos makes on the owner's repos. The repo's own config and hooks are the repo's (a cloned
 * repo can plant them), so nothing it names may run: no hooks, no fsmonitor program, no pager.
 */
const HOST_GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "commit.gpgsign=false"];

function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  // No system gitconfig (it may name helpers or drivers), and nothing may wait for a terminal prompt.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}

async function run(cmd: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { cwd, env: hostEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

export const hostGit: GitRun = (args, cwd) => run(["git", ...HOST_GIT_FLAGS, ...args], cwd);
/** The GitHub CLI, run the same way (no GIT_* variables, no prompts, 60 s). */
export const hostGh: GitRun = (args, cwd) => run(["gh", ...args], cwd);

export interface Worktree {
  key: string;
  projectId: string;
  repo: string;
  task: string;
  branch: string;
  path: string;
  base: string;
  createdAt: number;
}

export type WorktreeAction = "merge" | "pr" | "keep" | "discard";

/** What a guest gets for Merge or Open PR; the Telegram adapter recognises it to leave the buttons in place. */
export const OWNER_ONLY_FINISH = "Only the owner can merge or open a PR. You can keep the branch or discard it.";

const worktreeSchema = z.object({
  key: z.string(),
  projectId: z.string(),
  repo: z.string(),
  task: z.string(),
  branch: z.string(),
  path: z.string(),
  base: z.string(),
  createdAt: z.number(),
});
const fileSchema = z.object({ version: z.literal(1), worktrees: z.record(z.string(), worktreeSchema) });

/** The open worktrees by chat key, in `gateway/worktrees.json` (mode 0600). */
export class WorktreeStore {
  private readonly path: string;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(home: string) {
    this.path = join(home, "gateway", "worktrees.json");
  }

  async get(key: string): Promise<Worktree | undefined> {
    return (await this.read()).worktrees[key];
  }

  put(w: Worktree): Promise<void> {
    return this.change((s) => void (s.worktrees[w.key] = w));
  }

  remove(key: string): Promise<void> {
    return this.change((s) => void delete s.worktrees[key]);
  }

  private async read(): Promise<z.infer<typeof fileSchema>> {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // missing or unreadable: start empty
    }
    return { version: 1, worktrees: {} };
  }

  /** Changes are serialised so two chats finishing at once don't lose each other's entry. */
  private change(fn: (s: z.infer<typeof fileSchema>) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const s = await this.read();
      fn(s);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, this.path);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

/** `YYYYMMDD-HHMM-<4 hex>` in local time. */
export function taskName(now: Date, rand: () => string = () => randomBytes(2).toString("hex")): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${rand()}`;
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Creates a real directory (mode 0700) when missing; a link or file in its place is refused, never followed. */
async function ensureRealDir(dir: string): Promise<void> {
  let info: ReturnType<typeof lstatSync> | undefined;
  try {
    info = lstatSync(dir);
  } catch {
    // missing: created below
  }
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`${dir} must be a real folder inside the worktrees folder, not a link or file.`);
  if (!info) await mkdir(dir, { mode: 0o700 });
}

export async function createWorktree(o: {
  home: string;
  key: string;
  projectId: string;
  repo: string;
  git?: GitRun;
  now?: () => Date;
}): Promise<Worktree | undefined> {
  const git = o.git ?? hostGit;
  if (!PROJECT_ID.test(o.projectId) || o.projectId.includes("..")) throw new Error(`"${o.projectId}" can't be used as a worktree folder name.`);
  const head = await git(["rev-parse", "--verify", "HEAD"], o.repo);
  if (head.code !== 0) return undefined;
  const base = head.stdout.trim();

  await mkdir(o.home, { recursive: true, mode: 0o700 });
  const root = worktreesDir(realpathSync(o.home));
  const projectDir = join(root, o.projectId);
  await ensureRealDir(root);
  await ensureRealDir(projectDir);
  if (realpathSync(projectDir) !== projectDir || realpathSync(root) !== root) {
    throw new Error(`${projectDir} resolves outside the worktrees folder.`);
  }

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const task = taskName((o.now ?? (() => new Date()))());
    const branch = `tropos/${task}`;
    const path = join(projectDir, task);
    const added = await git(["worktree", "add", "-b", branch, path, "HEAD"], o.repo);
    if (added.code === 0) return { key: o.key, projectId: o.projectId, repo: o.repo, task, branch, path, base, createdAt: Date.now() };
    lastError = added.stderr.trim();
  }
  throw new Error(`Couldn't create a worktree: ${lastError}`);
}

export async function worktreeChanges(w: Worktree, git: GitRun = hostGit): Promise<{ changedFiles: number; commitsAhead: number }> {
  const status = await git(["status", "--porcelain", "-uall", "--no-renames"], w.path);
  const changedFiles = status.code === 0 ? status.stdout.split("\n").filter((l) => l.length > 0).length : 0;
  const ahead = await git(["rev-list", "--count", `${w.base}..HEAD`], w.path);
  const commitsAhead = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0;
  return { changedFiles, commitsAhead };
}

/** `gh` is logged in and the repo has an `origin` to push to. */
export async function ghReady(repo: string, gh: GitRun = hostGh, git: GitRun = hostGit): Promise<boolean> {
  if ((await gh(["auth", "status"], repo)).code !== 0) return false;
  return (await git(["remote", "get-url", "origin"], repo)).code === 0;
}

/** The worktree sits exactly at `<…>/worktrees/<project>/<task>` with real folders above it; anything else is left alone. */
function safeLayout(w: Worktree): boolean {
  if (w.branch !== `tropos/${w.task}` || basename(w.path) !== w.task) return false;
  const projectDir = dirname(w.path);
  if (basename(projectDir) !== w.projectId || basename(dirname(projectDir)) !== "worktrees") return false;
  try {
    return realpathSync(projectDir) === projectDir;
  } catch {
    return false;
  }
}

const identity = async (git: GitRun, cwd: string): Promise<string[]> =>
  (await git(["config", "user.email"], cwd)).stdout.trim() === "" ? ["-c", "user.name=Tropos", "-c", "user.email=tropos@localhost"] : [];

/** Stages and commits everything in the worktree when anything changed. */
async function commitAll(w: Worktree, title: string, git: GitRun): Promise<string | undefined> {
  const status = await git(["status", "--porcelain"], w.path);
  if (status.code !== 0) return `Couldn't read the worktree: ${status.stderr.trim()}`;
  if (status.stdout.trim() === "") return undefined;
  const add = await git(["add", "-A"], w.path);
  if (add.code !== 0) return `Couldn't stage the changes: ${add.stderr.trim()}`;
  const commit = await git([...(await identity(git, w.path)), "commit", "--no-verify", "-m", title, "-m", "Made by Tropos from a chat."], w.path);
  return commit.code === 0 ? undefined : `Couldn't commit the changes: ${commit.stderr.trim() || commit.stdout.trim()}`;
}

/** Removes the worktree folder; a link in its place is unlinked and never followed. */
async function removeWorktree(w: Worktree, git: GitRun): Promise<void> {
  let isLink = false;
  try {
    isLink = lstatSync(w.path).isSymbolicLink();
  } catch {
    // already gone
  }
  if (isLink) await unlink(w.path).catch(() => {});
  else await git(["worktree", "remove", "--force", w.path], w.repo);
  await git(["worktree", "prune"], w.repo);
}

export async function finishWorktree(
  w: Worktree,
  action: WorktreeAction,
  o: { title: string; git?: GitRun; gh?: GitRun },
): Promise<{ ok: boolean; message: string }> {
  const git = o.git ?? hostGit;
  const gh = o.gh ?? hostGh;
  const fail = (message: string): { ok: boolean; message: string } => ({ ok: false, message });
  if (!safeLayout(w)) return fail("That worktree isn't where Tropos keeps them, so I left it alone.");
  const title = o.title.replace(/\s+/g, " ").trim() || "Changes from a chat";

  if (action === "pr" && !(await ghReady(w.repo, gh, git))) {
    return fail("I can't open a PR: GitHub's gh isn't logged in, or this repo has no origin. You can merge, keep the branch or discard it.");
  }
  if (action !== "discard") {
    const problem = await commitAll(w, title, git);
    if (problem) return fail(problem);
  }

  let result: { ok: boolean; message: string };
  let deleteBranch: "-d" | "-D" | undefined;
  if (action === "merge") {
    const merged = await git([...(await identity(git, w.repo)), "merge", "--no-ff", "--no-edit", "--no-verify", w.branch], w.repo);
    if (merged.code === 0) {
      deleteBranch = "-d";
      const into = (await git(["branch", "--show-current"], w.repo)).stdout.trim();
      result = { ok: true, message: `Merged ${w.branch}${into ? ` into ${into}` : ""}.` };
    } else {
      if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], w.repo)).code === 0) await git(["merge", "--abort"], w.repo);
      result = fail(`Couldn't merge cleanly, so I kept the branch ${w.branch} for you to merge by hand.`);
    }
  } else if (action === "pr") {
    const pushed = await git(["push", "-u", "origin", w.branch], w.repo);
    if (pushed.code !== 0) {
      result = fail(`Couldn't push ${w.branch}, so I kept the branch: ${pushed.stderr.trim().split("\n").pop() ?? ""}`);
    } else {
      const pr = await gh(["pr", "create", "--head", w.branch, "--title", title, "--body", "Made by Tropos from a chat."], w.repo);
      result =
        pr.code === 0
          ? { ok: true, message: `Opened a PR for ${w.branch}: ${pr.stdout.trim().split("\n").pop() ?? ""}` }
          : fail(`Pushed ${w.branch}, but gh couldn't open the PR: ${pr.stderr.trim().split("\n").pop() ?? ""}`);
    }
  } else if (action === "keep") {
    result = { ok: true, message: `Kept the work on ${w.branch}. The worktree folder is gone; check the branch out to continue.` };
  } else {
    deleteBranch = "-D";
    result = { ok: true, message: `Discarded ${w.branch}.` };
  }

  await removeWorktree(w, git);
  if (deleteBranch) await git(["branch", deleteBranch, w.branch], w.repo);
  return result;
}
