// src/exec/docker.ts — runs Bash-tool commands in a locked-down container instead of on the host.
//
// One container per backend instance, started lazily by the first spawn(). spawn() must return a ChildProcess
// synchronously, but the container takes a moment to start. The choice: spawn() immediately starts a real
// host `sh` wrapper (detached, stdout/stderr piped, so bash.ts and the job table see an ordinary child). The
// wrapper polls the run dir for a `ready` file (written once `docker run` succeeded) or a `failed-<n>` file
// (holds the error text, printed to stderr, exit 125), then `exec`s `docker exec`, so the child's pid IS the
// docker client. No fake ChildProcess, no event plumbing; startup failure is a non-zero exit with a message.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { CwdMarker, ExecBackend, ExecSpawn } from "./backend";

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
}

const INSIDE_RUN = "/run/tropos";
const START_TIMEOUT_MS = 300_000; // a first run may have to pull the image
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const LABEL = "tropos=1";
const OWNER_LABEL = "tropos.pid";

/**
 * Paths inside the workspace that are mounted read-only, because the owner's next `git` command (or commit hook)
 * runs what is in them. A path that doesn't exist yet can't be protected by a mount, so the ones git itself
 * would create are created empty first (an empty hooks dir and config change nothing for git).
 *
 * Covered: `.git/hooks`, `.git/config`, the same under `.git/modules/**` (submodules), `.husky`, and a `.git`
 * gitfile (worktrees, submodule checkouts), whose target lives outside the mount anyway. Not covered: a workspace
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
    for (const gitDir of [git, ...submoduleGitDirs(join(git, "modules"), 0)]) {
      const hooks = resolve(join(gitDir, "hooks"));
      const config = resolve(join(gitDir, "config"));
      mkdirSync(hooks, { recursive: true });
      writeFileSync(config, "", { flag: "a" });
      out.push(hooks, config);
    }
  } else if (info?.isFile()) {
    out.push(git);
  }
  const husky = join(workspace, ".husky");
  if (existsSync(husky) || isLink(husky)) out.push(resolve(husky));
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
  private readonly ownsRunDir: boolean;
  private starting: Promise<void> | undefined;
  private started = false;
  private attempt = 0;
  private closing: Promise<void> | undefined;
  private readonly runs = new WeakMap<ChildProcess, Run>();

  constructor(opts: DockerBackendOptions) {
    this.workspace = opts.workspace;
    this.image = opts.image ?? "alpine:3.22";
    this.network = opts.network ?? "none";
    this.memory = opts.memory ?? "1g";
    this.cpus = opts.cpus ?? "2";
    this.pidsLimit = opts.pidsLimit ?? 256;
    this.bin = opts.dockerBin ?? "docker";
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
      `exec ${quote(this.bin)} exec -w ${quote(opts.cwd)} -e PATH=${quote(CONTAINER_PATH)} -e HOME=/tmp -e TERM=dumb ${quote(this.name)} sh -c ${quote(inner)} ${quote(opts.shell)} ${quote(opts.script)}`,
    ].join("\n");
    const child = spawn("/bin/sh", ["-c", wrapper], {
      cwd: tmpdir(),
      env: process.env, // the docker CLIENT needs its own host env (DOCKER_HOST, HOME); the container gets only the -e flags above
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.runs.set(child, { pidFile: join(this.runDir, `pid-${id}`) });
    return child;
  }

  cwdMarker(id: string): CwdMarker {
    return { inside: `${INSIDE_RUN}/cwd-${id}`, host: join(this.runDir, `cwd-${id}`) };
  }

  signal(child: ChildProcess, sig: NodeJS.Signals): void {
    try {
      const pid = this.containerPid(child);
      if (pid !== undefined) {
        // Kill the command inside; the docker client then exits by itself with the command's status.
        const killer = spawn(this.bin, ["exec", this.name, "sh", "-c", TREE_KILL, "tropos-kill", sig.replace(/^SIG/, ""), String(pid)], {
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
    const r = spawnSync(this.bin, ["exec", this.name, "sh", "-c", 'kill -0 "$0"', String(pid)], { stdio: "ignore", timeout: 5_000 });
    return r.status === 0;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      await run(this.bin, ["rm", "-f", this.name], 60_000);
      if (this.ownsRunDir) rmSync(this.runDir, { recursive: true, force: true });
      this.started = false;
    })();
    return this.closing;
  }

  private containerPid(child: ChildProcess): number | undefined {
    const r = this.runs.get(child);
    if (!r) return undefined;
    try {
      const n = Number.parseInt(readFileSync(r.pidFile, "utf8").trim(), 10);
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
      "-u", `${uid}:${gid}`,
      "-v", `${this.workspace}:${this.workspace}`,
      // What a later host-side `git` or commit runs: a command in the container must not plant code there.
      ...protectedPaths(this.workspace).flatMap((path) => ["-v", `${path}:${path}:ro`]),
      "-v", `${this.runDir}:${INSIDE_RUN}`,
      "-w", this.workspace,
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
