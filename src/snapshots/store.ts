// src/snapshots/store.ts
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gitRoot } from "../context/memory";
import { isInside, projectKey } from "../paths";

/** `track()` gives up past this: a huge tree must not stall the turn it guards. */
export const TRACK_TIMEOUT_MS = 10_000;
/** Ceiling for every other git call, so a wedged git never hangs /undo forever. */
const DEFAULT_TIMEOUT_MS = 120_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRUNE_STAMP = "tropos-last-prune";
/** After SIGTERM a timed-out git gets this long to remove its lock files before it is SIGKILLed. */
const KILL_GRACE_MS = 2_000;
/** An index.lock older than this belongs to a git that died without cleaning up. */
const STALE_LOCK_MS = 60_000;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  timeoutMs?: number;
  input?: string;
  /** Absolute time (ms since epoch) after which the call is killed; overrides timeoutMs when sooner. */
  deadline?: number;
}

/**
 * The environment git runs with: ours minus every GIT_* variable, so a GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE or GIT_OBJECT_DIRECTORY inherited from a hook or an outer git can never point our
 * commands at the user's real repository. The index is then set explicitly to the store's own.
 */
function gitEnv(indexFile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith("GIT_")) continue;
    env[name] = value;
  }
  env.GIT_INDEX_FILE = indexFile;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** Splits NUL-terminated `-z` output; paths may hold spaces, newlines or any unicode verbatim. */
function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

async function spawnGit(argv: string[], env: Record<string, string>, cwd: string, opts: RunOptions = {}): Promise<GitResult> {
  let timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (opts.deadline !== undefined) timeout = Math.min(timeout, opts.deadline - Date.now());
  if (timeout <= 0) return { code: -1, stdout: "", stderr: "timed out" };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { code: -1, stdout: "", stderr: String(err) };
  }
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    // SIGTERM lets git delete index.lock; a SIGKILL would leave it and break every later call.
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  }, timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return timedOut ? { code: -1, stdout, stderr: `timed out\n${stderr}` } : { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}

/**
 * A shadow git repository that snapshots the user's work tree without touching its real `.git`.
 * Objects and the index live under `<home>/snapshots/<projectKey>/`; the work tree is the project's
 * git root, so the project's `.gitignore` files decide what is captured. No refs are written: trees
 * are referenced only from the in-memory undo stack, and `prune()` lets old ones expire.
 */
export class SnapshotStore {
  readonly root: string;
  /** The shadow git directory. */
  readonly dir: string;
  private readonly git: string;
  private readonly env: Record<string, string>;
  /** Serializes git calls: they all share one index file, and git refuses concurrent index writers. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(root: string, dir: string, git: string) {
    this.root = root;
    this.dir = dir;
    this.git = git;
    this.env = gitEnv(join(dir, "index"));
  }

  /**
   * Opens (creating on first use) the store for the git work tree containing `cwd`. Returns null
   * outside a git work tree, when git is missing, or when the store cannot be initialized: snapshots
   * are an optional safety net and must never block a session.
   */
  static async open(home: string, cwd: string, opts: { git?: string } = {}): Promise<SnapshotStore | null> {
    const found = gitRoot(cwd);
    if (found === null) return null;
    const root = await realpath(found).catch(() => found);
    const git = opts.git ?? "git";
    const dir = join(home, "snapshots", projectKey(root));
    const store = new SnapshotStore(root, dir, git);
    const version = await spawnGit([git, "--version"], store.env, root, { timeoutMs: 10_000 });
    if (version.code !== 0) return null;
    try {
      if (!existsSync(join(dir, "HEAD"))) {
        await mkdir(dir, { recursive: true });
        // --template= skips the sample hooks; the store never runs hooks anyway.
        const init = await store.run(["init", "-q", "--template="]);
        if (init.code !== 0) return null;
      }
      await store.clearStaleLock();
      await store.writeExclude();
    } catch {
      return null;
    }
    return store;
  }

  /** Removes an index.lock left by a git that was killed mid-write; a recent one may be another session's. */
  private async clearStaleLock(): Promise<void> {
    const lock = join(this.dir, "index.lock");
    const info = await stat(lock).catch(() => null);
    if (info !== null && Date.now() - info.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true });
  }

  /** Keeps `.git` (and the store itself, should the Tropos home live inside the project) out of snapshots. */
  private async writeExclude(): Promise<void> {
    const lines = [".git"];
    if (isInside(this.dir, this.root) && this.dir !== this.root) {
      lines.push("/" + relative(this.root, this.dir).split(sep).join("/") + "/");
    }
    const path = join(this.dir, "info", "exclude");
    const want = lines.join("\n") + "\n";
    const have = await readFile(path, "utf8").catch(() => null);
    if (have === want) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, want);
  }

  private argv(args: string[]): string[] {
    return [
      this.git,
      `--git-dir=${this.dir}`,
      `--work-tree=${this.root}`,
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.autocrlf=false",
      "-c", "core.fsmonitor=false",
      "-c", "gc.auto=0",
      "-c", "core.quotepath=false",
      ...args,
    ];
  }

  private run(args: string[], opts?: RunOptions): Promise<GitResult> {
    return spawnGit(this.argv(args), this.env, this.root, opts);
  }

  /** Runs `fn` after every earlier store operation has settled. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Stages the whole work tree into the store's index and writes it as a tree. */
  private async snapshot(opts: RunOptions): Promise<string | null> {
    const add = await this.run(["add", "-A", "--", "."], opts);
    if (add.code !== 0) return null;
    const tree = await this.run(["write-tree"], opts);
    if (tree.code !== 0) return null;
    const hash = tree.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(hash) ? hash : null;
  }

  /**
   * Records the current work tree and returns its tree hash, or null when git fails or the whole
   * operation takes longer than TRACK_TIMEOUT_MS (the caller then treats the turn as un-undoable).
   */
  track(): Promise<string | null> {
    return this.serialize(() => this.snapshot({ deadline: Date.now() + TRACK_TIMEOUT_MS }));
  }

  /**
   * `[status, path]` pairs from `tree` to the current work tree; status is git's A/M/D/T letter.
   * The index is refreshed first so the comparison sees the work tree as it is now.
   */
  private async diffFrom(tree: string): Promise<Array<[string, string]>> {
    const add = await this.run(["add", "-A", "--", "."]);
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
    const diff = await this.run(["diff-index", "--cached", "--name-status", "--no-renames", "-z", tree, "--"]);
    if (diff.code !== 0) throw new Error(`git diff-index failed: ${diff.stderr.trim()}`);
    const parts = splitZ(diff.stdout);
    const out: Array<[string, string]> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push([parts[i]!, parts[i + 1]!]);
    return out;
  }

  /** Repo-relative paths that differ between `tree` and the current work tree, sorted. Throws on git failure. */
  changedSince(tree: string): Promise<string[]> {
    return this.serialize(async () => (await this.diffFrom(tree)).map(([, p]) => p).sort());
  }

  /**
   * Makes the work tree match `tree` for every file the snapshots track and returns the paths it
   * changed, sorted. Files created since are deleted (with directories they leave empty); modified
   * and deleted files are written back from the tree. Ignored files never enter the index, so they
   * are never listed and never touched; neither is the real `.git`. Only differing paths are
   * checked out, so unchanged files keep their mtimes and watchers stay quiet. Throws on git failure,
   * before any file is touched when the failure is in reading the tree.
   */
  restore(tree: string): Promise<string[]> {
    return this.serialize(async () => {
      const changes = await this.diffFrom(tree);
      if (changes.length === 0) return [];
      // -m keeps stat data for entries that match, so the next `add -A` doesn't rehash the whole tree.
      const read = await this.run(["read-tree", "-m", tree]);
      if (read.code !== 0) throw new Error(`git read-tree failed: ${read.stderr.trim()}`);
      const added = changes.filter(([s]) => s === "A").map(([, p]) => p);
      const back = changes.filter(([s]) => s !== "A").map(([, p]) => p);
      // Delete first: a file created where the snapshot had a directory (or the reverse) must go
      // before checkout can write the old path.
      for (const path of added) await this.removeCreated(path);
      if (back.length > 0) {
        const checkout = await this.run(["checkout-index", "-f", "-u", "-z", "--stdin"], { input: back.join("\0") + "\0" });
        if (checkout.code !== 0) throw new Error(`git checkout-index failed: ${checkout.stderr.trim()}`);
      }
      return changes.map(([, p]) => p).sort();
    });
  }

  /** Deletes one file created after the snapshot, then any parent directories that are now empty. */
  private async removeCreated(path: string): Promise<void> {
    const abs = join(this.root, path);
    if (!isInside(abs, this.root) || abs === this.root) return;
    try {
      // Not recursive: a gitlink (a nested repository created since) shows up as one path, and a
      // whole repository is not ours to delete.
      await rm(abs, { force: true });
    } catch {
      return;
    }
    for (let dir = dirname(abs); dir !== this.root && isInside(dir, this.root); dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break; // not empty, or gone already
      }
    }
  }

  /**
   * Runs `git gc --prune=7.days.ago` at most once a day (tracked by a stamp file's mtime). Snapshot
   * trees are unreferenced, so this is what keeps the store from growing forever. Never throws.
   * Not serialized with the other operations: gc can run for minutes and git tolerates it running
   * beside `add`, so the first turn's track() must not queue behind it.
   */
  async prune(): Promise<void> {
    const stamp = join(this.dir, PRUNE_STAMP);
    try {
      const info = await stat(stamp);
      if (Date.now() - info.mtimeMs < PRUNE_INTERVAL_MS) return;
    } catch {
      // no stamp yet
    }
    try {
      await writeFile(stamp, new Date().toISOString() + "\n");
    } catch {
      return;
    }
    await this.run(["gc", "-q", "--prune=7.days.ago"], { timeoutMs: 10 * 60_000 });
  }
}
