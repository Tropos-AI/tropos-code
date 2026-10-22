// src/harness/gate.test.ts
import { expect, test } from "bun:test";
import { checksPassed, compareProbes, rankProbes } from "./gate";
import type { ProbeResult } from "./probe";

const check = (ok: boolean) => ({ command: "bun test", ok, exit: ok ? 0 : 1, timedOut: false, tail: "", seconds: 1 });

function probe(id: string, over: Partial<Omit<ProbeResult, "signals">> & { signals?: Partial<ProbeResult["signals"]> } = {}): ProbeResult {
  return {
    id, label: id, harness: [], finalText: "", seconds: 1, error: null,
    checks: [check(true), check(false)],
    audit: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] },
    ...over,
    signals: { turns: 20, toolCalls: 30, toolErrors: 2, filesWritten: 1, verifiedAfterLastEdit: false, rereadWritten: 0, endReason: "end_turn", costUsd: 0.1, ...over.signals },
  };
}

const ref = probe("ref");

test("more passing checks wins even with more steps; fewer loses", () => {
  expect(compareProbes(ref, probe("c", { checks: [check(true), check(true)], signals: { turns: 40 } }))).toEqual({
    outcome: "better",
    reasons: ["checks passed 1 → 2", "turns 20 → 40"],
  });
  expect(compareProbes(ref, probe("c", { checks: [check(false), check(false)], signals: { turns: 10 } })).outcome).toBe("worse");
});

test("with equal checks, how the agent worked decides", () => {
  expect(compareProbes(ref, probe("c", { signals: { verifiedAfterLastEdit: true, turns: 15 } }))).toEqual({
    outcome: "better",
    reasons: ["checked its work after the last change; the reference didn't", "turns 20 → 15"],
  });
  expect(compareProbes(ref, probe("c", { signals: { toolErrors: 5 } })).outcome).toBe("worse");
  expect(compareProbes(ref, probe("c", { signals: { turns: 19, toolErrors: 3 } }))).toEqual({ outcome: "same", reasons: [] });
  // Better on one count, worse on another: not an improvement.
  expect(compareProbes(ref, probe("c", { signals: { verifiedAfterLastEdit: true, toolErrors: 6 } })).outcome).toBe("same");
  expect(compareProbes(ref, probe("c", { signals: { endReason: "max_turns" } })).outcome).toBe("worse");
});

test("a run that failed or weakened tests is invalid, whatever it scored", () => {
  expect(compareProbes(ref, probe("c", { error: "setup failed" }))).toEqual({ outcome: "invalid", reasons: ["c failed to run: setup failed"] });
  const cheat = probe("c", {
    checks: [check(true), check(true)],
    audit: { files: 1, insertions: 1, deletions: 1, testFilesTouched: ["a.test.ts"], testFilesEdited: ["a.test.ts"], focusMarkers: [] },
  });
  expect(compareProbes(ref, cheat)).toEqual({ outcome: "invalid", reasons: ["c weakened tests (a.test.ts)"] });
});

test("rankProbes puts valid, passing, finished, checked, clean, short runs first", () => {
  const a = probe("a", { error: "x", checks: [check(true), check(true)] });
  const b = probe("b", { checks: [check(true), check(true)], signals: { turns: 30 } });
  const c = probe("c", { checks: [check(true), check(true)], signals: { turns: 10 } });
  const d = probe("d");
  expect(rankProbes([a, b, c, d]).map((p) => p.id)).toEqual(["c", "b", "d", "a"]);
  expect(checksPassed(d)).toBe(1);
});
