// src/gateway/cron/store.ts — jobs and run history on disk. Shared by the daemon, the CLI and the Cron tool, so every
// change re-reads the file first and writes it atomically (synchronously, so one process never interleaves).
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstRun } from "./schedule";
import { jobSchema, type CronJob, type RunRecord } from "./types";

export const RUNS_ROTATE_BYTES = 5 * 1024 * 1024;
export const SUMMARY_CHARS = 500;

export type NewJob = Pick<CronJob, "name" | "schedule" | "prompt"> & Partial<Omit<CronJob, "id" | "createdAt">>;

export class CronStoreError extends Error {}

export class CronStore {
  readonly dir: string;
  readonly jobsPath: string;
  readonly runsPath: string;

  constructor(
    home: string,
    private readonly opts: { rotateBytes?: number; now?: () => number } = {},
  ) {
    this.dir = join(home, "gateway", "cron");
    this.jobsPath = join(this.dir, "jobs.json");
    this.runsPath = join(this.dir, "runs.jsonl");
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Modification time of jobs.json, 0 when it doesn't exist. */
  mtimeMs(): number {
    try {
      return statSync(this.jobsPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  list(): CronJob[] {
    let text: string;
    try {
      text = readFileSync(this.jobsPath, "utf8");
    } catch {
      return [];
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // Keep the unreadable file for the owner instead of overwriting it with the next save.
      try {
        renameSync(this.jobsPath, `${this.jobsPath}.corrupt-${this.now()}`);
      } catch {
        /* another process got there first */
      }
      return [];
    }
    const items = (raw as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(items)) return [];
    const jobs: CronJob[] = [];
    for (const item of items) {
      const parsed = jobSchema.safeParse(item);
      if (parsed.success && !jobs.some((j) => j.id === parsed.data.id)) jobs.push(parsed.data);
    }
    return jobs;
  }

  get(id: string): CronJob | undefined {
    return this.list().find((j) => j.id === id);
  }

  /** The job with this id, or the only one whose id starts with it. Throws when the prefix is ambiguous. */
  find(idOrPrefix: string): CronJob | undefined {
    const jobs = this.list();
    const exact = jobs.find((j) => j.id === idOrPrefix);
    if (exact) return exact;
    if (!idOrPrefix) return undefined;
    const hits = jobs.filter((j) => j.id.startsWith(idOrPrefix));
    if (hits.length > 1) throw new CronStoreError(`"${idOrPrefix}" matches ${hits.length} jobs: ${hits.map((j) => j.id).join(", ")}`);
    return hits[0];
  }

  add(input: NewJob): CronJob {
    const jobs = this.list();
    let id = randomBytes(4).toString("hex");
    while (jobs.some((j) => j.id === id)) id = randomBytes(4).toString("hex");
    const createdAt = this.now();
    const job = jobSchema.parse({ nextRunAt: firstRun(input.schedule, createdAt), ...input, id, createdAt });
    this.save([...jobs, job]);
    return job;
  }

  update(id: string, patch: Partial<Omit<CronJob, "id">>): CronJob | undefined {
    const jobs = this.list();
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0) return undefined;
    const merged = { ...jobs[i]!, ...patch, id };
    // An explicit undefined clears an optional field.
    for (const k of Object.keys(merged) as (keyof CronJob)[]) if (merged[k] === undefined) delete merged[k];
    const job = jobSchema.parse(merged);
    jobs[i] = job;
    this.save(jobs);
    return job;
  }

  remove(id: string): boolean {
    const jobs = this.list();
    const rest = jobs.filter((j) => j.id !== id);
    if (rest.length === jobs.length) return false;
    this.save(rest);
    return true;
  }

  setEnabled(id: string, enabled: boolean): CronJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    // Enabling starts counting from now: runs missed while it was off are not owed.
    return this.update(id, enabled ? { enabled, nextRunAt: firstRun(job.schedule, this.now()) } : { enabled });
  }

  private save(jobs: CronJob[]): void {
    this.ensureDir();
    const tmp = `${this.jobsPath}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.jobsPath);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  appendRun(record: RunRecord): void {
    this.ensureDir();
    const clipped: RunRecord = { ...record, summary: record.summary.slice(0, SUMMARY_CHARS) };
    try {
      if (statSync(this.runsPath).size >= (this.opts.rotateBytes ?? RUNS_ROTATE_BYTES)) renameSync(this.runsPath, `${this.runsPath}.1`);
    } catch {
      /* no file yet */
    }
    const fresh = !existsSync(this.runsPath);
    appendFileSync(this.runsPath, `${JSON.stringify(clipped)}\n`, { mode: 0o600 });
    if (fresh) chmodSync(this.runsPath, 0o600);
  }

  /** The newest runs of a job first, reading the rotated file too when needed. */
  runs(jobId: string, limit = 20): RunRecord[] {
    const out: RunRecord[] = [];
    for (const path of [this.runsPath, `${this.runsPath}.1`]) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i]!;
        if (!line) continue;
        try {
          const r = JSON.parse(line) as RunRecord;
          if (r.jobId === jobId && typeof r.runId === "string") out.push(r);
        } catch {
          /* a torn last line */
        }
      }
      if (out.length >= limit) break;
    }
    return out;
  }
}
