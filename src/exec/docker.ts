// src/exec/docker.ts — runs Bash-tool commands in a locked-down container instead of on the host.
//
// One container per backend instance, started lazily by the first spawn(). spawn() must return a ChildProcess
// synchronously, but the container takes a moment to start. The choice: spawn() immediately starts a real
// host `sh` wrapper (detached, stdout/stderr piped, so bash.ts and the job table see an ordinary child). The
// wrapper polls the run dir for a `ready` file (written once `docker run` succeeded) or a `failed-<n>` file
// (holds the error text, printed to stderr, exit 125), then runs `docker exec` and, once it returns, checks that
// the command didn't plant a `.git/commondir` (see git-integrity.ts). The wrapper and the docker client share the
// child's process group. No fake ChildProcess, no event plumbing; a failure is a non-zero exit with a message.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { readSmallFileSync } from "../paths";
import type { CwdMarker, ExecBackend, ExecSpawn, FilesHold } from "./backend";
import { type CommondirSnapshot, commondirGuardShell, commondirSnapshot, enforceCommondir } from "./git-integrity";

export interface DockerBackendOptions {
  workspace: string;
  image?: string;
  network?: "none" | "bridge";
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** Container name; default `tropos-<random>`. */
  name?: string;
  /** Host dir for cwd markers and pid files, mounted at /run/tropos. Default: a fresh temp dir. */
  runDir?: string;
  dockerBin?: string;
  /** Paths inside `workspace` the container must not see (the chief's own files); the ones that exist are masked. */
  hide?: string[];
  /** A guest's sandbox: whatever a command leaves running is stopped once it ends (see quiesce). */
  stopLeftovers?: boolean;
}

const INSIDE_RUN = "/run/tropos";
const START_TIMEOUT_MS = 300_000; // a first run may have to pull the image
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const LABEL = "tropos=1";
const OWNER_LABEL = "tropos.pid";
/** `nobody`: the user the keeper (`sleep infinity`) of a guest's container runs as, apart from the commands' user. */
const KEEPER_ID = 65534;

/**
 * Runs inside a guest's container as the commands' user: kill(-1) signals every process that user may signal but the
 * caller, atomically, so a loop that forks can't slip through. PID 1 (docker-init) is never signalled, and the keeper
 * runs as another user, so the container survives.
 */
const SWEEP = "kill -9 -1 2>/dev/null; echo swept";

const BACKGROUND_BUSY =
  "A background job (run_in_background) is still running in this chat's sandbox, so files can't be read or changed until it ends. Wait for it, or stop it with KillShell.";
const COMMAND_RUNNING = "A command is still running in this chat's sandbox.";
const INTERRUPTED = "Interrupted while waiting for a command in this chat's sandbox to finish; nothing was read or changed.";

/**
 * `docker run` arguments that mask the `hide` paths inside the workspace: a file with /dev/null, a folder with an empty
 * read-only tmpfs. A missing path is masked too (a placeholder, `.md` names being files), or a command could create
 * USER.md or memory/ and plant text the chief later loads. A path outside the workspace is left alone; one that is a
 * link makes the sandbox refuse to start, since a mount can't be put over the link itself and the container could
 * swap it.
 */
export function hideMounts(workspace: string, hide: readonly string[]): string[] {
  let root: string;
  try {
    root = realpathSync(workspace);
  } catch {
    return [];
  }
  return hide.flatMap((path) => {
    if (!(path === root || path.startsWith(root + sep)) && !(path === workspace || path.startsWith(workspace + sep))) return [];
    let info: ReturnType<typeof lstatSync> | undefined;
    try {
      info = lstatSync(path);
    } catch {
      info = undefined;
    }
    if (info?.isSymbolicLink()) throw new Error(`${path} is a link; the sandbox won't run until it is replaced by a real file or folder.`);
    const isDir = info ? info.isDirectory() : !path.endsWith(".md");
    return isDir ? ["--tmpfs", `${path}:ro`] : ["-v", `/dev/null:${path}:ro`];
  });
}

/**
 * Paths inside the workspace that are mounted read-only, because the owner's next `git` command (or commit hook)
 * runs what is in them. A path that doesn't exist yet can't be protected by a mount, so the ones git itself
 * would create are created empty first (an empty hooks dir and config change nothing for git).
 *
 * Covered: `.git/hooks`, `.git/config`, the same under `.git/modules/**` (submodules), `.husky`, `.tropos` (the repo's
 * settings and deny rules), and a `.git` gitfile (worktrees, submodule checkouts), whose target lives outside the
 * mount anyway. Not covered: a workspace
 * with no `.git` at all, where a command could `git init` one; the daemon warns about that.
 */
export function protectedPaths(workspace: string): string[] {
  const out: string[] = [];
  // A symlink is followed to what it really points at: that is what git (and a hook) uses, so that is what must be
  // read-only. A link that leaves the workspace (or dangles) can't be protected from inside the container, and the
  // container could swap the link itself, so the sandbox refuses to start rather than run without protection. This
  // also keeps us from creating files or mounting host paths through a link in an untrusted repo.
  const root = realpathSync(workspace);
  const inside = (p: string): boolean => p === root || p.startsWith(root + sep);
  const isLink = (p: string): boolean => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const resolve = (p: string): string => {
    if (!isLink(p)) return p;
    let target: string;
    try {
      target = realpathSync(p);
    } catch {
      throw new Error(`${p} is a broken link; the sandbox won't run until it is removed.`);
    }
    if (!inside(target)) throw new Error(`${p} is a link that leaves the workspace (to ${target}); the sandbox won't run until it is replaced by a real file or folder.`);
    return target;
  };
  const git = resolve(join(workspace, ".git"));
  let info: ReturnType<typeof lstatSync> | undefined;
  try {
    info = lstatSync(git);
  } catch {
    info = undefined;
  }
  if (info?.isDirectory()) {
    for (const gitDir of [git, ...submoduleGitDirs(resolve(join(git, "modules")), 0)]) {
      const hooks = resolve(join(gitDir, "hooks"));
      const config = resolve(join(gitDir, "config"));
      const configWorktree = resolve(join(gitDir, "config.worktree"));
      mkdirSync(hooks, { recursive: true });
      writeFileSync(config, "", { flag: "a" });
      writeFileSync(configWorktree, "", { flag: "a" });
      out.push(hooks, config, configWorktree);
      // `commondir` moves where git looks for hooks/config; it can't be pre-created empty (git then fails to read
      // it), so it is mounted read-only only when it exists. Its creation is caught by the post-run guard below.
      const commondir = resolve(join(gitDir, "commondir"));
      if (existsSync(commondir)) out.push(commondir);
    }
  } else if (info?.isFile()) {
    out.push(git);
  }
  const husky = join(workspace, ".husky");
  if (existsSync(husky) || isLink(husky)) out.push(resolve(husky));
  // The repo's settings hold its deny rules, which a command must not strip: `.tropos` read-only, as under bwrap,
  // and an empty one when missing so a command can't create settings there either.
  const tropos = join(workspace, ".tropos");
  if (existsSync(tropos) || isLink(tropos)) out.push(resolve(tropos));
  else {
    mkdirSync(tropos);
    out.push(tropos);
  }
  return out;
}

/** Git directories under `.git/modules` (a submodule's own hooks and config), a few levels deep. */
function submoduleGitDirs(dir: string, depth: number): string[] {
  if (depth > 4) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    // A directory with a HEAD is a git dir (its own nested submodules sit under modules/); otherwise it is just
    // a path segment of a submodule's name, like `libs` in `libs/foo`.
    if (existsSync(join(sub, "HEAD"))) found.push(sub, ...submoduleGitDirs(join(sub, "modules"), depth + 1));
    else found.push(...submoduleGitDirs(sub, depth + 1));
  }
  return found;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Runs inside the container: `kill <sig> <root> and all its descendants`. The tree is found with ps (busybox and
 * procps both have `-o pid,ppid`); if that finds nothing it falls back to the root pid alone.
 */
const TREE_KILL = [
  'sig="$1"; root="$2"',
  'pids=$(ps -o pid,ppid 2>/dev/null | awk -v r="$root" \'NR>1{p[$1]=$2} END{for(i in p){x=i; n=0; while((x in p) && x!=r && n<64){x=p[x]; n++} if(x==r) print i}}\')',
  '[ -n "$pids" ] || pids="$root"',
  'kill "-$sig" $pids 2>/dev/null',
].join("\n");

/** A command's `commondir` snapshot, and what close() found if it ran the check first. */
interface PendingCheck {
  snap: CommondirSnapshot;
  closeMessage: string | null;
}

interface Run {
  /** Pid file the in-container wrapper writes, on the host side. */
  pidFile: string;
}

export class DockerBackend implements ExecBackend {
  readonly kind = "docker" as const;
  readonly name: string;
  readonly runDir: string;
  private readonly workspace: string;
  private readonly image: string;
  private readonly network: string;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly pidsLimit: number;
  private readonly bin: string;
  private readonly hide: string[];
  private readonly ownsRunDir: boolean;
  private starting: Promise<void> | undefined;
  private started = false;
  private attempt = 0;
  private closing: Promise<void> | undefined;
  private readonly runs = new WeakMap<ChildProcess, Run>();
  /** Commands whose `commondir` check hasn't run yet (see spawn). */
  private readonly pendingChecks = new Set<PendingCheck>();
  private readonly stopLeftovers: boolean;
  /** Commands whose wrapper hasn't exited yet: background jobs, or a foreground command still running. */
  private readonly live = new Map<ChildProcess, { background: boolean }>();
  /** File tools waiting for a foreground command to end (holdForFiles); called whenever a command ends. */
  private readonly ended = new Set<() => void>();
  /** A command ran since the last sweep, so something may still be running in the container. */
  private dirty = false;
  private sweeping: Promise<string | undefined> | undefined;
  /** File tools holding the sandbox (holdForFiles), and a sweep in progress; while there is one, the `gate` file exists. */
  private holders = 0;
  /** A host-only file (the container can't reach it) a command's wrapper waits on before it runs anything inside. */
  private readonly gate: string | undefined;
  /** The commands' user inside the container: the owner's ids, so files they create are the owner's. */
  private readonly user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

  constructor(opts: DockerBackendOptions) {
    this.workspace = opts.workspace;
    this.image = opts.image ?? "alpine:3.22";
    this.network = opts.network ?? "none";
    this.memory = opts.memory ?? "1g";
    this.cpus = opts.cpus ?? "2";
    this.pidsLimit = opts.pidsLimit ?? 256;
    this.bin = opts.dockerBin ?? "docker";
    this.hide = opts.hide ?? [];
    this.stopLeftovers = opts.stopLeftovers ?? false;
    if (this.stopLeftovers) this.gate = join(mkdtempSync(join(tmpdir(), "tropos-gate-")), "files-busy");
    this.name = opts.name ?? `tropos-${randomBytes(6).toString("hex")}`;
    if (opts.runDir) {
      this.ownsRunDir = !existsSync(opts.runDir);
      mkdirSync(opts.runDir, { recursive: true, mode: 0o700 });
      this.runDir = realpathSync(opts.runDir);
    } else {
      this.ownsRunDir = true;
      this.runDir = realpathSync(mkdtempSync(join(tmpdir(), "tropos-run-")));
    }
  }

  spawn(opts: ExecSpawn): ChildProcess {
    // Taken before the command can run: the `commondir`s that don't exist and so can't be mounted read-only.
    const snap = commondirSnapshot(join(this.workspace, ".git"), this.workspaceGitDirs());
    const attempt = this.begin();
    const id = randomBytes(8).toString("hex");
    const insidePid = `${INSIDE_RUN}/pid-${id}`;
    // `$0` is the requested shell, `$1` the script. A shell the image doesn't have (/bin/bash on alpine) becomes sh.
    const inner = `echo $$ > ${quote(insidePid)}; if command -v "$0" >/dev/null 2>&1; then exec "$0" -c "$1"; else exec sh -c "$1"; fi`;
    const wrapper = [
      `until [ -e ${quote(join(this.runDir, "ready"))} ]; do`,
      `  if [ ! -d ${quote(this.runDir)} ]; then echo "tropos sandbox: the sandbox was closed" >&2; exit 125; fi`,
      `  if [ -e ${quote(join(this.runDir, `failed-${attempt}`))} ]; then cat ${quote(join(this.runDir, `failed-${attempt}`))} >&2; exit 125; fi`,
      "  sleep 0.05",
      "done",
      // A file tool is working on the project as the owner: nothing of this command runs until it is done.
      ...(this.gate
        ? [
            `while [ -e ${quote(this.gate)} ]; do`,
            `  if [ ! -d ${quote(this.runDir)} ]; then echo "tropos sandbox: the sandbox was closed" >&2; exit 125; fi`,
            "  sleep 0.05",
            "done",
          ]
        : []),
      `${quote(this.bin)} exec -u ${quote(this.user)} -w ${quote(opts.cwd)} -e PATH=${quote(CONTAINER_PATH)} -e HOME=/tmp -e TERM=dumb ${quote(this.name)} sh -c ${quote(inner)} ${quote(opts.shell)} ${quote(opts.script)}`,
      "status=$?",
      // A planted commondir would point the owner's next host `git` at hooks the container wrote: undo it and fail.
      ...(snap ? commondirGuardShell(snap, quote) : []),
      'exit "$status"',
    ].join("\n");
    const child = spawn("/bin/sh", ["-c", wrapper], {
      cwd: tmpdir(),
      env: process.env, // the docker CLIENT needs its own host env (DOCKER_HOST, HOME); the container gets only the -e flags above
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.runs.set(child, { pidFile: join(this.runDir, `pid-${id}`) });
    this.dirty = true;
    this.live.set(child, { background: opts.background ?? false });
    const ended = () => {
      this.live.delete(child);
      for (const wake of [...this.ended]) wake();
    };
    child.once("exit", ended);
    child.once("error", ended);
    // Host-side fallback for when the wrapper never gets to its check (its process group was SIGKILLed): checked on
    // any exit, and in close() for a command still running then (that result is kept on the entry, so it is still
    // reported here). Registered before bash.ts's listeners, so the message lands in the command's stderr before its
    // result is read. Always reported when the host acts: the command's own output can't be trusted to say whether the
    // wrapper did (it can print the same line), so a duplicate of the wrapper's line is accepted.
    if (snap) {
      const pending: PendingCheck = { snap, closeMessage: null };
      this.pendingChecks.add(pending);
      child.once("close", () => {
        this.pendingChecks.delete(pending);
        const message = this.enforce(snap) ?? pending.closeMessage;
        if (message) child.stderr?.emit("data", `\n${message}\n`);
      });
    }
    return child;
  }

  /** Undoes a planted `commondir` where that is safe; the message to report, or null when nothing changed. */
  private enforce(snap: CommondirSnapshot): string | null {
    try {
      return enforceCommondir(snap).message;
    } catch {
      return null; // workspace gone; nothing to undo
    }
  }

  cwdMarker(id: string): CwdMarker {
    return { inside: `${INSIDE_RUN}/cwd-${id}`, host: join(this.runDir, `cwd-${id}`) };
  }

  /** The workspace's git dirs (repo, submodules, linked worktrees) for the `commondir` post-run check. */
  private workspaceGitDirs(): string[] {
    const git = join(this.workspace, ".git");
    try {
      if (!lstatSync(git).isDirectory()) return [];
    } catch {
      return [];
    }
    let worktrees: string[] = [];
    try {
      worktrees = readdirSync(join(git, "worktrees"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(git, "worktrees", e.name));
    } catch {
      // no linked worktrees
    }
    return [git, ...submoduleGitDirs(join(git, "modules"), 0), ...worktrees];
  }

  signal(child: ChildProcess, sig: NodeJS.Signals): void {
    try {
      const pid = this.containerPid(child);
      if (pid !== undefined) {
        // Kill the command inside; the docker client then exits by itself with the command's status.
        const killer = spawn(this.bin, ["exec", "-u", this.user, this.name, "sh", "-c", TREE_KILL, "tropos-kill", sig.replace(/^SIG/, ""), String(pid)], {
          detached: true,
          stdio: "ignore",
        });
        killer.on("error", () => {});
        killer.unref();
      }
      // The client alone is only killed when the command is not known (still starting) or on SIGKILL (a hung client).
      if (pid === undefined || sig === "SIGKILL") {
        if (child.pid) process.kill(-child.pid, sig);
      }
    } catch {
      // already gone
    }
  }

  alive(child: ChildProcess): boolean {
    try {
      if (child.pid) {
        process.kill(-child.pid, 0);
        return true;
      }
    } catch {
      // client gone; the command may still run
    }
    const pid = this.containerPid(child);
    if (pid === undefined || !this.started) return false;
    const r = spawnSync(this.bin, ["exec", "-u", this.user, this.name, "sh", "-c", 'kill -0 "$0"', String(pid)], { stdio: "ignore", timeout: 5_000 });
    return r.status === 0;
  }

  /**
   * A guest's sandbox: before a host-side file tool acts (and after each command), everything that finished commands
   * left running in the container is killed, so no loop of theirs can swap a project folder for a link while the
   * tool opens a file there as the owner. Nothing is killed while a command runs. The gate is raised for the sweep, so
   * a command spawned meanwhile waits for it instead of being killed by it.
   */
  async quiesce(): Promise<string | undefined> {
    if (!this.stopLeftovers) return undefined;
    if (this.live.size > 0) return COMMAND_RUNNING;
    this.sweeping ??= (async () => {
      const lower = this.raiseGate();
      try {
        return await this.sweep();
      } finally {
        lower();
      }
    })().finally(() => (this.sweeping = undefined));
    return this.sweeping;
  }

  /**
   * A file tool's hold on a guest's sandbox, for as long as it works on the project: taken only with no command
   * running (after the sweep), and commands spawned while it is held wait in their host-side wrapper, before anything
   * runs in the container, until the last holder releases. A command in the foreground (another subagent's) is waited
   * for, until `signal` aborts; a background job is a feature, so the tool refuses while one runs rather than wait for
   * it or kill it, which keeps the two from ever running side by side. An owner's sandbox holds nothing back.
   */
  async holdForFiles(signal?: AbortSignal): Promise<FilesHold> {
    if (!this.gate) return { ok: true, release: () => {} };
    for (;;) {
      if ([...this.live.values()].some((run) => run.background)) return { ok: false, reason: BACKGROUND_BUSY };
      if (this.live.size > 0) {
        if (await this.commandEnded(signal)) return { ok: false, reason: INTERRUPTED };
        continue;
      }
      const problem = await this.quiesce();
      if (problem !== undefined && this.live.size === 0) return { ok: false, reason: problem };
      // A command spawned during the sweep waited for it and runs now: wait for it like for any other.
      if (this.live.size === 0) return { ok: true, release: this.raiseGate() };
    }
  }

  /** Resolves once some command ends (false) or `signal` aborts (true). */
  private commandEnded(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (aborted: boolean) => {
        this.ended.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve(aborted);
      };
      const wake = () => done(false);
      const abort = () => done(true);
      this.ended.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** Holds commands back (the gate file exists while anyone holds it); the returned release is safe to call twice. */
  private raiseGate(): () => void {
    const gate = this.gate;
    if (!gate) return () => {};
    if (this.holders++ === 0) writeFileSync(gate, "");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holders === 0) rmSync(gate, { force: true });
    };
  }

  private async sweep(): Promise<string | undefined> {
    // No container (never started, failed, or closed and removed): nothing of a command can still run.
    if (!this.dirty || !this.started || this.closing) return undefined;
    this.dirty = false;
    const r = await run(this.bin, ["exec", "-u", this.user, this.name, "sh", "-c", SWEEP, "tropos-sweep"], 30_000);
    if (r.error || r.code !== 0 || !r.stdout.includes("swept")) {
      // A container that is gone (Docker restarted) runs nothing: that is as good as swept.
      if (await this.containerGone()) return undefined;
      this.dirty = true;
      return `Couldn't stop what earlier commands left running in this chat's sandbox (${(r.error?.message ?? r.stderr.trim()) || `exit ${r.code}`}), so files are left alone for now. Try again.`;
    }
    return undefined;
  }

  /** True only when Docker answers that the container doesn't exist or isn't running; any other answer is no answer. */
  private async containerGone(): Promise<boolean> {
    const r = await run(this.bin, ["inspect", "-f", "{{.State.Running}}", this.name], 30_000);
    if (r.error) return false;
    return (r.code === 0 && r.stdout.trim() === "false") || /no such (object|container)/i.test(r.stderr);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      await run(this.bin, ["rm", "-f", this.name], 60_000);
      for (const pending of this.pendingChecks) pending.closeMessage = this.enforce(pending.snap) ?? pending.closeMessage;
      this.pendingChecks.clear();
      if (this.ownsRunDir) rmSync(this.runDir, { recursive: true, force: true });
      if (this.gate) rmSync(dirname(this.gate), { recursive: true, force: true });
      this.started = false;
    })();
    return this.closing;
  }

  private containerPid(child: ChildProcess): number | undefined {
    const r = this.runs.get(child);
    if (!r) return undefined;
    try {
      // The container can write the run dir: a link or a FIFO planted as the pid file must not hang or flood the host.
      const n = Number.parseInt((readSmallFileSync(r.pidFile, 64) ?? "").trim(), 10);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  /** Single-flight container start; a failure is recorded for the wrappers waiting on this attempt and may be retried. */
  private begin(): number {
    if (this.started || this.starting) return this.attempt;
    const attempt = ++this.attempt;
    const fail = (message: string) => {
      this.starting = undefined;
      try {
        writeFileSync(join(this.runDir, `failed-${attempt}`), `tropos sandbox: ${message}\n`);
      } catch {
        // run dir removed by close(); the wrapper is already being killed
      }
    };
    if (this.closing) {
      fail("the sandbox was closed");
      return attempt;
    }
    this.starting = this.startContainer().then(
      () => {
        this.started = true;
        this.starting = undefined;
        writeFileSync(join(this.runDir, "ready"), "");
      },
      (err: Error) => fail(err.message),
    );
    return attempt;
  }

  private async startContainer(): Promise<void> {
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    // A guest's keeper runs as a user of its own, which the sweep's kill(-1) can't signal; it starts in / because that
    // user may not be allowed into the workspace. Commands set their user and directory on each `docker exec`.
    const keeper = uid === KEEPER_ID ? KEEPER_ID - 1 : KEEPER_ID;
    const args = [
      "run", "-d", "--rm", "--init",
      "--name", this.name,
      "--label", LABEL,
      "--label", `${OWNER_LABEL}=${process.pid}`,
      "--network", this.network,
      "--read-only", "--tmpfs", "/tmp",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.pidsLimit),
      "--memory", this.memory,
      "--cpus", this.cpus,
      "-u", this.stopLeftovers ? `${keeper}:${keeper}` : `${uid}:${gid}`,
      "-v", `${this.workspace}:${this.workspace}`,
      // What a later host-side `git` or commit runs: a command in the container must not plant code there.
      ...protectedPaths(this.workspace).flatMap((path) => ["-v", `${path}:${path}:ro`]),
      // The chief's own files: masked after the workspace mount, so the container sees neither their text nor their names.
      ...hideMounts(this.workspace, this.hide),
      "-v", `${this.runDir}:${INSIDE_RUN}`,
      "-w", this.stopLeftovers ? "/" : this.workspace,
      this.image,
      "sleep", "infinity",
    ];
    const r = await run(this.bin, args, START_TIMEOUT_MS);
    if (r.error) {
      const missing = (r.error as NodeJS.ErrnoException).code === "ENOENT";
      throw new Error(missing ? `could not start the container: ${this.bin} not found (is Docker installed?)` : `could not start the container: ${r.error.message}`);
    }
    if (r.code !== 0) {
      throw new Error(`could not start the container (${this.bin} run exited ${r.code}): ${(r.stderr || r.stdout).trim() || "no output; is Docker running?"}`);
    }
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return resolve({ code: null, stdout, stderr, error: error as Error });
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr, error: new Error(`${bin} ${args[0]} timed out after ${timeoutMs / 1000}s`) });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("error", (error) => done({ code: null, stdout, stderr, error }));
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

/**
 * Removes containers an earlier Tropos process left behind: labelled tropos=1, created before this process
 * started, and whose owner process (label tropos.pid) is no longer running. Returns how many were removed.
 */
export async function sweepLeftoverContainers(dockerBin = "docker"): Promise<number> {
  const listed = await run(dockerBin, ["ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.ID}} {{.Label "${OWNER_LABEL}"}}`], 30_000);
  if (listed.error || listed.code !== 0) return 0;
  const stale: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    const [cid, owner] = line.trim().split(/\s+/);
    if (!cid) continue;
    const pid = Number.parseInt(owner ?? "", 10);
    if (pid === process.pid) continue;
    if (Number.isInteger(pid) && pid > 0 && pidRunning(pid)) continue;
    stale.push(cid);
  }
  if (stale.length === 0) return 0;
  const removed = await run(dockerBin, ["rm", "-f", ...stale], 60_000);
  return removed.code === 0 ? stale.length : 0;
}

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
