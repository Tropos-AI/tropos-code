// eval/lib/harbor.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { fromHarborTrial, readHarborJob, type HarborTrial } from "./harbor";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("eval-harbor-");
});
afterEach(() => removeDir(dir));

const trial = (over: Partial<HarborTrial> = {}): HarborTrial => ({
  task_name: "fix-git",
  agent_info: { name: "tropos", version: "0.1.0", model_info: { name: "claude-opus-5-5" } },
  agent_result: { n_input_tokens: 1000, n_output_tokens: 200, cost_usd: 0.31 },
  verifier_result: { rewards: { reward: 1 } },
  exception_info: null,
  started_at: "2026-10-13T10:00:00Z",
  agent_execution: { started_at: "2026-10-13T10:00:10Z", finished_at: "2026-10-13T10:02:10Z" },
  ...over,
});

const opts = { runId: "r", agent: "tropos", effort: "high", attempt: 1 };

test("a solved trial", () => {
  expect(fromHarborTrial(trial(), opts)).toMatchObject({
    task: "fix-git", split: "terminal-bench", agent: "tropos", agentVersion: "0.1.0", model: "claude-opus-5-5",
    pass: true, costUsd: 0.31, inputTokens: 1000, outputTokens: 200, agentSeconds: 120, timedOut: false, harnessError: null,
  });
});

test("reward 0, a timeout, and a harness exception", () => {
  expect(fromHarborTrial(trial({ verifier_result: { rewards: { reward: 0 } } }), opts).pass).toBe(false);
  const timeout = fromHarborTrial(trial({ verifier_result: null, exception_info: { exception_type: "AgentTimeoutError", exception_message: "x" } }), opts);
  expect(timeout).toMatchObject({ pass: false, timedOut: true, harnessError: null });
  const broken = fromHarborTrial(trial({ verifier_result: null, agent_result: null, exception_info: { exception_type: "RuntimeError", exception_message: "setup failed" } }), opts);
  expect(broken).toMatchObject({ pass: false, timedOut: false, harnessError: "RuntimeError: setup failed", costUsd: null });
  for (const type of ["NonZeroAgentExitCodeError", "ApiRateLimitError", "ContextWindowExceededError"]) {
    const failed = fromHarborTrial(trial({ verifier_result: { rewards: { reward: 0 } }, exception_info: { exception_type: type, exception_message: "exit 1" } }), opts);
    expect(failed).toMatchObject({ pass: false, harnessError: null });
  }
});

test("readHarborJob reads every trial folder and numbers repeat attempts", async () => {
  const write = async (name: string, t: HarborTrial) => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "result.json"), JSON.stringify(t));
  };
  await write("fix-git__aaaaaaa", trial({ started_at: "2026-10-13T11:00:00Z" }));
  await write("fix-git__bbbbbbb", trial({ started_at: "2026-10-13T10:00:00Z", verifier_result: { rewards: { reward: 0 } } }));
  await write("chess__ccccccc", trial({ task_name: "chess" }));
  await mkdir(join(dir, "not-a-trial"));
  await writeFile(join(dir, "result.json"), "{}");
  const results = await readHarborJob(dir, { runId: "r", agent: "tropos", effort: null });
  expect(results.map((r) => `${r.task}#${r.attempt}:${r.pass}`)).toEqual(["chess#1:true", "fix-git#1:false", "fix-git#2:true"]);
});
