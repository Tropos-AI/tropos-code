// src/exec/backend.ts — where Bash-tool commands run: on the host, or in a sandbox.
import type { ChildProcess } from "node:child_process";

/** The OS facility that confines a host command to its project: macOS sandbox-exec or Linux bubblewrap. */
export type Confinement = "sandbox-exec" | "bwrap";

export interface ExecSpawn {
  /** The POSIX shell to run (`ctx.shell`); a sandbox may substitute its own. */
  shell: string;
  /** The full script, passed as `-c`. */
  script: string;
  /** Where the command starts; always inside the project. */
  cwd: string;
  /** The environment the command gets. The local backend uses it as is; a sandbox starts from an empty one. */
  env: NodeJS.ProcessEnv;
  /** A background job (run_in_background): while one runs, a sandbox that excludes file tools refuses them rather than wait. */
  background?: boolean;
}

/**
 * A file the script writes its final directory to, so the tool can track `cd`. `inside` is the path as the
 * script sees it, `host` the same file as the tool reads it.
 */
export interface CwdMarker {
  inside: string;
  host: string;
}

export interface ExecBackend {
  readonly kind: "local" | "docker" | "confined";
  /**
   * Starts the script. The child is detached, with stdin ignored and stdout/stderr piped, and it can be
   * handed to the job table: the same contract as `child_process.spawn` has had in bash.ts.
   */
  spawn(opts: ExecSpawn): ChildProcess;
  /** A fresh marker for one command; `id` is unique per call. */
  cwdMarker(id: string): CwdMarker;
  /** Signals the command a `spawn` started, and everything it started. Never throws. */
  signal(child: ChildProcess, sig: NodeJS.Signals): void;
  /** Whether the command (or anything it started) is still running. */
  alive(child: ChildProcess): boolean;
  /** Releases what the backend holds (a container); idempotent. */
  close(): Promise<void>;
  /**
   * Called after each command: stops whatever finished commands left running, so nothing in the sandbox can swap a
   * folder for a link while a file tool opens a file. Resolves to why that can't be done right now (a background
   * command still running), else undefined. Unset: the backend doesn't need it.
   */
  quiesce?(): Promise<string | undefined>;
  /**
   * Held by a host-side file tool for as long as it works on the project: waits for commands running in the
   * foreground (until `signal` aborts), refuses while a background job runs, quiesces, and commands started while it
   * is held wait until it is released. Unset: nothing to exclude.
   */
  holdForFiles?(signal?: AbortSignal): Promise<FilesHold>;
}

/** A file tool's hold on the sandbox (release it once, when done), or why the tool can't act now. */
export type FilesHold = { ok: true; release: () => void } | { ok: false; reason: string };
