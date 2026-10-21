// eval/lib/runner.ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AgentReport, AgentRun } from "./agents";
import { Container } from "./docker";
import type { Task } from "./task";
import { auditDiff, createWorkspace, taskRepo, type DiffAudit } from "./workspace";

const WORK = "/work";
const SETUP_TIMEOUT_SEC = 600;
const VERIFY_TIMEOUT_SEC = 600;
const TAIL_CHARS = 4000;

const tail = (s: string) => (s.length > TAIL_CHARS ? `…${s.slice(-TAIL_CHARS)}` : s);

export interface TrialResult extends AgentReport {
  runId: string;
  task: string;
  /** "dev" or "holdout" for private tasks, "terminal-bench" for Terminal-Bench trials. */
  split: string;
  agent: string;
  agentVersion: string;
  model: string;
  effort: string | null;
  attempt: number;
  startedAt: string;
  agentSeconds: number;
  agentExit: number;
  timedOut: boolean;
  pass: boolean;
  verifyExit: number;
  verifyTail: string;
  diff: DiffAudit | null;
  /** Set when the harness itself failed (setup, Docker); such a trial counts as a failure. */
  harnessError: string | null;
}

export interface TrialOptions {
  runId: string;
  image: string;
  harnessRoot: string;
  scratch: string;
  /** Linux build of tropos for the container's architecture. */
  troposBinary: string;
  attempt: number;
  run: AgentRun;
  /** Environment for the agent only, e.g. { DEEPSEEK_API_KEY: "…" }; passed by name, never on a command line. */
  secrets: Record<string, string>;
}

/** Copies the hidden tests over the workspace and runs `verify` with the network off. */
async function verify(container: Container, task: Task): Promise<{ pass: boolean; exit: number; tail: string }> {
  await container.disconnectNetwork();
  await container.copyIn(join(task.dir, "hidden"), WORK);
  const r = await container.exec(task.verify, { cwd: WORK, timeoutSec: VERIFY_TIMEOUT_SEC });
  return { pass: r.exitCode === 0 && !r.timedOut, exit: r.exitCode, tail: tail(r.stdout + r.stderr) };
}

async function withWorkspace<T>(task: Task, revision: string, opts: { image: string; harnessRoot: string; scratch: string; name: string }, body: (c: Container) => Promise<T>): Promise<T> {
  const host = join(opts.scratch, opts.name);
  let container: Container | undefined;
  try {
    await createWorkspace(taskRepo(task, opts.harnessRoot), revision, host);
    container = await Container.start(opts.image, opts.name);
    await container.copyIn(host, WORK);
    return await body(container);
  } finally {
    await container?.remove();
    await rm(host, { recursive: true, force: true });
  }
}

async function setup(container: Container, task: Task): Promise<void> {
  if (!task.setup) return;
  const r = await container.exec(task.setup, { cwd: WORK, timeoutSec: SETUP_TIMEOUT_SEC });
  if (r.exitCode !== 0) throw new Error(`setup failed (${r.exitCode}${r.timedOut ? ", timed out" : ""}): ${tail(r.stderr || r.stdout)}`);
}

/** One attempt of one agent on one task. Never throws: harness failures are recorded on the result. */
export async function runTrial(task: Task, agent: AgentAdapter, opts: TrialOptions): Promise<TrialResult> {
  const result: TrialResult = {
    runId: opts.runId,
    task: task.id,
    split: task.split,
    agent: agent.name,
    agentVersion: "",
    model: opts.run.model,
    effort: opts.run.effort ?? null,
    attempt: opts.attempt,
    startedAt: new Date().toISOString(),
    agentSeconds: 0,
    agentExit: -1,
    timedOut: false,
    pass: false,
    verifyExit: -1,
    verifyTail: "",
    diff: null,
    harnessError: null,
    isError: null,
    stop: null,
    turns: null,
    toolCalls: null,
    toolErrors: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
  };
  const name = `tcode-eval-${opts.runId}-${task.id}-${agent.name}-${opts.attempt}`;
  try {
    await withWorkspace(task, task.base, { ...opts, name }, async (container) => {
      await container.copyFileIn(opts.troposBinary, "/usr/local/bin/tropos");
      await setup(container, task);
      result.agentVersion = (await container.exec(agent.versionCommand, { cwd: WORK, timeoutSec: 60 })).stdout.trim();

      const ran = await container.exec(agent.command(opts.run), {
        cwd: WORK,
        timeoutSec: task.timeoutSec,
        env: { PROMPT: task.prompt, ...opts.secrets },
      });
      Object.assign(result, agent.parse(ran.stdout));
      result.agentSeconds = Math.round(ran.seconds);
      result.agentExit = ran.exitCode;
      result.timedOut = ran.timedOut;

      // Stop anything the agent left running before judging the result.
      await container.exec("pkill -KILL -u agent || true", { cwd: WORK, timeoutSec: 30, user: "root" });
      await container.exec("git add -A", { cwd: WORK, timeoutSec: 60 });
      const numstat = await container.exec("git diff --cached --no-renames --numstat", { cwd: WORK, timeoutSec: 60 });
      const patch = await container.exec("git diff --cached --no-renames -U0", { cwd: WORK, timeoutSec: 60 });
      result.diff = auditDiff(numstat.stdout, patch.stdout);

      const v = await verify(container, task);
      result.pass = v.pass;
      result.verifyExit = v.exit;
      result.verifyTail = v.tail;
    });
  } catch (e) {
    result.harnessError = (e as Error).message;
    result.pass = false;
  }
  return result;
}

export interface Validation {
  task: string;
  /** The hidden tests must fail on the base commit... */
  failsAtBase: boolean;
  /** ...and pass once the real fix is in. */
  passesAtGold: boolean;
  baseTail: string;
  goldTail: string;
}

/** Checks a task is well-formed without running any agent: no API calls, no cost. */
export async function validateTask(task: Task, opts: { image: string; harnessRoot: string; scratch: string; runId: string }): Promise<Validation> {
  const check = (revision: string, label: string) =>
    withWorkspace(task, revision, { ...opts, name: `tcode-eval-${opts.runId}-${task.id}-${label}` }, async (container) => {
      await setup(container, task);
      return verify(container, task);
    });
  const [base, gold] = await Promise.all([check(task.base, "base"), check(task.gold, "gold")]);
  return { task: task.id, failsAtBase: !base.pass, passesAtGold: gold.pass, baseTail: base.tail, goldTail: gold.tail };
}
