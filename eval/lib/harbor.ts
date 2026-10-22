// eval/lib/harbor.ts — reads Terminal-Bench trials run by harbor (0.24.x) into the scoreboard's format.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrialResult } from "./runner";

interface HarborTiming {
  started_at?: string | null;
  finished_at?: string | null;
}

/** The parts of harbor's trial result.json the scoreboard uses. */
export interface HarborTrial {
  task_name: string;
  agent_info?: { name?: string; version?: string; model_info?: { name?: string } | null } | null;
  agent_result?: { n_input_tokens?: number | null; n_output_tokens?: number | null; cost_usd?: number | null } | null;
  verifier_result?: { rewards?: Record<string, number> | null } | null;
  exception_info?: { exception_type?: string; exception_message?: string } | null;
  started_at?: string | null;
  agent_execution?: HarborTiming | null;
}

/**
 * Exceptions harbor raises for the agent's own failures: a non-zero exit, API errors, timeouts.
 * They are failed trials; any other exception means the harness broke and the trial says nothing.
 */
const AGENT_FAILURE = /^(NonZeroAgentExitCode|Api\w*|OutputTokenExceeded|ContextWindowExceeded|AgentSafetyRefusal|UnknownApi|AgentTimeout)Error$/;

const seconds = (t: HarborTiming | null | undefined) =>
  t?.started_at && t.finished_at ? Math.round((Date.parse(t.finished_at) - Date.parse(t.started_at)) / 1000) : 0;

/** `agent` is our name for it ("tropos", "claude"); harbor calls Claude Code "claude-code". */
export function fromHarborTrial(trial: HarborTrial, opts: { runId: string; agent: string; effort: string | null; attempt: number }): TrialResult {
  const reward = trial.verifier_result?.rewards?.reward;
  const exception = trial.exception_info;
  const timedOut = /timeout/i.test(exception?.exception_type ?? "");
  return {
    runId: opts.runId,
    task: trial.task_name,
    split: "terminal-bench",
    agent: opts.agent,
    agentVersion: trial.agent_info?.version ?? "",
    model: trial.agent_info?.model_info?.name ?? "",
    effort: opts.effort,
    attempt: opts.attempt,
    startedAt: trial.started_at ?? "",
    agentSeconds: seconds(trial.agent_execution),
    agentExit: -1,
    timedOut,
    pass: reward !== undefined && reward >= 1,
    verifyExit: -1,
    verifyTail: "",
    diff: null,
    harnessError:
      exception && !timedOut && !AGENT_FAILURE.test(exception.exception_type ?? "")
        ? `${exception.exception_type}: ${exception.exception_message ?? ""}`.slice(0, 500)
        : null,
    isError: null,
    stop: null,
    turns: null,
    toolCalls: null,
    toolErrors: null,
    costUsd: trial.agent_result?.cost_usd ?? null,
    inputTokens: trial.agent_result?.n_input_tokens ?? null,
    outputTokens: trial.agent_result?.n_output_tokens ?? null,
  };
}

/** Every trial result.json under a harbor job directory, numbering repeat attempts per task. */
export async function readHarborJob(jobDir: string, opts: { runId: string; agent: string; effort: string | null }): Promise<TrialResult[]> {
  const entries = await readdir(jobDir, { withFileTypes: true });
  const trials: HarborTrial[] = [];
  for (const e of entries) {
    const file = join(jobDir, e.name, "result.json");
    if (e.isDirectory() && existsSync(file)) trials.push(JSON.parse(await readFile(file, "utf8")) as HarborTrial);
  }
  trials.sort((a, b) => a.task_name.localeCompare(b.task_name) || (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  const seen = new Map<string, number>();
  return trials.map((t) => {
    const attempt = (seen.get(t.task_name) ?? 0) + 1;
    seen.set(t.task_name, attempt);
    return fromHarborTrial(t, { ...opts, attempt });
  });
}
