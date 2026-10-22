// eval/lib/harness-report.test.ts
import { expect, test } from "bun:test";
import { renderMeasurement, taskOutcomes, type Measurement } from "./harness-report";

const m = (task: string, harness: Measurement["harness"], pass: boolean, attempt = 1): Measurement => ({ task, split: "holdout", harness, attempt, pass, checks: 0, turns: 10, toolErrors: 0, costUsd: 0.01, error: null });

test("per task: which harness solved it, at least half the attempts", () => {
  const rows = [
    m("a", "built-in", true), m("a", "built-in", true, 2), m("a", "trained", true), m("a", "trained", false, 2),
    m("b", "built-in", false), m("b", "built-in", false, 2), m("b", "trained", true), m("b", "trained", false, 2),
    m("c", "built-in", true), m("c", "built-in", false, 2), m("c", "trained", false), m("c", "trained", false, 2),
    m("d", "built-in", false), m("d", "trained", false),
  ];
  expect(taskOutcomes(rows)).toEqual([
    { task: "a", builtIn: "2/2", trained: "1/2", outcome: "both" },
    { task: "b", builtIn: "0/2", trained: "1/2", outcome: "only trained" },
    { task: "c", builtIn: "1/2", trained: "0/2", outcome: "only built-in" },
    { task: "d", builtIn: "0/1", trained: "0/1", outcome: "neither" },
  ]);
  const md = renderMeasurement("x", rows, 2);
  expect(md).toContain("(4 tasks × 2 attempts)");
  expect(md).toContain("both 1, only built-in 1, only trained 1, neither 1");
  expect(md).toContain("| b | 0/2 | 1/2 | only trained |");
  expect(md).toContain("| built-in | 3/7 |");
});
