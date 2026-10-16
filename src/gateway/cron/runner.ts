// src/gateway/cron/runner.ts — how the daemon runs a scheduled job: a fresh session in the job's project, nobody to ask.
import type { AgentEvent, PermissionPrompt } from "../../agent/events";
import { compileRules, decide } from "../../permissions/engine";
import type { ChatSession } from "../types";
import { assistantText } from "../telegram/render";
import type { CronDeps, CronJob } from "./types";

export interface JobRunnerDeps {
  /**
   * A session in a project (a project id) that the runner may `clear()` for a fresh start; an untrusted one (a job
   * from a guest's chat) is recorded as a guest's, so its output never reaches the owner's sessions through search.
   */
  openSession(projectId: string, opts?: { untrusted?: boolean }): Promise<ChatSession>;
  /** The owner's chat key, when there is an owner. Without it, every job made in a chat is untrusted. */
  ownerChat?(): Promise<string | undefined>;
  /** The project's directory, for the permission context; undefined when the project is gone. */
  projectPath(projectId: string): Promise<string | undefined>;
  home: string;
}

/**
 * A scheduled run has nobody to approve anything: a request is allowed only when the job lists a rule for it
 * (`allowCommands`, e.g. "Bash(npm test:*)"), and then only for a command inside the sandbox. Everything else is denied.
 */
export function allowedByJob(prompt: PermissionPrompt, job: CronJob, cwd: string, home: string): boolean {
  if (!job.allowCommands?.length || prompt.toolName !== "Bash") return false;
  const command = (prompt.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  const { rules } = compileRules({ allow: job.allowCommands, ask: [], deny: [] });
  return decide({ toolName: "Bash", kind: "exec", command, paths: [] }, { mode: "default", rules, cwd, home, allowedDirs: [cwd], confine: true }).behavior === "allow";
}

/** A job made in (or, for older jobs without an origin, delivering to) a chat that isn't the owner's. */
export function untrustedJob(job: CronJob, ownerChat: string | undefined): boolean {
  const from = job.origin ?? (job.deliver !== "none" ? job.deliver : undefined);
  return from !== undefined && from !== ownerChat;
}

export function createJobRunner(deps: JobRunnerDeps): CronDeps["runJob"] {
  // Two jobs of one project share its session, so they take turns.
  const tails = new Map<string, Promise<unknown>>();

  const runOnce = async (job: CronJob, signal: AbortSignal): Promise<{ text: string }> => {
    const cwd = await deps.projectPath(job.project);
    if (!cwd) throw new Error(`The project "${job.project}" doesn't exist any more.`);
    const session = await deps.openSession(job.project, { untrusted: untrustedJob(job, await deps.ownerChat?.()) });
    await session.clear();
    let last = "";
    const detach = session.attach({
      event: (e: AgentEvent) => {
        if (e.type === "assistant") {
          const text = assistantText(e.message);
          if (text) last = text;
        }
      },
      ask: (id, prompt) => session.answer(id, allowedByJob(prompt, job, cwd, deps.home) ? { kind: "allow" } : { kind: "deny", message: "No one is here to approve this scheduled run." }),
      askClosed: () => {},
      state: () => {},
    });
    const stop = () => session.interrupt();
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) throw new Error("stopped before it began");
      const reason = await session.prompt(job.prompt);
      if (reason === "aborted") throw new Error("stopped");
      if (reason !== "end_turn") throw new Error(`the run ended early (${reason})`);
      return { text: last || "(no output)" };
    } finally {
      signal.removeEventListener("abort", stop);
      detach();
    }
  };

  return (job, signal) => {
    const before = tails.get(job.project) ?? Promise.resolve();
    const run = before.then(() => runOnce(job, signal), () => runOnce(job, signal));
    tails.set(job.project, run.catch(() => {}));
    return run;
  };
}
