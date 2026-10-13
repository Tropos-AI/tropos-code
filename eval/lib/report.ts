// eval/lib/report.ts
import type { TrialResult } from "./runner";

export interface Summary {
  agent: string;
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

/** One row per agent and split ("all" plus each split that has trials), harness errors included as failures. */
export function summarize(results: TrialResult[]): Summary[] {
  const groups = new Map<string, TrialResult[]>();
  for (const r of results) {
    for (const split of ["all", r.split]) {
      const key = `${r.agent}\u0000${split}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
  }
  const rows: Summary[] = [];
  for (const [key, trials] of groups) {
    const [agent, split] = key.split("\u0000") as [string, string];
    const solved = trials.filter((t) => t.pass).length;
    const costs = trials.map((t) => t.costUsd).filter((c): c is number => c !== null);
    const costUsd = costs.reduce((a, b) => a + b, 0);
    rows.push({
      agent,
      split,
      trials: trials.length,
      solved,
      passRate: solved / trials.length,
      costUsd,
      unknownCost: trials.length - costs.length,
      costPerSolved: solved > 0 ? costUsd / solved : null,
      medianSeconds: median(trials.filter((t) => !t.harnessError).map((t) => t.agentSeconds)),
      medianTurns: median(trials.map((t) => t.turns).filter((n): n is number => n !== null)),
      timeouts: trials.filter((t) => t.timedOut).length,
      harnessErrors: trials.filter((t) => t.harnessError).length,
      suspicious: trials.filter((t) => t.diff && (t.diff.testFilesTouched.length > 0 || t.diff.focusMarkers.length > 0)).length,
    });
  }
  const splitOrder = (s: string) => (s === "all" ? 0 : s === "dev" ? 1 : 2);
  return rows.sort((a, b) => a.agent.localeCompare(b.agent) || splitOrder(a.split) - splitOrder(b.split));
}

const usd = (n: number | null) => (n === null ? "–" : `$${n.toFixed(2)}`);
const plain = (n: number | null) => (n === null ? "–" : String(Math.round(n)));

export function renderMarkdown(results: TrialResult[]): string {
  const lines: string[] = [];
  const runs = [...new Set(results.map((r) => r.runId))];
  const versions = [...new Set(results.map((r) => `${r.agent} ${r.agentVersion || "?"} · ${r.model}${r.effort ? ` · effort ${r.effort}` : ""}`))];
  lines.push(`Runs: ${runs.join(", ")}`, "", ...versions.map((v) => `- ${v}`), "");
  lines.push("| agent | split | solved | pass rate | cost | cost / solved | median time | median turns | timeouts | harness errors | suspicious diffs |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summarize(results)) {
    const cost = s.unknownCost > 0 ? `${usd(s.costUsd)} + ${s.unknownCost} unknown` : usd(s.costUsd);
    lines.push(
      `| ${s.agent} | ${s.split} | ${s.solved}/${s.trials} | ${(s.passRate * 100).toFixed(0)}% | ${cost} | ${usd(s.costPerSolved)} | ${plain(s.medianSeconds)}s | ${plain(s.medianTurns)} | ${s.timeouts} | ${s.harnessErrors} | ${s.suspicious} |`,
    );
  }

  const agents = [...new Set(results.map((r) => r.agent))].sort();
  const tasks = [...new Set(results.map((r) => r.task))].sort();
  lines.push("", `| task | ${agents.join(" | ")} |`, `|---|${agents.map(() => "---").join("|")}|`);
  for (const task of tasks) {
    const cells = agents.map((agent) => {
      const trials = results.filter((r) => r.task === task && r.agent === agent);
      return trials.length ? `${trials.filter((t) => t.pass).length}/${trials.length}` : "–";
    });
    lines.push(`| ${task} | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
