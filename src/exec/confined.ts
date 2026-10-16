// src/exec/confined.ts — runs a chat's commands on the host, confined to its project by the OS: macOS sandbox-exec
// with the profile from sandbox-profile.ts, or Linux bubblewrap with the arguments from bwrap-args.ts.
//
// sandbox-exec execs the shell in place, so the child is the shell itself and process-group signals work exactly
// as in LocalBackend. bwrap runs under a small host `sh` wrapper (same process group). bwrap can't mask in advance a
// `.git/commondir` or a nested git dir that doesn't exist yet (the macOS profile can: its path denies apply to paths
// that don't exist), so the host checks for them after each command (git-integrity.ts): the wrapper reports bwrap's
// status on fd 3 and exits with the host's verdict; when the wrapper is killed first, the host checks on close.
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isInside } from "../paths";
import type { Confinement, CwdMarker, ExecBackend, ExecSpawn } from "./backend";
import { bwrapArgs } from "./bwrap-args";
import { ConfinementError, type ConfinementPaths, confinementPaths } from "./confinement-paths";
import { chatEnv } from "./env";
import { type CommondirSnapshot, commondirSnapshot, enforceCommondir, enforceNewGitDirs, type GitDirsSnapshot, gitDirsSnapshot } from "./git-integrity";
import { LocalBackend } from "./local";
import { type SandboxProfile, sandboxProfile } from "./sandbox-profile";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Where the confinement tool is looked up, and the only PATH its wrapper gets. Never the owner's PATH (`~/bin`,
 * `node_modules/.bin` …): a `bwrap` planted in a dir a confined command can write would run the next command bare.
 */
export const TRUSTED_PATH = "/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin";

/**
 * Runs bwrap (`"$@"`, without fd 3), reports its status to the host on fd 3 and exits with the host's answer; with
 * no answer (the host closed fd 3), with bwrap's own status.
 */
const WRAPPER = '"$@" 3>&-; status=$?; echo "$status" >&3; read -r verdict <&3 || verdict=$status; case $verdict in ""|*[!0-9]*) verdict=$status;; esac; exit "$verdict"';

export interface ConfinedBackendOptions {
  project: string;
  /** Tropos's home: denied to the command, except its workspace and the per-sandbox cache. */
  home: string;
  userHome: string;
  /** The owner's environment; the command gets only its allowlisted part (`chatEnv`). */
  env: NodeJS.ProcessEnv;
  /** For tests: the platform to confine for, and the bwrap binary (a path, or a name looked up on TRUSTED_PATH). */
  platform?: NodeJS.Platform;
  bwrapBin?: string;
}

/** The checks one bwrap command gets after it ran. */
interface PostRun {
  commondir: CommondirSnapshot | null;
  gitDirs: GitDirsSnapshot | null;
}

export class ConfinedBackend implements ExecBackend {
  readonly kind = "confined" as const;
  /** Signals, liveness and close work exactly as for a host command: the child leads the command's process group. */
  private readonly host = new LocalBackend();
  private readonly paths: ConfinementPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly profile: SandboxProfile | undefined;
  /** bwrap's real path, resolved once on TRUSTED_PATH (linux only). */
  private readonly bwrap: string = "";
  private readonly tempDir: string;

  constructor(opts: ConfinedBackendOptions) {
    const platform = opts.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      throw new ConfinementError(`Commands can't be confined on ${platform}: only macOS (sandbox-exec) and Linux (bwrap) are supported.`);
    }
    this.paths = confinementPaths({ project: opts.project, home: opts.home, userHome: opts.userHome, env: opts.env, platform });
    this.env = chatEnv(opts.env, { project: opts.project, troposHome: opts.home });
    // The marker must be writable inside: the confined temp dir when it is one of the writable paths, else the
    // system temp dir (always writable). Real paths, so the file is the same inside and on the host.
    const temp = realOr(opts.env.TMPDIR ?? tmpdir());
    this.tempDir = this.paths.writable.includes(temp) ? temp : realOr(platform === "darwin" ? "/private/tmp" : "/tmp");
    // Computed (and so refused, on a ConfinementError) once, here. bwrap's arguments are rebuilt per command (see
    // spawn); building them now still refuses a project that can't be confined before any command runs.
    if (platform === "darwin") this.profile = sandboxProfile(this.paths);
    else {
      this.bwrap = trustedBinary(opts.bwrapBin ?? "bwrap", [this.paths.project, this.paths.cacheDir, this.tempDir, ...this.paths.writable]);
      bwrapArgs(this.paths, this.paths.project);
    }
  }

  spawn(opts: ExecSpawn): ChildProcess {
    if (!this.profile) return this.spawnBwrap(opts, { cwd: opts.cwd, detached: true });
    const params = this.profile.params.flatMap(([k, v]) => ["-D", `${k}=${v}`]);
    return spawn(SANDBOX_EXEC, ["-p", this.profile.profile, ...params, opts.shell, "-c", opts.script], {
      cwd: opts.cwd,
      env: this.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /**
   * bwrap's arguments depend on the command's cwd (`--chdir`) and on the git dirs that exist now (a bind of one
   * removed since would stop every later command), so they are rebuilt for each command. The wrapper and bwrap get
   * only TRUSTED_PATH; the command gets the chat environment through `--setenv`.
   */
  private spawnBwrap(opts: ExecSpawn, options: { cwd: string; detached: boolean }): ChildProcess {
    const hostEnv = { PATH: TRUSTED_PATH };
    let args: string[];
    try {
      args = bwrapArgs(this.paths, opts.cwd);
    } catch (err) {
      // The repo changed into something that can't be confined (a linked .git): fail the command, never run it bare.
      const message = `tropos sandbox: ${(err as Error).message}`;
      return spawn("/bin/sh", ["-c", 'echo "$1" >&2; exit 126', "tropos-confined", message], { ...options, env: hostEnv, stdio: ["ignore", "pipe", "pipe"] });
    }
    const setenv = Object.entries(this.env).flatMap(([k, v]) => (v === undefined ? [] : ["--setenv", k, v]));
    // Taken before the command runs: the `commondir`s and nested git dirs that don't exist, so can't be bound read-only.
    const git = join(this.paths.project, ".git");
    const gitDirs = gitDirsSnapshot(git);
    const post: PostRun = { commondir: commondirSnapshot(git, [git, ...(gitDirs?.gitDirs ?? [])]), gitDirs };
    const child = spawn("/bin/sh", ["-c", WRAPPER, "tropos-confined", this.bwrap, ...args, ...setenv, "--", opts.shell, "-c", opts.script], {
      ...options,
      env: hostEnv,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    // Each message is the host's own, so it is always reported when the host acted: the command's output can't be
    // trusted to say whether it already was. Both listeners come before bash.ts's, so the message lands in the
    // command's stderr before its result is read.
    let checked = false;
    const check = (): string | null => {
      checked = true;
      return postRunMessage(post);
    };
    const control = child.stdio[3] as Socket | null;
    if (control) {
      let line = "";
      control.on("error", () => {});
      control.on("data", (chunk: Buffer | string) => {
        if (checked) return;
        line += String(chunk);
        if (!line.includes("\n")) return;
        // bwrap has returned, so nothing in the sandbox still runs: the check can't race the command.
        const message = check();
        if (message) child.stderr?.emit("data", `\n${message}\n`);
        const status = Number.parseInt(line, 10);
        control.end(`${message ? 1 : Number.isInteger(status) ? status : 1}\n`);
      });
    }
    // The wrapper was killed before it could report: check on the host anyway.
    child.once("close", () => {
      if (checked) return;
      const message = check();
      if (message) child.stderr?.emit("data", `\n${message}\n`);
    });
    return child;
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
    const path = findExecutable(bin);
    if (!path) return { code: null }; // not installed
    try {
      const child = Bun.spawn([path, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { PATH: TRUSTED_PATH } });
      return { code: await child.exited };
    } catch {
      return { code: null }; // not installed
    }
  });
  return available;
}

/** Undoes what a bwrap command planted in `.git` (see git-integrity.ts); the message to fail it with, or null. */
function postRunMessage(post: PostRun): string | null {
  const messages: string[] = [];
  try {
    if (post.commondir) messages.push(enforceCommondir(post.commondir).message ?? "");
    if (post.gitDirs) messages.push(enforceNewGitDirs(post.gitDirs).message ?? "");
  } catch {
    // project gone; nothing to undo
  }
  const text = messages.filter(Boolean).join("\n");
  return text === "" ? null : text;
}

/** `name` itself when it is a path, else its first match on TRUSTED_PATH; null when not an executable file. */
function findExecutable(name: string): string | null {
  const candidates = isAbsolute(name) ? [name] : TRUSTED_PATH.split(":").map((dir) => join(dir, name));
  return (
    candidates.find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** An executable on TRUSTED_PATH (or a given path), by its real path; refused when a confined command could write it. */
function trustedBinary(name: string, writable: readonly string[]): string {
  const found = findExecutable(name);
  if (!found) throw new ConfinementError(`${name} was not found on ${TRUSTED_PATH}.`);
  const real = realpathSync(found);
  if (writable.some((dir) => isInside(real, dir))) throw new ConfinementError(`${real} can't be trusted to confine commands: a confined command could replace it.`);
  return real;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
