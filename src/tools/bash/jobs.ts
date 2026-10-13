// src/tools/bash/jobs.ts
import type { ChildProcess } from "node:child_process";
import { OutputBuffer } from "./output-buffer";

/** Unread output kept per stream between two reads; the middle is dropped beyond this. */
const UNREAD_LIMIT = 15_000;
const KILL_GRACE_MS = 5_000;
const POLL_MS = 25;

export type JobStatus =
  | { state: "running" }
  | { state: "exited"; code: number }
  | { state: "killed"; signal: string }
  | { state: "failed"; error: string };

interface Job {
  id: string;
  command: string;
  child: ChildProcess;
  status: JobStatus;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  /** Resolves once the shell has exited (or failed to start). */
  exited: Promise<void>;
  /** Resolves once the shell has exited and its output streams have closed. */
  settled: Promise<void>;
}

export function describeStatus(status: JobStatus): string {
  switch (status.state) {
    case "running":
      return "running";
    case "exited":
      return `exited with code ${status.code}`;
    case "killed":
      return `killed by ${status.signal}`;
    case "failed":
      return `failed to start: ${status.error}`;
  }
}

const SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGTERM"];

/**
 * Background shell jobs of one session. Each job runs in its own process group so it can be killed
 * whole; its output is collected until read. Jobs never keep Tropos alive, and every job still
 * running is sent SIGTERM when Tropos exits or is hung up on.
 */
export class JobTable {
  private readonly jobs = new Map<string, Job>();
  private nextId = 1;
  private watching = false;
  private readonly onExit = () => this.killAll();
  private readonly onSignal = (sig: NodeJS.Signals) => {
    this.killAll();
    // Nobody else handles it: fall back to the default action, which our listener had replaced.
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  };

  constructor(private readonly limit = UNREAD_LIMIT) {}

  /** Takes over a spawned, detached child with piped stdout/stderr and returns its job id. */
  add(command: string, child: ChildProcess): string {
    const id = `bash-${this.nextId++}`;
    let exitedResolve!: () => void;
    const exited = new Promise<void>((resolve) => (exitedResolve = resolve));
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const job: Job = {
      id,
      command,
      child,
      status: { state: "running" },
      stdout: new OutputBuffer(this.limit),
      stderr: new OutputBuffer(this.limit),
      exited,
      settled: Promise.all([exited, closed]).then(() => {}),
    };
    child.once("exit", (code, signal) => {
      job.status = signal ? { state: "killed", signal } : { state: "exited", code: code ?? 0 };
      exitedResolve();
    });
    // A child that fails to spawn emits "error" instead of "exit" (and "close" after it).
    child.once("error", (err) => {
      job.status = { state: "failed", error: err.message };
      exitedResolve();
    });
    for (const [stream, buffer] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) {
      stream?.setEncoding("utf8").on("data", (d: string) => job[buffer].push(d));
      (stream as unknown as { unref?: () => void } | null)?.unref?.();
    }
    child.unref();
    this.jobs.set(id, job);
    this.watch();
    return id;
  }

  /** Output since the last read, and the job's status. Undefined for an unknown id. */
  read(id: string): { command: string; status: JobStatus; stdout: string; stderr: string } | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const result = { command: job.command, status: job.status, stdout: job.stdout.toString(), stderr: job.stderr.toString() };
    job.stdout = new OutputBuffer(this.limit);
    job.stderr = new OutputBuffer(this.limit);
    return result;
  }

  /** Unread stdout without consuming it. */
  peek(id: string): string | undefined {
    return this.jobs.get(id)?.stdout.toString();
  }

  pid(id: string): number | undefined {
    return this.jobs.get(id)?.child.pid;
  }

  /** Resolves once the job has exited and all of its output is in. */
  settled(id: string): Promise<void> {
    return this.jobs.get(id)?.settled ?? Promise.resolve();
  }

  list(): Array<{ id: string; command: string; status: JobStatus }> {
    return [...this.jobs.values()].map((j) => ({ id: j.id, command: j.command, status: j.status }));
  }

  /** SIGTERM to the job's process group, SIGKILL if anything is left after `graceMs`. Undefined for an unknown id. */
  async kill(id: string, graceMs = KILL_GRACE_MS): Promise<JobStatus | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const pid = job.child.pid;
    if (pid !== undefined && groupAlive(pid)) {
      signalGroup(pid, "SIGTERM");
      if (!(await waitForGroupExit(pid, graceMs))) {
        signalGroup(pid, "SIGKILL");
        await waitForGroupExit(pid, 1_000);
      }
    }
    await Promise.race([job.exited, Bun.sleep(1_000)]);
    return job.status;
  }

  /** Synchronous so it can run from an exit handler: SIGTERM to every job's process group. */
  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.child.pid !== undefined) signalGroup(job.child.pid, "SIGTERM");
    }
    this.unwatch();
  }

  private watch(): void {
    if (this.watching) return;
    this.watching = true;
    process.on("exit", this.onExit);
    for (const sig of SIGNALS) process.on(sig, this.onSignal);
  }

  private unwatch(): void {
    if (!this.watching) return;
    this.watching = false;
    process.off("exit", this.onExit);
    for (const sig of SIGNALS) process.off(sig, this.onSignal);
  }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // already gone
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGroupExit(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= end) return false;
    await Bun.sleep(POLL_MS);
  }
  return true;
}
