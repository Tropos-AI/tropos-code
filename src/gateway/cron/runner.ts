// src/gateway/cron/runner.ts — how the daemon runs a scheduled job: a fresh session in the job's project, nobody to ask.
import type { AgentEvent, PermissionPrompt } from "../../agent/events";
import { sendLedger, type SendLedger } from "../../messages/burst";
import { MESSAGES_TOOL } from "../../messages/messages-tool";
import { SEND_TOOL } from "../../messages/send-tool";
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
 * A scheduled run has nobody to approve anything. Its session carries its project's autonomy (at `balanced`, read-only
 * commands and pinned tests run unasked); whatever still asks is denied here unless the job lists it (`allowCommands`,
 * e.g. "Bash(npm test:*)"), and then only for a command inside the project. A guest's job never gets this.
 *
 * Texts are opt-in per job (a scheduled session always asks for them, src/gateway/policy.ts): `Messages` reads only for
 * a job that lists a `Messages` rule, and `SendIMessage` sends only to a recipient the job names exactly, as in
 * `SendIMessage(+306912345678)`; a bare or wildcard rule names nobody, since a job that reads texts could be talked
 * into texting anyone. The recipient is the prompt's `target`, the one the tool worked out and the permission check
 * used, never re-read from the input. A send the burst guard would ask about again is denied, nobody being here to answer.
 */
export function allowedByJob(
  prompt: PermissionPrompt,
  job: CronJob,
  cwd: string,
  home: string,
  opts: { ledger?: Pick<SendLedger, "check">; now?: number } = {},
): boolean {
  if (!job.allowCommands?.length) return false;
  const { rules } = compileRules({ allow: job.allowCommands, ask: [], deny: [] });
  if (prompt.toolName === MESSAGES_TOOL) return rules.allow.some((rule) => rule.tool === MESSAGES_TOOL);
  if (prompt.toolName === SEND_TOOL) {
    const target = prompt.target;
    if (target === undefined) return false;
    const named = rules.allow.filter((rule) => rule.tool === SEND_TOOL && rule.pattern !== undefined && !rule.pattern.includes("*"));
    const permission = { mode: "default" as const, rules: { allow: named, ask: [], deny: [] }, cwd, home, allowedDirs: [cwd], confine: true };
    if (decide({ toolName: SEND_TOOL, kind: "exec", paths: [], target }, permission).behavior !== "allow") return false;
    const burst = (opts.ledger ?? sendLedger).check(target, opts.now ?? Date.now());
    return burst.ask === undefined && burst.refuse === undefined;
  }
  if (prompt.toolName !== "Bash") return false;
  const command = (prompt.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
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
    const untrusted = untrustedJob(job, await deps.ownerChat?.());
    const session = await deps.openSession(job.project, { untrusted });
    await session.clear();
    let last = "";
    const detach = session.attach({
      event: (e: AgentEvent) => {
        if (e.type === "assistant") {
          const text = assistantText(e.message);
          if (text) last = text;
        }
      },
      // A guest's job never widens what it may run: its allowCommands are the guest's own words.
      ask: (id, prompt) => session.answer(id, !untrusted && allowedByJob(prompt, job, cwd, deps.home) ? { kind: "allow" } : { kind: "deny", message: "No one is here to approve this scheduled run." }),
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
