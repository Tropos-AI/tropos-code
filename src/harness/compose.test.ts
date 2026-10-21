// src/harness/compose.test.ts
import { expect, test } from "bun:test";
import { FakeModel, reply, textBlock } from "../../test/helpers/fake-model";
import { compose, composerPrompt, select, selectorPrompt } from "./compose";
import type { LabTask, ProbeResult } from "./probe";
import type { Proposal } from "./propose";

const task: LabTask = { id: "t", title: "t", prompt: "Fix it.", repo: "/r", revision: "abc", domain: "ts-bun", checks: ["bun test"], split: "dev" };
const tree = new Map([["system.md", "You are T.\n"]]);

function probe(id: string, ok: boolean): ProbeResult {
  return {
    id, label: id, harness: [], finalText: "answer", seconds: 1, error: null,
    checks: [{ command: "bun test", ok, exit: ok ? 0 : 1, timedOut: false, tail: "", seconds: 1 }],
    audit: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] },
    signals: { turns: 5, toolCalls: 5, toolErrors: 0, filesWritten: 1, verifiedAfterLastEdit: ok, rereadWritten: 0, endReason: "end_turn", costUsd: 0 },
  };
}

const proposal = (role: Proposal["role"], changes: [string, string | null][]): Proposal => ({ role, observations: ["obs"], rationale: `why ${role}`, changes: new Map(changes), rejected: [], costUsd: 0 });
const llm = (text: string) => ({ model: new FakeModel([() => reply([textBlock(text)])]), id: "claude-opus-5-5", effort: "high" as const });
const signal = new AbortController().signal;

test("the composer sees each proposal's diff and run next to the reference", () => {
  const prompt = composerPrompt({
    task, tree, reference: probe("r-ref", false), referenceTrajectory: "T0",
    candidates: [
      { proposal: proposal("invariant", [["tool-guidance.md", "Test after editing.\n"]]), probe: probe("r-inv", true), trajectory: "T1" },
      { proposal: proposal("domain", []), probe: null, trajectory: "" },
    ],
  });
  expect(prompt).toContain('<proposal editor="invariant">\nRationale: why invariant');
  expect(prompt).toContain("+Test after editing.");
  expect(prompt).toContain('<run id="r-inv">');
  expect(prompt).toContain("(no changes)");
  expect(prompt).toContain("(not run: it changed nothing)");
});

test("compose keeps decisions and checked changes", async () => {
  const answer = JSON.stringify({ decisions: [{ decision: "keep the test rule", evidence: "r-inv passed" }, { nope: 1 }], rationale: "r", files: { "tool-guidance.md": "Test after editing.", "hooks.json": "{}" } });
  const c = await compose(llm(answer), { task, tree, reference: probe("r-ref", false), referenceTrajectory: "", candidates: [] }, signal);
  expect(c.decisions).toEqual([{ decision: "keep the test rule", evidence: "r-inv passed" }]);
  expect(c.changes).toEqual(new Map([["tool-guidance.md", "Test after editing."]]));
  expect(c.rejected).toEqual(["hooks.json: not the composer editor's to change"]);
  expect((await compose(llm("nothing"), { task, tree, reference: probe("r-ref", false), referenceTrajectory: "", candidates: [] }, signal)).error).toBeDefined();
});

test("the selector sees letters, not harnesses, and falls back to the best-ranked run", async () => {
  const options = [{ probe: probe("r-comp-1", true), patch: "+a" }, { probe: probe("r-comp-2", true), patch: "+b" }];
  const prompt = selectorPrompt(task, options);
  expect(prompt).toContain('<attempt label="A">');
  expect(prompt).toContain('<attempt label="B">');
  expect(prompt).not.toContain("r-comp");
  expect(await select(llm('{"choice":"b","reason":"smaller"}'), task, options, signal)).toMatchObject({ id: "r-comp-2", reason: "smaller" });
  expect((await select(llm('{"choice":"Z"}'), task, options, signal)).id).toBe("r-comp-1");
  expect(await select(llm("unused"), task, options.slice(0, 1), signal)).toEqual({ id: "r-comp-1", reason: "the only valid run", costUsd: 0 });
});
