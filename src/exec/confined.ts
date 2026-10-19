// src/exec/confined.ts — runs a chat's commands on the host, confined to its project by the OS: macOS sandbox-exec
// with the profile from sandbox-profile.ts, or Linux bubblewrap with the arguments from bwrap-args.ts.
//
// Both run under a small host `sh` wrapper that leads the command's process group, so signals work as in
// LocalBackend. Neither confinement can stop everything in `.git` in advance: bwrap can't mask a `commondir` or a
// nested git dir that doesn't exist yet, and the macOS profile matches resolved paths, so a `.git/modules` link to a
// writable dir slips past it. So the host checks (git-integrity.ts), with the same code on both: when the confined
// shell returns (the wrapper reports its status on fd 3 and exits with the host's verdict), when the command's output
// closes (also when the wrapper was killed), before every later spawn while a command (a background job) still runs,
// and in close(). Residuals: a nested repo or `gitdir:` file in the working tree (`lib/.git`); and an owner's host
// git run while a chat background job is alive can see what it planted after the last check.
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isInside } from "../paths";
import type { Confinement, CwdMarker, ExecBackend, ExecSpawn } from "./backend";
import { bwrapArgs } from "./bwrap-args";
import { ConfinementError, type ConfinementPaths, confinementPaths } from "./confinement-paths";
import { chatEnv } from "./env";
import {
  type CommondirSnapshot,
  commondirSnapshot,
  enforceCommondir,
  enforceNewGitDirs,
  type GitDirsSnapshot,
  gitDirsSnapshot,
  ensureHooksDir,
  gitMetadataUnsafe,
  hooksDirRequired,
  OWNER_HOOK_LINKS,
  writableLinks,
} from "./git-integrity";
import { LocalBackend } from "./local";
import { type SandboxProfile, sandboxProfile } from "./sandbox-profile";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const ENV = "/usr/bin/env";

/**
 * Where the confinement tool is looked up, and the only PATH its wrapper gets. Never the owner's PATH (`~/bin`,
 * `node_modules/.bin` …): a `bwrap` planted in a dir a confined command can write would run the next command bare.
 */
export const TRUSTED_PATH = "/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin";

/**
 * Runs the confinement tool (`"$@"`, without fd 3), reports its status to the host on fd 3 and exits with the host's
 * answer; with no answer (the host closed fd 3), with the tool's own status.
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
  /** The session isn't the owner's: the workspace's instruction files are read-only (ConfinementPaths.instructionFiles). */
  protectInstructions?: boolean;
  /** The owner's other projects, whose `.env` files the command may not read (ConfinementPaths.otherProjectSecrets). */
  otherProjects?: readonly string[];
}

/** The checks one command gets after it ran. */
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
  /** Real paths a confined command can write: a link in `.git` into one of them is never trusted. */
  private readonly sandboxWritable: string[];
  /**
   * The `.git` state last verified while no confined command of this backend ran. Every check compares against it;
   * it is only re-taken when nothing runs, so what a background job plants is never absorbed into it.
   */
  private baseline: PostRun = { commondir: null, gitDirs: null };
  /** Started commands whose process group may still run something, with how each reports a finding. */
  private readonly running = new Map<ChildProcess, (message: string | null) => void>();
  private readonly closed = new WeakSet<ChildProcess>();
  /**
   * Links into sandbox-writable paths that were in `.git` before this backend ran anything: the owner's, so never
   * removed. While any is left, commands are refused instead. Null until the first baseline; it only shrinks.
   */
  private ownerLinks: Set<string> | null = null;
  /**
   * Everything a check reported unsafe and left in place. A later baseline could absorb it (its git dir becomes
   * known), so it is checked on its own and fails every command until the owner removes it.
   */
  private readonly tainted = new Set<string>();

  constructor(opts: ConfinedBackendOptions) {
    const platform = opts.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      throw new ConfinementError(`Commands can't be confined on ${platform}: only macOS (sandbox-exec) and Linux (bwrap) are supported.`);
    }
    this.paths = confinementPaths({ project: opts.project, home: opts.home, userHome: opts.userHome, env: opts.env, platform, protectInstructions: opts.protectInstructions, otherProjects: opts.otherProjects });
    this.env = chatEnv(opts.env, { project: opts.project, troposHome: opts.home });
    // The marker must be writable inside: the confined temp dir when it is one of the writable paths, else the
    // system temp dir (always writable). Real paths, so the file is the same inside and on the host.
    const temp = realOr(opts.env.TMPDIR ?? tmpdir());
    this.tempDir = this.paths.writable.includes(temp) ? temp : realOr(platform === "darwin" ? "/private/tmp" : "/tmp");
    // Computed (and so refused, on a ConfinementError) once, here. bwrap's arguments are rebuilt per command (see
    // spawn); building them now still refuses a project that can't be confined before any command runs.
    this.sandboxWritable = [...new Set([this.paths.project, this.paths.cacheDir, this.tempDir, ...this.paths.writable])];
    if (platform === "darwin") this.profile = sandboxProfile(this.paths);
    else {
      this.bwrap = trustedBinary(opts.bwrapBin ?? "bwrap", this.sandboxWritable);
      bwrapArgs(this.paths, this.paths.project);
    }
  }

  /**
   * Both confinements run under the same host wrapper and the same post-run checks. The wrapper (and the tool) get
   * only TRUSTED_PATH; the command gets the chat environment, through `env -i` (sandbox-exec) or `--setenv` (bwrap).
   * sandbox-exec and env exec in place, so the shell stays in the wrapper's process group, as bwrap's sandbox does.
   */
  spawn(opts: ExecSpawn): ChildProcess {
    const options = { cwd: opts.cwd, env: { PATH: TRUSTED_PATH }, detached: true };
    // Before it runs: with nothing confined running, the current `.git` becomes the baseline (the owner's own changes
    // since included); one that can't be read fails the command closed. Otherwise something still running (a
    // background job) may have planted since the last check, so this command first gets that check, and its result
    // reports what it found.
    let pre: string | null = null;
    if (this.anyRunning()) pre = this.verify();
    else {
      try {
        this.baseline = this.snapshot();
      } catch (err) {
        return failed(gitUncheckable(reason(err)), options);
      }
      const links = this.baseline.gitDirs ? writableLinks(this.baseline.gitDirs) : [];
      const owner: Set<string> = this.ownerLinks ?? new Set(links);
      this.ownerLinks = new Set(links.filter((link) => owner.has(link)));
      if (this.ownerLinks.size > 0) {
        return failed(`tropos sandbox: ${OWNER_HOOK_LINKS}\nLinked: ${[...this.ownerLinks].join(", ")}`, options);
      }
      // The clean-up's quarantine needs a `.git/hooks` no confined command can write; never anywhere else.
      const git = this.baseline.gitDirs?.gitRoot;
      if (git && !ensureHooksDir(git)) return failed(hooksDirRequired(join(git, "hooks")), options);
    }
    const vars = Object.entries(this.env).filter((entry): entry is [string, string] => entry[1] !== undefined);
    let command: string[];
    if (this.profile) {
      const params = this.profile.params.flatMap(([k, v]) => ["-D", `${k}=${v}`]);
      command = [ENV, "-i", ...vars.map(([k, v]) => `${k}=${v}`), SANDBOX_EXEC, "-p", this.profile.profile, ...params, opts.shell, "-c", opts.script];
    } else {
      try {
        // Rebuilt per command, after the check above: they depend on the cwd (`--chdir`) and on the git dirs that
        // exist now (a bind of hooks that check just removed would stop the command).
        command = [this.bwrap, ...bwrapArgs(this.paths, opts.cwd), ...vars.flatMap(([k, v]) => ["--setenv", k, v]), "--", opts.shell, "-c", opts.script];
      } catch (err) {
        // The repo changed into something that can't be confined (a linked .git): fail the command, never run it bare,
        // and still report what the check before it found.
        return failed([pre, `tropos sandbox: ${(err as Error).message}`].filter(Boolean).join("\n"), options);
      }
    }
    const child = spawn("/bin/sh", ["-c", WRAPPER, "tropos-confined", ...command], { ...options, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    // Each message is the host's own, so it is always reported when the host acted: the command's output can't be
    // trusted to say whether it already was. Both listeners come before bash.ts's, so the message lands in the
    // command's stderr before its result is read. A repeat of the last message (a leftover reported as unsafe) is not.
    let last: string | null = null;
    let pending = pre; // the pre-spawn finding, until it is reported
    const report = (found: string | null): string | null => {
      const message = [pending, found].filter(Boolean).join("\n") || null;
      pending = null;
      if (message && message !== last) child.stderr?.emit("data", `\n${message}\n`);
      if (message) last = message;
      return message;
    };
    this.running.set(child, (message) => void report(message));
    let answered = false;
    const control = child.stdio[3] as Socket | null;
    if (control) {
      let line = "";
      control.on("error", () => {});
      control.on("data", (chunk: Buffer | string) => {
        if (answered) return;
        line += String(chunk);
        if (!line.includes("\n")) return;
        answered = true;
        // The confined shell has returned. Anything it left running in the background (and any background job) may
        // still plant: that is checked again on this command's close, before every later spawn and in close().
        const message = report(this.verify());
        const status = Number.parseInt(line, 10);
        control.end(`${message ? 1 : Number.isInteger(status) ? status : 1}\n`);
      });
    }
    // Every holder of the command's output is gone, or the wrapper was killed before it could report: check again.
    child.once("close", () => {
      report(this.verify());
      this.closed.add(child);
    });
    return child;
  }

  /**
   * Whether a command this backend started may still run something; forgets the ones that are over. Tracked by
   * process group. Residual (ruled): on macOS a process that calls setsid leaves its group, so it can outlive this
   * tracking and plant after the baseline is re-taken; the writable-link rule and the profile's .git write denies
   * still apply to it. On Linux the pid namespace ends with bwrap.
   */
  private anyRunning(): boolean {
    for (const child of this.running.keys()) {
      if (this.closed.has(child) && !this.host.alive(child)) this.running.delete(child);
    }
    return this.running.size > 0;
  }

  /**
   * The `.git` state now; both parts null when there is no real `.git` (nothing to check). Throws when `.git` is
   * there but can't be read: a check that silently saw nothing would let a command's changes through.
   */
  private snapshot(): PostRun {
    const git = join(this.paths.project, ".git");
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(git);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { commondir: null, gitDirs: null };
      throw err;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return { commondir: null, gitDirs: null };
    const gitDirs = gitDirsSnapshot(git, { writable: this.sandboxWritable });
    const commondir = gitDirs && commondirSnapshot(git, [git, ...gitDirs.gitDirs]);
    if (!gitDirs || !commondir) throw new Error("it could not be read");
    return { commondir, gitDirs };
  }

  /**
   * What the checks compare against. A `.git` absent at the baseline that is there now (bwrap leaves its empty
   * placeholder on the host) is checked as all new: nothing in it is known. Its hooks dir is made sure of first, for
   * the quarantine (no running command can see into it: bwrap covered it with the placeholder, the profile denies it).
   */
  private checkAgainst(): PostRun {
    if (this.baseline.gitDirs) return this.baseline;
    const now = this.snapshot();
    if (!now.gitDirs || !now.commondir) return now;
    if (!ensureHooksDir(now.gitDirs.gitRoot)) throw new Error(`${join(now.gitDirs.gitRoot, "hooks")} is not a real directory`);
    return {
      commondir: { ...now.commondir, gitDirs: [now.commondir.gitRoot], present: new Set() },
      gitDirs: { ...now.gitDirs, gitDirs: [], known: new Set() },
    };
  }

  /** Undoes what was planted in `.git` since the baseline; the message to report, or null. */
  private verify(): string | null {
    let result: { message: string | null; unsafe: string[] };
    try {
      result = postRun(this.checkAgainst());
    } catch (err) {
      result = { message: gitUncheckable(reason(err)), unsafe: [] };
    }
    const git = join(this.paths.project, ".git");
    // The overflow marker (`.git` itself) is not tainted: every search recomputes it.
    for (const path of result.unsafe) if (path !== git) this.tainted.add(path);
    const lines = result.message ? [result.message] : [];
    for (const path of this.tainted) {
      if (!existsOrUnknown(path)) this.tainted.delete(path);
      else if (!result.unsafe.includes(path)) lines.push(gitMetadataUnsafe(path));
    }
    return lines.length > 0 ? lines.join("\n") : null;
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

  /**
   * A command still running gets one more check here, and the commands still running get its finding. Their exit
   * codes were already fixed when their confined shells returned, so a finding here can only be added to their stderr.
   */
  close(): Promise<void> {
    if (this.anyRunning()) {
      const message = this.verify();
      for (const report of this.running.values()) report(message);
    }
    return this.host.close();
  }
}

export function confinedBackend(opts: { project: string; home: string; userHome: string; env: NodeJS.ProcessEnv; protectInstructions?: boolean; otherProjects?: readonly string[] }): ExecBackend {
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

/** A command that only prints why it was refused and exits 126; nothing confined runs. */
function failed(message: string, options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }): ChildProcess {
  return spawn("/bin/sh", ["-c", 'echo "$1" >&2; exit 126', "tropos-confined", message], { ...options, stdio: ["ignore", "pipe", "pipe"] });
}

/** Why `.git` can't be checked; the command fails rather than let what it did there go unseen. */
export const gitUncheckable = (why: string): string => `tropos sandbox: .git could not be checked (${why}), so the command failed; try again`;

function reason(err: unknown): string {
  return err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.message) : String(err);
}

/** Undoes what a command planted in `.git` (see git-integrity.ts): the message to fail it with, and what was left. */
function postRun(post: PostRun): { message: string | null; unsafe: string[] } {
  const messages: string[] = [];
  const unsafe: string[] = [];
  for (const check of [() => (post.commondir ? enforceCommondir(post.commondir) : null), () => (post.gitDirs ? enforceNewGitDirs(post.gitDirs) : null)]) {
    try {
      const result = check();
      if (result?.message) messages.push(result.message);
      if (result) unsafe.push(...result.unsafe);
    } catch (err) {
      messages.push(gitUncheckable(reason(err))); // fail closed: a check that didn't finish may have missed something
    }
  }
  return { message: messages.length > 0 ? messages.join("\n") : null, unsafe };
}

/** Whether something is at `path` (not following a last link); true when that can't be told. */
function existsOrUnknown(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
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
