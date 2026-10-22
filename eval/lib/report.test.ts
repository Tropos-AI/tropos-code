// eval/lib/report.test.ts
import { expect, test } from "bun:test";
import { renderMarkdown, summarize } from "./report";
import type { TrialResult } from "./runner";

function trial(over: Partial<TrialResult>): TrialResult {
  return {
    runId: "r1", task: "t1", split: "dev", agent: "tropos", agentVersion: "0.1.0", model: "claude-opus-5-5", effort: "high", attempt: 1,
    startedAt: "", agentSeconds: 100, agentExit: 0, timedOut: false, pass: true, verifyExit: 0, verifyTail: "",
    diff: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] }, harnessError: null,
    isError: false, stop: "end_turn", turns: 10, toolCalls: 20, toolErrors: 2, costUsd: 1, inputTokens: 1, outputTokens: 1,
    ...over,
  };
}

const results = [
  trial({}),
  trial({ task: "t2", pass: false, costUsd: 3, agentSeconds: 300, turns: 30, timedOut: true }),
  trial({ task: "t3", split: "holdout", costUsd: null, diff: { files: 1, insertions: 1, deletions: 1, testFilesTouched: ["a.test.ts"], testFilesEdited: ["a.test.ts"], focusMarkers: [] } }),
  trial({ agent: "claude", effort: null, pass: false, costUsd: 2, harnessError: "docker died", agentSeconds: 0 }),
];

test("summarize per agent and split", () => {
  const rows = summarize(results);
  expect(rows.map((r) => `${r.agent}/${r.split}`)).toEqual(["claude/all", "claude/dev", "tropos/all", "tropos/dev", "tropos/holdout"]);
  const all = rows.find((r) => r.agent === "tropos" && r.split === "all")!;
  expect(all).toMatchObject({ trials: 3, solved: 2, costUsd: 4, unknownCost: 1, costPerSolved: 2, medianSeconds: 100, medianTurns: 10, timeouts: 1, suspicious: 1, toolErrorRate: 0.1, attemptSd: null, mixedTasks: 0 });
  expect(all.passRate).toBeCloseTo(2 / 3);
  const c = rows.find((r) => r.agent === "claude" && r.split === "all")!;
  expect(c).toMatchObject({ solved: 0, costPerSolved: null, harnessErrors: 1, medianSeconds: null });
});

test("markdown has the scoreboard and the per-task grid", () => {
  const md = renderMarkdown(results);
  expect(md).toContain("| tropos | claude-opus-5-5 | all | 2/3 | 67% | – | 0 | $4.00 + 1 unknown | $2.00 | 100s | 10 | 10% | 1 | 0 | 1 |");
  expect(md).toContain("| claude | claude-opus-5-5 | all | 0/1 | 0% | – | 0 | $2.00 | – |");
  expect(md).toContain("| task | claude · claude-opus-5-5 | tropos · claude-opus-5-5 |");
  expect(md).toContain("| t1 | 0/1 | 1/1 |");
  expect(md).toContain("| t3 | – | 1/1 |");
  expect(md).toContain("- tropos 0.1.0 · claude-opus-5-5 · effort high");
});

test("attempts give the noise: pass-rate spread between attempts and tasks that flip", () => {
  const runs = [
    trial({ attempt: 1 }), trial({ task: "t2", attempt: 1 }),
    trial({ attempt: 2 }), trial({ task: "t2", attempt: 2, pass: false }),
    trial({ attempt: 3, pass: false }), trial({ task: "t2", attempt: 3, pass: false }),
  ];
  const row = summarize(runs).find((r) => r.split === "all")!;
  // Attempt pass rates 1, 0.5, 0: sample sd 0.5.
  expect(row.attemptSd).toBeCloseTo(0.5);
  expect(row.mixedTasks).toBe(2);
  expect(renderMarkdown(runs)).toContain("| 3/6 |");
  expect(renderMarkdown(runs)).toContain("| 50% | ±50.0 | 2 |");
});

test("models get their own rows and columns, and old results without tool counts still render", () => {
  const old = { ...trial({ model: "deepseek/deepseek-chat" }) } as Partial<TrialResult>;
  delete old.toolCalls;
  delete old.toolErrors;
  const rows = summarize([trial({}), old as TrialResult]);
  expect(rows.filter((r) => r.split === "all").map((r) => r.model)).toEqual(["claude-opus-5-5", "deepseek/deepseek-chat"]);
  expect(rows.find((r) => r.model === "deepseek/deepseek-chat")!.toolErrorRate).toBeNull();
});

test("adding tests isn't suspicious; weakening them is, and results from before the split still count every touch", () => {
  const added = trial({ diff: { files: 1, insertions: 9, deletions: 0, testFilesTouched: ["a.test.ts"], testFilesEdited: [], focusMarkers: [] } });
  const old = trial({ diff: { files: 1, insertions: 9, deletions: 0, testFilesTouched: ["a.test.ts"], focusMarkers: [] } as unknown as TrialResult["diff"] });
  expect(summarize([added])[0]!.suspicious).toBe(0);
  expect(summarize([old])[0]!.suspicious).toBe(1);
});
