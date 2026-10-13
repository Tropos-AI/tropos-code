// eval/lib/report.test.ts
import { expect, test } from "bun:test";
import { renderMarkdown, summarize } from "./report";
import type { TrialResult } from "./runner";

function trial(over: Partial<TrialResult>): TrialResult {
  return {
    runId: "r1", task: "t1", split: "dev", agent: "tropos", agentVersion: "0.1.0", model: "claude-opus-5-5", effort: "high", attempt: 1,
    startedAt: "", agentSeconds: 100, agentExit: 0, timedOut: false, pass: true, verifyExit: 0, verifyTail: "",
    diff: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], focusMarkers: [] }, harnessError: null,
    isError: false, stop: "end_turn", turns: 10, costUsd: 1, inputTokens: 1, outputTokens: 1,
    ...over,
  };
}

const results = [
  trial({}),
  trial({ task: "t2", pass: false, costUsd: 3, agentSeconds: 300, turns: 30, timedOut: true }),
  trial({ task: "t3", split: "holdout", costUsd: null, diff: { files: 1, insertions: 1, deletions: 0, testFilesTouched: ["a.test.ts"], focusMarkers: [] } }),
  trial({ agent: "claude", effort: null, pass: false, costUsd: 2, harnessError: "docker died", agentSeconds: 0 }),
];

test("summarize per agent and split", () => {
  const rows = summarize(results);
  expect(rows.map((r) => `${r.agent}/${r.split}`)).toEqual(["claude/all", "claude/dev", "tropos/all", "tropos/dev", "tropos/holdout"]);
  const all = rows.find((r) => r.agent === "tropos" && r.split === "all")!;
  expect(all).toMatchObject({ trials: 3, solved: 2, costUsd: 4, unknownCost: 1, costPerSolved: 2, medianSeconds: 100, medianTurns: 10, timeouts: 1, suspicious: 1 });
  expect(all.passRate).toBeCloseTo(2 / 3);
  const c = rows.find((r) => r.agent === "claude" && r.split === "all")!;
  expect(c).toMatchObject({ solved: 0, costPerSolved: null, harnessErrors: 1, medianSeconds: null });
});

test("markdown has the scoreboard and the per-task grid", () => {
  const md = renderMarkdown(results);
  expect(md).toContain("| tropos | all | 2/3 | 67% | $4.00 + 1 unknown | $2.00 | 100s | 10 | 1 | 0 | 1 |");
  expect(md).toContain("| claude | all | 0/1 | 0% | $2.00 | – |");
  expect(md).toContain("| t1 | 0/1 | 1/1 |");
  expect(md).toContain("| t3 | – | 1/1 |");
  expect(md).toContain("- tropos 0.1.0 · claude-opus-5-5 · effort high");
});
