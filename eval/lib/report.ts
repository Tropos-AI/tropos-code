// eval/lib/report.ts
import type { TrialResult } from "./runner";

export interface Summary {
  agent: string;
  model: string;
  split: string;
  trials: number;
  solved: number;
  passRate: number;
  /** Sum of the costs agents reported; trials with no reported cost are counted in unknownCost. */
  costUsd: number;
  unknownCost: number;
  /** Total cost divided by solved trials; null when nothing was solved. */
  costPerSolved: number | null;
  medianSeconds: number | null;
  medianTurns: number | null;
  /** Failed tool calls over finished ones, across trials that reported both; null when none did. */
  toolErrorRate: number | null;
  /** Standard deviation of the pass rate between attempts (attempt 1 over all tasks, attempt 2 …); null under two attempts. */
  attemptSd: number | null;
  /** Tasks some attempts solved and others didn't: where the noise is. */
  mixedTasks: number;
  timeouts: number;
  harnessErrors: number;
  /** Trials whose diff edited or deleted test files, or added .skip/.only/.todo. */
  suspicious: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1));
}

function groupBy<T>(items: T[], key: (item: T) => string | number): Map<string | number, T[]> {
  const groups = new Map<string | number, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function toolErrorRate(trials: TrialResult[]): number | null {
  // Results written before tool calls were counted lack the fields altogether.
  let calls = 0;
  let errors = 0;
  for (const t of trials) {
    if (typeof t.toolCalls !== "number" || typeof t.toolErrors !== "number") continue;
    calls += t.toolCalls;
    errors += t.toolErrors;
  }
  return calls > 0 ? errors / calls : null;
}

/** One row per agent, model and split ("all" plus each split that has trials), harness errors included as failures. */
export function summarize(results: TrialResult[]): Summary[] {
  const groups = new Map<string, TrialResult[]>();
  for (const r of results) {
    for (const split of ["all", r.split]) {
      const key = `${r.agent}\u0000${r.model}\u0000${split}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
  }
  const rows: Summary[] = [];
  for (const [key, trials] of groups) {
    const [agent, model, split] = key.split("\u0000") as [string, string, string];
    const solved = trials.filter((t) => t.pass).length;
    const costs = trials.map((t) => t.costUsd).filter((c): c is number => c !== null);
    const costUsd = costs.reduce((a, b) => a + b, 0);
    const byAttempt = [...groupBy(trials, (t) => t.attempt).values()].map((ts) => ts.filter((t) => t.pass).length / ts.length);
    const mixedTasks = [...groupBy(trials, (t) => t.task).values()].filter((ts) => ts.some((t) => t.pass) && ts.some((t) => !t.pass)).length;
    rows.push({
      agent,
      model,
      split,
      trials: trials.length,
      solved,
      passRate: solved / trials.length,
      costUsd,
      unknownCost: trials.length - costs.length,
      costPerSolved: solved > 0 ? costUsd / solved : null,
      medianSeconds: median(trials.filter((t) => !t.harnessError).map((t) => t.agentSeconds)),
      medianTurns: median(trials.map((t) => t.turns).filter((n): n is number => n !== null)),
      toolErrorRate: toolErrorRate(trials),
      attemptSd: sampleSd(byAttempt),
      mixedTasks,
      timeouts: trials.filter((t) => t.timedOut).length,
      harnessErrors: trials.filter((t) => t.harnessError).length,
      suspicious: trials.filter((t) => t.diff && (t.diff.testFilesTouched.length > 0 || t.diff.focusMarkers.length > 0)).length,
    });
  }
  const splitOrder = (s: string) => (s === "all" ? 0 : s === "dev" ? 1 : 2);
  return rows.sort((a, b) => a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model) || splitOrder(a.split) - splitOrder(b.split));
}

const usd = (n: number | null) => (n === null ? "–" : `$${n.toFixed(2)}`);
const plain = (n: number | null) => (n === null ? "–" : String(Math.round(n)));
const pct = (n: number | null) => (n === null ? "–" : `${(n * 100).toFixed(0)}%`);
/** Percentage points, the unit pass-rate differences are read in. */
const points = (n: number | null) => (n === null ? "–" : `±${(n * 100).toFixed(1)}`);

export function renderMarkdown(results: TrialResult[]): string {
  const lines: string[] = [];
  const runs = [...new Set(results.map((r) => r.runId))];
  const versions = [...new Set(results.map((r) => `${r.agent} ${r.agentVersion || "?"} · ${r.model}${r.effort ? ` · effort ${r.effort}` : ""}`))];
  lines.push(`Runs: ${runs.join(", ")}`, "", ...versions.map((v) => `- ${v}`), "");
  lines.push(
    "| agent | model | split | solved | pass rate | attempt sd | mixed tasks | cost | cost / solved | median time | median turns | tool errors | timeouts | harness errors | suspicious diffs |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summarize(results)) {
    const cost = s.unknownCost > 0 ? `${usd(s.costUsd)} + ${s.unknownCost} unknown` : usd(s.costUsd);
    lines.push(
      `| ${s.agent} | ${s.model} | ${s.split} | ${s.solved}/${s.trials} | ${pct(s.passRate)} | ${points(s.attemptSd)} | ${s.mixedTasks} | ${cost} | ${usd(s.costPerSolved)} | ${plain(s.medianSeconds)}s | ${plain(s.medianTurns)} | ${pct(s.toolErrorRate)} | ${s.timeouts} | ${s.harnessErrors} | ${s.suspicious} |`,
    );
  }

  // One column per agent and model, so two models' attempts never share a cell.
  const label = (r: TrialResult) => `${r.agent} · ${r.model}`;
  const columns = [...new Set(results.map(label))].sort();
  const tasks = [...new Set(results.map((r) => r.task))].sort();
  lines.push("", `| task | ${columns.join(" | ")} |`, `|---|${columns.map(() => "---").join("|")}|`);
  for (const task of tasks) {
    const cells = columns.map((column) => {
      const trials = results.filter((r) => r.task === task && label(r) === column);
      return trials.length ? `${trials.filter((t) => t.pass).length}/${trials.length}` : "–";
    });
    lines.push(`| ${task} | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
