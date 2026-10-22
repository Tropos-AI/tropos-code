// src/harness/service.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel, reply, textBlock } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { Ledger } from "../learning/ledger";
import { projectDir } from "../session/store";
import { BASE_TREE } from "./base";
import { readCandidate, saveCandidate } from "./candidates";
import type { ProbeInput, ProbeResult, ProbeRunner } from "./probe";
import { DEFAULT_SETTINGS } from "../config/settings";
import { confinementAvailable } from "../exec/confined";
import { adoptedTree, firstPrompt, labFromSettings, labOnTask, probeKey, replayTasks, taskFromFile, taskFromPrompt } from "./service";
import { globalHarnessDir } from "./tree";

let dir: string;
let home: string;
let repo: string;
beforeEach(async () => {
  dir = await makeTmpDir("service-");
  home = join(dir, "home");
  repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await writeFile(join(repo, "bun.lock"), "");
  await writeFile(join(repo, "tsconfig.json"), "{}");
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: repo });
});
afterEach(() => removeDir(dir));

test("a task from a prompt starts at the committed state, with the stack's setup and checks", async () => {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
  const t = await taskFromPrompt(repo, "Fix the date parser\nIt fails on leap years.");
  expect(t).toEqual({ id: "prompt", title: "Fix the date parser", prompt: "Fix the date parser\nIt fails on leap years.", repo, revision: head, domain: "ts-bun", setup: "bun install --frozen-lockfile", checks: ["bun test", "bun x tsc --noEmit"], split: "dev" });
  expect((await taskFromPrompt(repo, "x", { checks: ["make check"], setup: "true" })).checks).toEqual(["make check"]);
  await expect(taskFromPrompt(dir, "x")).rejects.toThrow("not in a git repository");
  await writeFile(join(dir, "task.json"), JSON.stringify({ prompt: "Do it", split: "holdout", checks: [] }));
  expect(await taskFromFile(join(dir, "task.json"), repo)).toMatchObject({ prompt: "Do it", split: "holdout", checks: [], repo });
});

test("firstPrompt drops the context block Tropos put in front", () => {
  expect(firstPrompt([{ role: "user", content: [{ type: "text", text: "<context>…</context>" }, { type: "text", text: "Add a flag" }] }])).toBe("Add a flag");
  expect(firstPrompt([{ role: "user", content: "plain" }])).toBe("plain");
  expect(firstPrompt([])).toBeNull();
});

test("replay picks the owner's real requests in this project, newest first", async () => {
  const sessions = projectDir(home, repo);
  await mkdir(sessions, { recursive: true });
  const write = (id: string, at: string, prompt: string, meta: Record<string, unknown> = {}) =>
    writeFile(
      join(sessions, `${id}.jsonl`),
      [JSON.stringify({ type: "meta", sessionId: id, cwd: repo, createdAt: at, ...meta }), JSON.stringify({ type: "message", ts: at, message: { role: "user", content: [{ type: "text", text: "<context>x</context>" }, { type: "text", text: prompt }] } })].join("\n"),
    );
  await write("11111111-1111-4111-8111-111111111111", "2026-10-01", "Make the importer skip blank lines in CSV files");
  await write("22222222-2222-4222-8222-222222222222", "2026-10-02", "Add retries to the HTTP client with backoff please");
  await write("33333333-3333-4333-8333-333333333333", "2026-10-03", "/review main");
  await write("44444444-4444-4444-8444-444444444444", "2026-10-04", "A guest asked for something long enough to count", { role: "guest" });
  const tasks = await replayTasks(home, repo, { recent: 5 });
  expect(tasks.map((t) => [t.id, t.title, t.split])).toEqual([
    ["session-22222222", "Add retries to the HTTP client with backoff please", "replay"],
    ["session-11111111", "Make the importer skip blank lines in CSV files", "replay"],
  ]);
  expect((await replayTasks(home, repo, { session: "11111111-1111-4111-8111-111111111111" })).length).toBe(1);
});

test("the probes' key comes from the provider's variable", async () => {
  expect(await probeKey(home, "claude-haiku-5-5", { ANTHROPIC_API_KEY: "k" })).toEqual({ name: "ANTHROPIC_API_KEY", value: "k" });
  expect(await probeKey(home, "claude-haiku-5-5", {})).toBeNull();
});

test("the global lab starts from the base with the adopted global layer", async () => {
  await mkdir(globalHarnessDir(home), { recursive: true });
  await writeFile(join(globalHarnessDir(home), "guardrails.md"), "G");
  expect((await adoptedTree(home, repo, "global")).get("guardrails.md")).toBe("G");
  expect((await adoptedTree(home, repo, "global")).get("system.md")).toBe(BASE_TREE.get("system.md"));
});

/** Passes "bun test" when the harness says "Run the tests." */
class FakeRunner implements ProbeRunner {
  async run(input: ProbeInput): Promise<ProbeResult> {
    const text = input.harnessFiles.map((f) => readFileSync(join(input.harnessDir, f), "utf8")).join("\n");
    const ok = /Run the tests/.test(text);
    await writeFile(join(input.dir, "trajectory.jsonl"), "");
    return {
      id: input.id, label: input.label, harness: input.harnessFiles, finalText: "", seconds: 1, error: null,
      checks: [{ command: "bun test", ok, exit: ok ? 0 : 1, timedOut: false, tail: "", seconds: 1 }],
      audit: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] },
      signals: { turns: 5, toolCalls: 5, toolErrors: 0, filesWritten: 1, verifiedAfterLastEdit: ok, rereadWritten: 0, endReason: "end_turn", costUsd: 0 },
    };
  }
}

test("labOnTask: lab, reflection, review suggestions marked as tested and never auto-adopted", async () => {
  await saveCandidate(home, {
    id: "20261020-000000-0000", createdAt: "", source: "review", scope: "global", domain: "ts-bun", task: { id: "s", title: "from a session" },
    changes: { "guardrails.md": "Run the tests." }, rationale: "the session forgot tests", status: "pending",
  });
  const nothing = () => reply([textBlock('{"files": {}}')]);
  const model = new FakeModel([
    nothing,
    nothing,
    () => reply([textBlock(JSON.stringify({ decisions: [{ decision: "take the suggestion", evidence: "sug-1 passed" }], files: { "guardrails.md": "Run the tests." } }))]),
    () => reply([textBlock(JSON.stringify({ lessons: [] }))]),
  ]);
  const task = await taskFromPrompt(repo, "Fix the date parser");
  const r = await labOnTask(task, {
    home, runner: new FakeRunner(), llm: { model, id: "m", effort: "high" }, model: "m", scope: "global", k: 1, mode: "parallel",
    autoAdopt: true, ledger: new Ledger(home), signal: new AbortController().signal,
  });
  expect(r.run.probes.map((p) => p.label)).toEqual(["ref", "sug-1", "comp-1"]);
  // Composed with a review's suggestion: it waits for the owner even with autoAdopt on.
  expect(r.adopted).toBeUndefined();
  expect(r.pending).toBe("it was composed with a session review's suggestion, which only the owner adopts");
  expect(r.reflection.stored).toBe(true); // the harness did better: an entry even without lessons
  expect((await readCandidate(home, "20261020-000000-0000"))?.status).toBe("discarded");
});

/** Same checks either way; only fewer turns when the harness says "Be brief." */
class TurnsRunner implements ProbeRunner {
  async run(input: ProbeInput): Promise<ProbeResult> {
    const brief = input.harnessFiles.some((f) => /Be brief/.test(readFileSync(join(input.harnessDir, f), "utf8")));
    await writeFile(join(input.dir, "trajectory.jsonl"), "");
    return {
      id: input.id, label: input.label, harness: input.harnessFiles, finalText: "", seconds: 1, error: null,
      checks: [{ command: "bun test", ok: true, exit: 0, timedOut: false, tail: "", seconds: 1 }],
      audit: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] },
      signals: { turns: brief ? 5 : 20, toolCalls: 5, toolErrors: 0, filesWritten: 1, verifiedAfterLastEdit: true, rereadWritten: 0, endReason: "end_turn", costUsd: 0 },
    };
  }
}

test("an improvement only in steps, from one run each, waits for the owner", async () => {
  const brief = () => reply([textBlock(JSON.stringify({ files: { "guardrails.md": "Be brief." } }))]);
  const model = new FakeModel([brief, () => reply([textBlock('{"files": {}}')]), brief, () => reply([textBlock('{"lessons": []}')])]);
  const r = await labOnTask(await taskFromPrompt(repo, "Tidy the README"), {
    home, runner: new TurnsRunner(), llm: { model, id: "m", effort: "high" }, model: "m", scope: "global", k: 1, mode: "parallel",
    autoAdopt: true, ledger: new Ledger(home), signal: new AbortController().signal,
  });
  expect(r.run.verdict).toEqual({ outcome: "better", reasons: ["turns 20 → 5"] });
  expect(r.adopted).toBeUndefined();
  expect(r.pending).toContain("only on steps or tool errors");
});

test("labFromSettings runs the lab with the owner's model and settings", async () => {
  if (!(await confinementAvailable())) return;
  const agent = join(dir, "agent.sh");
  await writeFile(agent, ["#!/bin/sh", `echo '${JSON.stringify({ type: "turn_end", reason: "end_turn" })}'`].join("\n"));
  const nothing = () => reply([textBlock('{"files": {}}')]);
  const router = new FakeModel([nothing, nothing, nothing, () => reply([textBlock('{"lessons": []}')])]);
  const settings = { ...DEFAULT_SETTINGS, model: "claude-haiku-5-5", harness: { ...DEFAULT_SETTINGS.harness, editorModel: "claude-opus-5-5" } };
  const r = await labFromSettings({ home, command: ["/bin/sh", agent], env: { ANTHROPIC_API_KEY: "k" }, settings, router }, await taskFromPrompt(repo, "Fix the date parser", { setup: "true", checks: ["true"] }), {
    k: 1, autoAdopt: true, signal: new AbortController().signal,
  });
  expect(r.run).toMatchObject({ model: "claude-haiku-5-5", editorModel: "claude-opus-5-5", scope: "global" });
  expect(r.run.verdict.reasons).toEqual(["no proposal changed the harness"]);
  expect(router.requests[0]?.model).toBe("claude-opus-5-5");
});

/** "Run the tests." passes the check, except in the second pair when `flaky` says so. */
class ConfirmRunner implements ProbeRunner {
  constructor(private readonly flaky: boolean) {}
  async run(input: ProbeInput): Promise<ProbeResult> {
    const rule = input.harnessFiles.some((f) => /Run the tests/.test(readFileSync(join(input.harnessDir, f), "utf8")));
    const ok = rule && !(this.flaky && input.label === "confirm-cand");
    await writeFile(join(input.dir, "trajectory.jsonl"), "");
    return {
      id: input.id, label: input.label, harness: input.harnessFiles, finalText: "", seconds: 1, error: null,
      checks: [{ command: "bun test", ok, exit: ok ? 0 : 1, timedOut: false, tail: "", seconds: 1 }],
      audit: { files: 1, insertions: 1, deletions: 0, testFilesTouched: [], testFilesEdited: [], focusMarkers: [] },
      signals: { turns: 5, toolCalls: 5, toolErrors: 0, filesWritten: 1, verifiedAfterLastEdit: ok, rereadWritten: 0, endReason: "end_turn", costUsd: 0 },
    };
  }
}

describe("adopting on its own needs the improvement twice", () => {
  const steps = () => {
    const rule = () => reply([textBlock(JSON.stringify({ files: { "guardrails.md": "Run the tests." } }))]);
    return new FakeModel([rule, () => reply([textBlock('{"files": {}}')]), rule, () => reply([textBlock('{"lessons": []}')])]);
  };
  const run = async (flaky: boolean, over: Record<string, unknown> = {}) =>
    labOnTask(await taskFromPrompt(repo, "Fix the date parser"), {
      home, runner: new ConfirmRunner(flaky), llm: { model: steps(), id: "m", effort: "high" }, model: "m", scope: "global", k: 1, mode: "parallel",
      autoAdopt: true, ledger: new Ledger(home), signal: new AbortController().signal, ...over,
    });

  test("repeated: adopted, with the second pair on record", async () => {
    const r = await run(false);
    expect(r.adopted?.status).toBe("adopted");
    expect(r.run.confirmation?.outcome).toBe("better");
    expect(r.run.probes.map((p) => p.label)).toContain("confirm-cand");
  });

  test("not repeated: it waits for the owner", async () => {
    const r = await run(true);
    expect(r.adopted).toBeUndefined();
    expect(r.pending).toStartWith("the improvement didn't repeat in a second pair of runs (same");
  });

  test("startFrom runs the lab from the given harness, not the adopted one", async () => {
    await mkdir(globalHarnessDir(home), { recursive: true });
    await writeFile(join(globalHarnessDir(home), "guardrails.md"), "Run the tests.");
    const adopted = await run(false, { autoAdopt: false });
    expect(adopted.run.verdict.outcome).not.toBe("better"); // the adopted layer already passes
    const fromBase = await run(false, { autoAdopt: false, startFrom: BASE_TREE });
    expect(fromBase.run.verdict.outcome).toBe("better");
  });
});
