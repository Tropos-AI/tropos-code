// src/gateway/cron/types.ts — the scheduler's contracts. Structural, so the daemon passes an adapter.
import { z } from "zod";
import { scheduleSchema } from "./schedule";

export const DEFAULT_MAX_RUNTIME_MS = 15 * 60_000;
/** A job through the harness lab runs its task four times or more. */
export const RECURSIVE_MAX_RUNTIME_MS = 3 * 3_600_000;

export const jobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  schedule: scheduleSchema,
  prompt: z.string().min(1),
  /** A project id from the registry. */
  project: z.string().min(1).default("default"),
  /** "none" or a chat key such as telegram:123. */
  deliver: z.string().min(1).default("none"),
  enabled: z.boolean().default(true),
  createdAt: z.number(),
  createdBy: z.enum(["user", "agent"]).default("user"),
  /** The chat a job was made in (a chat key); absent for the owner's terminal and dashboard, and older jobs. */
  origin: z.string().optional(),
  lastRunAt: z.number().optional(),
  lastStatus: z.enum(["ok", "error", "timeout", "skipped", "missed"]).optional(),
  nextRunAt: z.number().optional(),
  maxRuntimeMs: z.number().int().positive().optional(),
  /** Rule strings such as "Bash(npm test:*)" a scheduled run may use without asking. */
  allowCommands: z.array(z.string()).optional(),
  /**
   * Run through the harness lab with this many compositions (src/gateway/cron/harness-recursion.ts): four or more runs
   * of the task in confined copies, the best handed over as a branch. Owner jobs in git projects only.
   */
  harnessRecursion: z.number().int().min(1).max(5).optional(),
});
export type CronJob = z.infer<typeof jobSchema>;

export const RUN_STATUSES = ["ok", "error", "timeout", "skipped", "missed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunRecord {
  jobId: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  status: RunStatus;
  /** First 500 characters of the result. */
  summary: string;
  error?: string;
}

export interface CronDeps {
  home: string;
  /** Runs the job's prompt in a fresh channel-tier session of its project; rejects on failure; must stop when `signal` aborts. */
  runJob(job: CronJob, signal: AbortSignal): Promise<{ text: string }>;
  deliver(target: string, text: string): Promise<void>;
  now?(): number;
  log?(message: string): void;
}

/** Same shape as the daemon's GatewayService hook. */
export interface CronService {
  readonly name: "cron";
  start(deps: CronDeps): void | Promise<void>;
  stop(): void | Promise<void>;
  /** Runs a job now (id or unique prefix), whatever its schedule says. Rejects when it is already running. */
  runNow(idOrPrefix: string): Promise<RunRecord>;
  /** How many jobs are running now. */
  running(): number;
}
