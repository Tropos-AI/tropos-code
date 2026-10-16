// src/exec/confined.ts — runs a chat's commands on the host, confined to its project by the OS: macOS sandbox-exec
// with the profile from sandbox-profile.ts, or Linux bubblewrap with the arguments from bwrap-args.ts.
//
// sandbox-exec execs the shell in place, so the child is the shell itself and process-group signals work exactly
// as in LocalBackend. bwrap runs under a small host `sh` wrapper (same process group) that, once bwrap returns,
// checks that the command didn't plant a `.git/commondir` (git-integrity.ts): bwrap can't mask a missing one in
// advance, which the macOS profile can (its path denies apply to paths that don't exist yet).
import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Confinement, CwdMarker, ExecBackend, ExecSpawn } from "./backend";
import { bwrapArgs, nestedGitDirs } from "./bwrap-args";
import { ConfinementError, type ConfinementPaths, confinementPaths } from "./confinement-paths";
import { chatEnv } from "./env";
import { type CommondirSnapshot, commondirGuardShell, commondirSnapshot, enforceCommondir } from "./git-integrity";
import { LocalBackend } from "./local";
import { type SandboxProfile, sandboxProfile } from "./sandbox-profile";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface ConfinedBackendOptions {
  project: string;
  /** Tropos's home: denied to the command, except its workspace and the per-sandbox cache. */
  home: string;
  userHome: string;
  /** The owner's environment; the command gets only its allowlisted part (`chatEnv`). */
  env: NodeJS.ProcessEnv;
  /** For tests: the platform to confine for, and the bwrap binary. */
  platform?: NodeJS.Platform;
  bwrapBin?: string;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class ConfinedBackend implements ExecBackend {
  readonly kind = "confined" as const;
  /** Signals, liveness and close work exactly as for a host command: the child leads the command's process group. */
  private readonly host = new LocalBackend();
  private readonly paths: ConfinementPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly profile: SandboxProfile | undefined;
  private readonly bwrapBin: string;
  private readonly tempDir: string;

  constructor(opts: ConfinedBackendOptions) {
    const platform = opts.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      throw new ConfinementError(`Commands can't be confined on ${platform}: only macOS (sandbox-exec) and Linux (bwrap) are supported.`);
    }
    this.paths = confinementPaths({ project: opts.project, home: opts.home, userHome: opts.userHome, env: opts.env, platform });
    this.env = chatEnv(opts.env, { project: opts.project, troposHome: opts.home });
    this.bwrapBin = opts.bwrapBin ?? "bwrap";
    // Computed (and so refused, on a ConfinementError) once, here. bwrap's arguments are rebuilt per command (see
    // spawn); building them now still refuses a project that can't be confined before any command runs.
    if (platform === "darwin") this.profile = sandboxProfile(this.paths);
    else bwrapArgs(this.paths, this.paths.project);
    // The marker must be writable inside: the confined temp dir when it is one of the writable paths, else the
    // system temp dir (always writable). Real paths, so the file is the same inside and on the host.
    const temp = realOr(opts.env.TMPDIR ?? tmpdir());
    this.tempDir = this.paths.writable.includes(temp) ? temp : realOr(platform === "darwin" ? "/private/tmp" : "/tmp");
  }

  spawn(opts: ExecSpawn): ChildProcess {
    const options = { cwd: opts.cwd, env: this.env, detached: true, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
    if (this.profile) {
      const params = this.profile.params.flatMap(([k, v]) => ["-D", `${k}=${v}`]);
      return spawn(SANDBOX_EXEC, ["-p", this.profile.profile, ...params, opts.shell, "-c", opts.script], options);
    }
    return this.spawnBwrap(opts, options);
  }

  /**
   * bwrap's arguments depend on the command's cwd (`--chdir`) and on the git dirs that exist now (a bind of one
   * removed since would stop every later command), so they are rebuilt for each command.
   */
  private spawnBwrap(opts: ExecSpawn, options: Parameters<typeof spawn>[2]): ChildProcess {
    let args: string[];
    try {
      args = bwrapArgs(this.paths, opts.cwd);
    } catch (err) {
      // The repo changed into something that can't be confined (a linked .git): fail the command, never run it bare.
      return spawn("/bin/sh", ["-c", 'echo "$1" >&2; exit 126', "tropos-confined", `tropos sandbox: ${(err as Error).message}`], options);
    }
    // Taken before the command runs: the `commondir`s that don't exist and so can't be bound read-only.
    const git = join(this.paths.project, ".git");
    const snap = commondirSnapshot(git, [git, ...nestedGitDirs(git, 0)]);
    const wrapper = ['"$@"', "status=$?", ...(snap ? commondirGuardShell(snap, quote) : []), 'exit "$status"'].join("\n");
    const child = spawn("/bin/sh", ["-c", wrapper, "tropos-confined", this.bwrapBin, ...args, "--", opts.shell, "-c", opts.script], options);
    // Host-side fallback for when the wrapper never gets to its check (its group was killed). Registered before
    // bash.ts's listeners, so the message lands in the command's stderr before its result is read. Always reported
    // when the host acts: the command's own output can't be trusted to say whether the wrapper already did.
    if (snap) child.once("close", () => this.report(child, snap));
    return child;
  }

  private report(child: ChildProcess, snap: CommondirSnapshot): void {
    let message: string | null;
    try {
      message = enforceCommondir(snap).message;
    } catch {
      return; // project gone; nothing to undo
    }
    if (message) child.stderr?.emit("data", `\n${message}\n`);
  }

  cwdMarker(id: string): CwdMarker {
    const path = join(this.tempDir, `tropos-cwd-${id}`);
    return { inside: path, host: path };
  }

  signal(child: ChildProcess, sig: NodeJS.Signals): void {
    this.host.signal(child, sig);
  }

  alive(child: ChildProcess): boolean {
    return this.host.alive(child);
  }

  close(): Promise<void> {
    return this.host.close();
  }
}

export function confinedBackend(opts: { project: string; home: string; userHome: string; env: NodeJS.ProcessEnv }): ExecBackend {
  return new ConfinedBackend(opts);
}

/** No confinement available (the owner consented to that): the host, but still only the allowlisted environment. */
class UnconfinedBackend extends LocalBackend {
  constructor(private readonly env: NodeJS.ProcessEnv) {
    super();
  }

  override spawn(opts: ExecSpawn): ChildProcess {
    return super.spawn({ ...opts, env: this.env });
  }
}

export function unconfinedBackend(opts: { project: string; env: NodeJS.ProcessEnv }): ExecBackend {
  return new UnconfinedBackend(chatEnv(opts.env, { project: opts.project }));
}

/** Whether the platform's confinement tool runs here: a trivial confined `true` must exit 0. A missing tool is none. */
export async function detectConfinement(
  exec: (bin: string, args: string[]) => Promise<{ code: number | null }>,
  platform: NodeJS.Platform = process.platform,
): Promise<Confinement | null> {
  const probe: [Confinement, string, string[]] | null =
    platform === "darwin"
      ? ["sandbox-exec", SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]]
      : platform === "linux"
        ? ["bwrap", "bwrap", ["--ro-bind", "/", "/", "/bin/true"]]
        : null;
  if (!probe) return null;
  try {
    return (await exec(probe[1], probe[2])).code === 0 ? probe[0] : null;
  } catch {
    return null;
  }
}

let available: Promise<Confinement | null> | undefined;

/** `detectConfinement` on this machine, asked once per process. */
export function confinementAvailable(): Promise<Confinement | null> {
  available ??= detectConfinement(async (bin, args) => {
    try {
      const child = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return { code: await child.exited };
    } catch {
      return { code: null }; // not installed
    }
  });
  return available;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
