// src/doctor/types.ts — the shared shapes of the doctor.
import type { ProviderSetting } from "../config/settings";
import type { Project } from "../gateway/projects";
import type { ServiceStatus } from "../service/types";

export type Level = "ok" | "info" | "warn" | "error";

export interface Finding {
  /** Unique within a run: `<check id>` or `<check id>.<detail>`. */
  id: string;
  level: Level;
  message: string;
  detail?: string;
  /** A fix exists for this finding (applied only with --fix). */
  fixable?: boolean;
  /** The fix cannot lose data, so it may run without asking (chmod, removing a dead pid's state file). */
  safe?: boolean;
  fixed?: boolean;
  /** What the fix did (or why it failed), set when a fix was attempted. */
  fixMessage?: string;
  /** Set by the engine. */
  area?: string;
  /** What the check's fix needs; never holds secrets. */
  data?: Record<string, unknown>;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Everything a check does to the outside world besides reading files, so tests can fake it. */
export interface Runner {
  exec(cmd: string, args: string[], timeoutMs?: number): Promise<RunResult>;
  fetch: typeof fetch;
  pidAlive(pid: number): boolean;
  /** Model ids a provider offers, through the provider router (an authenticated listing call). */
  listModels(input: { home: string; env: NodeJS.ProcessEnv; settings: Record<string, ProviderSetting>; id: string; signal: AbortSignal }): Promise<string[]>;
  serviceStatus(): Promise<ServiceStatus>;
  listProjects(home: string): Promise<Project[]>;
  /** Removes sandbox containers whose owner process is gone; returns how many. */
  sweepContainers(): Promise<number>;
}

export interface DoctorEnv {
  home: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  deep: boolean;
  platform: NodeJS.Platform;
  now(): number;
  runner: Runner;
}

export interface FixResult {
  ok: boolean;
  message: string;
}

export interface Check {
  id: string;
  area: string;
  title: string;
  /** Only runs for `--only <its area>` (the security audit), not in a plain `tcode doctor`. */
  audit?: boolean;
  run(env: DoctorEnv): Promise<Finding[]>;
  fix?(finding: Finding, env: DoctorEnv): Promise<FixResult>;
}

export interface ReportSummary {
  ok: number;
  info: number;
  warn: number;
  error: number;
  fixed: number;
}

export interface Report {
  findings: Finding[];
  summary: ReportSummary;
}

export interface DoctorOptions {
  home: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** true: apply every fix; "safe": only findings marked safe. */
  fix?: boolean | "safe";
  /** Check ids or areas (`gateway`, `docker`, `install.link`). */
  only?: string | string[];
  deep?: boolean;
  now?: () => number;
  runner?: Partial<Runner>;
  checks?: Check[];
  platform?: NodeJS.Platform;
  /** Asked before each fix; false skips it. */
  confirm?: (finding: Finding, check: Check) => Promise<boolean>;
}
