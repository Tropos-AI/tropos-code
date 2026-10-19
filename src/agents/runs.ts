// src/agents/runs.ts
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One delegation to a subagent or specialist; the log feeds the curator, the dashboard and the review. */
export interface DelegationRun {
  ts: string;
  agent: string;
  specialist: boolean;
  task: string;
  ok: boolean;
  result: string;
  durationMs: number;
  costUsd?: number;
  cwd: string;
}

export const MAX_RUNS_KEPT = 2000;
const TASK_CHARS = 120;
const RESULT_CHARS = 200;
const FOOTER = /\s*\([^()\n]* · [^()\n]*\)\s*$/;

const logPath = (home: string): string => join(home, "learning", "delegations.jsonl");

/** The report's first 200 chars, without the "(name · n tool uses · n turns)" footer. */
export function runResult(report: string): string {
  return report.replace(FOOTER, "").trim().slice(0, RESULT_CHARS);
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim().length > 0);
}

export async function recordRun(home: string, run: DelegationRun): Promise<void> {
  const path = logPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ...run, task: run.task.slice(0, TASK_CHARS), result: runResult(run.result) });
  await appendFile(path, `${line}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  const all = lines(await readFile(path, "utf8").catch(() => ""));
  if (all.length <= MAX_RUNS_KEPT) return;
  // Trimmed through a temp file so a crash never leaves a half-written log.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${all.slice(-MAX_RUNS_KEPT).join("\n")}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Newest first. A torn or foreign line is skipped. `since` is epoch ms. */
export async function readRuns(home: string, opts: { agent?: string; since?: number; limit?: number } = {}): Promise<DelegationRun[]> {
  const text = await readFile(logPath(home), "utf8").catch(() => "");
  const out: DelegationRun[] = [];
  for (const line of lines(text).reverse()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const r = raw as Partial<DelegationRun> | null;
    if (!r || typeof r.ts !== "string" || typeof r.agent !== "string" || typeof r.task !== "string") continue;
    if (opts.agent !== undefined && r.agent !== opts.agent) continue;
    if (opts.since !== undefined && !(Date.parse(r.ts) >= opts.since)) continue;
    out.push(r as DelegationRun);
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
}
