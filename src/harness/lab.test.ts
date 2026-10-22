// src/harness/lab.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel, reply, textBlock } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { BASE_TREE } from "./base";
import { readCandidate } from "./candidates";
import { labDir, overlayOf, pruneLabRun, readLabRun, runLab, type LabOptions } from "./lab";
import type { LabTask, ProbeInput, ProbeResult, ProbeRunner } from "./probe";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("lab-");
});
afterEach(() => removeDir(home));

const task: LabTask = { id: "t1", title: "Fix the parser", prompt: "Fix it.", repo: "/r", revision: "abc", domain: "ts-bun", checks: ["bun test", "tsc"], split: "dev" };

/** Passes one check per rule it finds in the harness: "Run the tests." and "Type-check." */
class FakeRunner implements ProbeRunner {
  readonly inputs: ProbeInput[] = [];
  constructor(private readonly fail = false) {}
  async run(input: ProbeInput): Promise<ProbeResult> {
    this.inputs.push(input);
    const text = input.harnessFiles.map((f) => readFileSync(join(input.harnessDir, f), "utf8")).join("\n");
    const passes = [/Run the tests/.test(text), /Type-check/.test(text)];
    await writeFile(join(input.dir, "trajectory.jsonl"), `${JSON.stringify({ type: "assistant", content: [{ type: "text", text: `working ${input.label}` }] })}\n`);
    await writeFile(join(input.dir, "patch.diff"), `+change by ${input.label}\n`);
    return {
      id: input.id, label: input.label, harness: input.harnessFiles, finalText: "done", seconds: 1, error: this.fail ? "setup failed" : null,
      checks: task.checks.map((command, i) => ({ command, ok: passes[i]!, exit: passes[i] ? 0 : 1, timedOut: false, tail: "", seconds: 1 })),
      audit: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] },
      signals: { turns: 10, toolCalls: 10, toolErrors: 0, filesWritten: 1, verifiedAfterLastEdit: passes[0]!, rereadWritten: 0, endReason: "end_turn", costUsd: 0.01 },
    };
  }
}

const answer = (o: unknown) => () => reply([textBlock(JSON.stringify(o))]);
const nothing = answer({ observations: [], rationale: "", files: {} });

function options(runner: ProbeRunner, steps: (() => ReturnType<typeof reply>)[], over: Partial<LabOptions> = {}): LabOptions {
  return {
    home, runner, llm: { model: new FakeModel(steps), id: "claude-opus-5-5", effort: "high" }, model: "claude-haiku-5-5",
    base: BASE_TREE, scope: "global", k: 1, mode: "parallel", library: "", signal: new AbortController().signal,
    ...over,
  };
}

test("k=1: propose, probe, compose, probe; a better composition becomes a candidate", async () => {
  const runner = new FakeRunner();
  const run = await runLab(task, options(runner, [
    answer({ observations: ["ref never ran tests"], rationale: "verify", files: { "guardrails.md": "Run the tests." } }),
    nothing,
    answer({ decisions: [{ decision: "keep the test rule", evidence: "inv-1 passed bun test" }], rationale: "it helped", files: { "guardrails.md": "Run the tests." } }),
  ]));
  expect(run.probes.map((p) => p.label)).toEqual(["ref", "inv-1", "comp-1"]);
  expect(run.proposals.map((p) => [p.label, p.files])).toEqual([["inv-1", ["guardrails.md"]], ["dom-1", []]]);
  expect(run.verdict).toEqual({ outcome: "better", reasons: ["checks passed 0 → 1", "checked its work after the last change; the reference didn't"] });
  expect(run.candidate).toBe(run.id);
  expect(run.costUsd).toBeGreaterThan(0);
  const candidate = await readCandidate(home, run.id);
  expect(candidate).toMatchObject({ source: "lab", scope: "global", status: "pending", changes: { "guardrails.md": "Run the tests." }, decisions: [{ decision: "keep the test rule", evidence: "inv-1 passed bun test" }] });
  // The reference ran with the built-in harness only; every probe got its own folder.
  expect(runner.inputs[0]!.harnessFiles).toEqual([]);
  expect(runner.inputs[2]!.harnessFiles).toEqual(["guardrails.md"]);
  expect((await readLabRun(home, run.id))?.finishedAt).toBeDefined();
  await pruneLabRun(home, run.id);
  expect(existsSync(join(labDir(home, run.id), "ref"))).toBe(false);
  expect(existsSync(join(labDir(home, run.id), "run.json"))).toBe(true);
});

test("a composition that keeps the reference, or doesn't improve, makes no candidate", async () => {
  const kept = await runLab(task, options(new FakeRunner(), [answer({ files: { "tool-guidance.md": "Be brief." } }), nothing, answer({ decisions: [], files: {} })]));
  expect(kept.verdict).toEqual({ outcome: "same", reasons: ["no proposal changed the harness"] });
  expect(kept.candidate).toBeUndefined();
  const same = await runLab(task, options(new FakeRunner(), [nothing, nothing, answer({ files: { "tool-guidance.md": "Be brief." } })]));
  expect(same.verdict.outcome).toBe("same");
  expect(same.selected?.reason).toBe("best-ranked composition (not adopted)");
  expect(same.candidate).toBeUndefined();
});

test("a failed reference ends the run as invalid", async () => {
  const run = await runLab(task, options(new FakeRunner(true), []));
  expect(run.verdict).toEqual({ outcome: "invalid", reasons: ["the reference run failed: setup failed"] });
  expect(run.probes).toHaveLength(1);
});

test("parallel k=2: two compositions, the selector picks without knowing which", async () => {
  const run = await runLab(task, options(new FakeRunner(), [
    nothing, nothing, answer({ files: { "guardrails.md": "Run the tests." } }),
    nothing, nothing, answer({ files: { "guardrails.md": "Run the tests.\nType-check." } }),
    answer({ choice: "A", reason: "all checks pass" }),
  ], { k: 2 }));
  expect(run.probes.map((p) => p.label)).toEqual(["ref", "comp-1", "comp-2"]);
  // Ranked best first, so A is comp-2 (two checks).
  expect(run.selected).toEqual({ id: `${run.id}-comp-2`, reason: "all checks pass" });
  expect((await readCandidate(home, run.id))?.changes).toEqual({ "guardrails.md": "Run the tests.\nType-check." });
});

test("sequential k=2 builds the second step on the first", async () => {
  const runner = new FakeRunner();
  const run = await runLab(task, options(runner, [
    nothing, nothing, answer({ files: { "guardrails.md": "Run the tests." } }),
    nothing, nothing, answer({ files: { "tool-guidance.md": "Type-check." } }),
  ], { k: 2, mode: "sequential" }));
  expect(run.probes.map((p) => p.label)).toEqual(["ref", "comp-1", "comp-2"]);
  expect(runner.inputs[2]!.harnessFiles).toEqual(["guardrails.md", "tool-guidance.md"]);
  expect((await readCandidate(home, run.id))?.changes).toEqual({ "guardrails.md": "Run the tests.", "tool-guidance.md": "Type-check." });
});

test("overlayOf keeps only what differs from the built-in harness", () => {
  expect([...overlayOf(new Map([...BASE_TREE, ["guardrails.md", "g"]])).keys()]).toEqual(["guardrails.md"]);
});

test("a stopped lab starts no new probe and makes no candidate", async () => {
  const controller = new AbortController();
  const runner = new FakeRunner();
  const stopping: ProbeRunner = { run: async (input) => (controller.abort(), runner.run(input)) };
  const run = await runLab(task, options(stopping, [answer({ files: { "guardrails.md": "Run the tests." } }), nothing, answer({ files: { "guardrails.md": "Run the tests." } })], { signal: controller.signal }));
  expect(run.probes.map((p) => p.label)).toEqual(["ref"]);
  expect(run.verdict).toEqual({ outcome: "invalid", reasons: ["the lab was stopped before it finished"] });
  expect(run.candidate).toBeUndefined();
});
